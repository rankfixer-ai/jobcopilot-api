// ==========================================================
// sync.js v3 — Job Copilot Production Aggregator
// Battle-Tested: chunk upserts, retries, concurrency, metrics
// ==========================================================

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const fs = require("fs");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { createClient } = require("@supabase/supabase-js");
const { enhanceJob } = require("./utils/jobEnhancer");

// ==========================================================
// CONFIG
// ==========================================================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TEMP_DIR = path.join(__dirname, "scrapers", "temp");
const DAYS_TO_EXPIRE = 7;
const UPSERT_CHUNK = 200;
const MAX_RETRIES = 3;
const CONCURRENCY = 2; // parallel sources

// ==========================================================
// QUERIES
// ==========================================================

const ONLINEJOBS_QUERIES = [
  ["Virtual Assistant", 3], ["Remote", 3], ["Customer Service", 3],
  ["Data Entry", 2], ["Social Media", 2], ["Video Editor", 2],
  ["Bookkeeper", 2], ["Sales", 2],
];

const KALIBRR_QUERIES = [
  ["customer-service", 3], ["bpo", 3], ["call-center", 3],
  ["it", 2], ["accounting", 2], ["marketing", 2],
];

// ==========================================================
// STATE
// ==========================================================

let categoryCache = {};
let sourceCache = {};
let metrics = { fetched: 0, deduped: 0, saved: 0, errors: 0, sources: {} };

// ==========================================================
// HELPERS
// ==========================================================

function log(msg = "") {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function hashJob(job) {
  return crypto.createHash("sha256").update(`${job.title}|${job.company}|${job.job_url}`).digest("hex");
}

function cleanCompany(name = "") {
  name = String(name).replace(/\s+/g, " ").trim();
  return (!name || name.toLowerCase() === "unknown" || name.length < 2) ? "Unknown" : name;
}

async function retry(fn, retries = MAX_RETRIES, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) { if (i === retries - 1) throw e; log(`Retry ${i + 1}/${retries}: ${e.message}`); await sleep(delay * (i + 1)); }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ==========================================================
// CACHES
// ==========================================================

async function loadCaches() {
  const { data: cats } = await supabase.from("categories").select("id,name");
  const { data: srcs } = await supabase.from("sources").select("id,name");
  categoryCache = {}; sourceCache = {};
  cats?.forEach(x => { categoryCache[x.name.toLowerCase()] = x.id; });
  srcs?.forEach(x => { sourceCache[x.name.toLowerCase()] = x.id; });
  log(`Loaded ${cats?.length || 0} categories / ${srcs?.length || 0} sources`);
}

async function getSourceId(name, url) {
  const key = name.toLowerCase();
  if (sourceCache[key]) return sourceCache[key];
  const { data: found } = await supabase.from("sources").select("id").eq("name", name).maybeSingle();
  if (found?.id) { sourceCache[key] = found.id; return found.id; }
  const { data } = await supabase.from("sources").insert({ name, base_url: url, api_endpoint: url, is_active: true }).select("id").single();
  sourceCache[key] = data.id;
  return data.id;
}

// ==========================================================
// SOURCE CLEANERS
// ==========================================================

function cleanOnlineJobs(job = {}) {
  return {
    ...job, source_name: "OnlineJobs.ph",
    title: String(job.title || "").replace(/\s+/g, " ").trim(),
    company: cleanCompany(job.company) === "Unknown" ? "OnlineJobs Employer" : cleanCompany(job.company),
  };
}

function cleanKalibrr(job = {}) {
  return {
    ...job, source_name: "Kalibrr",
    title: String(job.title || "").replace(/\s+/g, " ").trim(),
    company: cleanCompany(job.company),
  };
}

// ==========================================================
// FETCHERS
// ==========================================================

async function fetchOnlineJobs(keyword, pages) {
  try {
    ensureTempDir();
    const tempFile = path.join(TEMP_DIR, `_oj_${Date.now()}.py`);
    const py = `import json, sys\nsys.path.insert(0, r"${path.join(__dirname, "scrapers")}")\nfrom onlinejobs_scraper import scrape_jobs\njobs = scrape_jobs(keyword="${keyword}", max_pages=${pages}, headless=True)\nprint("ONLINEJOBS_RESULT:" + json.dumps(jobs, ensure_ascii=False))`;
    fs.writeFileSync(tempFile, py);

    const result = execSync(`python "${tempFile}"`, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 300000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    try { fs.unlinkSync(tempFile); } catch {}

    const match = result.match(/ONLINEJOBS_RESULT:(.*)/s);
    return match ? JSON.parse(match[1]).map(cleanOnlineJobs) : [];
  } catch (e) { log(`OnlineJobs error: ${e.message}`); return []; }
}

async function fetchKalibrr(keyword, pages) {
  try {
    const script = path.join(__dirname, "scrapers", "kalibrr_scraper.py");
    const result = execSync(`python "${script}" "${keyword}" ${pages}`, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, timeout: 300000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    const match = result.match(/KALIBRR_RESULT:(.*)/s);
    return match ? JSON.parse(match[1]).map(cleanKalibrr) : [];
  } catch (e) { log(`Kalibrr error: ${e.message}`); return []; }
}

// ==========================================================
// CONCURRENT FETCH
// ==========================================================

async function fetchAllFromSource(sourceName, queries, fetcher) {
  const results = [];
  for (let i = 0; i < queries.length; i += CONCURRENCY) {
    const batch = queries.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(([kw, pages]) => fetcher(kw, pages)));
    batchResults.forEach((rows, idx) => {
      results.push(...rows);
      log(`${sourceName} ${batch[idx][0]}: ${rows.length} jobs`);
    });
    if (i + CONCURRENCY < queries.length) await sleep(1000);
  }
  return results;
}

// ==========================================================
// DEDUPE
// ==========================================================

function dedupeJobs(rows = []) {
  const map = new Map();
  for (const job of rows) {
    const key = `${(job.title || "").toLowerCase()}|${(job.company || "").toLowerCase()}`;
    if (!map.has(key)) { map.set(key, job); continue; }
    const existing = map.get(key);
    const oldScore = (existing.description?.length || 0) + (existing.salary_max || 0);
    const newScore = (job.description?.length || 0) + (job.salary_max || 0);
    if (newScore > oldScore) map.set(key, job);
  }
  return [...map.values()];
}

// ==========================================================
// PROCESS JOB
// ==========================================================

function processJob(raw = {}, sourceId) {
  const enhanced = enhanceJob(raw);
  const categoryId = categoryCache[(enhanced.category || "").toLowerCase()] || null;
  return {
    source_id: sourceId,
    source_job_id: raw.external_id || raw.source_job_id || hashJob(raw),
    category_id: categoryId,
    title: enhanced.title || "Untitled",
    company: cleanCompany(enhanced.company),
    location: enhanced.location || "Philippines",
    city: enhanced.city || "Philippines",
    country: enhanced.country || "Philippines",
    salary_min: enhanced.salary_min,
    salary_max: enhanced.salary_max,
    salary_currency: enhanced.salary_currency || "PHP",
    salary_visible: enhanced.salary_visible,
    remote_type: enhanced.remote_type || "onsite",
    employment_type: enhanced.employment_type || null,
    snippet: (enhanced.snippet || enhanced.description || "").slice(0, 240),
    description: enhanced.description || "",
    job_url: enhanced.job_url || "",
    apply_url: enhanced.job_url || "",
    posted_at: enhanced.posted_at || new Date().toISOString(),
    hash_key: hashJob(enhanced),
    is_active: true,
    updated_at: new Date().toISOString(),
  };
}

// ==========================================================
// CHUNKED UPSERT WITH RETRY
// ==========================================================

async function upsertJobs(rows = []) {
  if (!rows.length) return 0;
  let saved = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const batch = rows.slice(i, i + UPSERT_CHUNK);
    await retry(async () => {
      const { error } = await supabase.from("jobs_clean").upsert(batch, { onConflict: "source_id,source_job_id" });
      if (error) throw error;
      saved += batch.length;
    });
    if (i + UPSERT_CHUNK < rows.length) log(`Upsert progress: ${Math.min(i + UPSERT_CHUNK, rows.length)}/${rows.length}`);
  }
  return saved;
}

// ==========================================================
// EXPIRE OLD JOBS
// ==========================================================

async function expireOldJobs() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS_TO_EXPIRE);
  const { error } = await supabase.from("jobs_clean").update({ is_active: false }).lt("updated_at", cutoff.toISOString()).eq("is_active", true);
  if (error) log(`Expire warning: ${error.message}`);
}

// ==========================================================
// MAIN RUNNER
// ==========================================================

async function runSync() {
  const started = Date.now();
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║  🚀 Job Copilot Sync v3             ║");
  console.log("╚══════════════════════════════════════╝\n");
  log("Starting sync...");

  try {
    await loadCaches();
    const onlineJobsId = await getSourceId("OnlineJobs.ph", "https://www.onlinejobs.ph");
    const kalibrrId = await getSourceId("Kalibrr", "https://www.kalibrr.com");
    metrics.sources["OnlineJobs.ph"] = 0;
    metrics.sources["Kalibrr"] = 0;

    // Fetch concurrently per source
    log("\n📦 FETCHING SOURCES\n");
    
    log("▶ OnlineJobs.ph");
    const ojJobs = await fetchAllFromSource("OnlineJobs.ph", ONLINEJOBS_QUERIES, fetchOnlineJobs);
    metrics.sources["OnlineJobs.ph"] = ojJobs.length;
    
    log("\n▶ Kalibrr");
    const kalJobs = await fetchAllFromSource("Kalibrr", KALIBRR_QUERIES, fetchKalibrr);
    metrics.sources["Kalibrr"] = kalJobs.length;

    // Combine + process
    let all = [...ojJobs.map(j => processJob(j, onlineJobsId)), ...kalJobs.map(j => processJob(j, kalibrrId))];
    metrics.fetched = all.length;
    log(`\n📊 Raw jobs: ${all.length} (OnlineJobs: ${ojJobs.length} | Kalibrr: ${kalJobs.length})`);

    // Dedupe
    all = dedupeJobs(all);
    metrics.deduped = all.length;
    log(`✨ After dedupe: ${all.length}`);

    // Upsert
    log("\n💾 Upserting...");
    metrics.saved = await upsertJobs(all);

    // Expire
    await expireOldJobs();
    log("🧹 Expired old jobs");

    // Final count
    const { count } = await supabase.from("jobs_clean").select("*", { count: "exact", head: true }).eq("is_active", true);
    const sec = ((Date.now() - started) / 1000).toFixed(1);

    console.log("\n╔══════════════════════════════════════╗");
    console.log("║  ✅ SYNC COMPLETE                    ║");
    console.log(`║  Fetched:   ${String(metrics.fetched).padStart(6)}                  ║`);
    console.log(`║  Deduped:   ${String(metrics.deduped).padStart(6)}                  ║`);
    console.log(`║  Saved:     ${String(metrics.saved).padStart(6)}                  ║`);
    console.log(`║  Active:    ${String(count || 0).padStart(6)}                  ║`);
    console.log(`║  Duration:  ${String(sec + "s").padStart(6)}                  ║`);
    console.log("╚══════════════════════════════════════╝\n");
  } catch (e) {
    log(`🔥 Sync failed: ${e.message}`);
    console.error(e);
  }
}

runSync().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });