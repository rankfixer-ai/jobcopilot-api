// sync.js — Job Copilot Multi-Source Aggregator
// Sources: OnlineJobs.ph + Kalibrr
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { enhanceJobs, detectCategory, getBadges, formatSalary } = require('./utils/jobEnhancer');

const { createClient } = require('@supabase/supabase-js');
const { execSync } = require('child_process');
const crypto = require('crypto');

// ============================================
// CONFIG
// ============================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ============================================
// SYNC QUERIES
// ============================================
const ONLINEJOBS_QUERIES = [
  { keyword: 'BPO', pages: 3 },
  { keyword: 'Customer Service', pages: 3 },
  { keyword: 'Remote', pages: 3 },
  { keyword: 'Virtual Assistant', pages: 3 },
  { keyword: 'IT', pages: 2 },
  { keyword: 'Sales', pages: 2 },
  { keyword: 'Data Entry', pages: 2 },
  { keyword: 'No Experience', pages: 2 },
  { keyword: 'Fresh Graduate', pages: 2 },
  { keyword: 'Call Center', pages: 2 },
];

const KALIBRR_QUERIES = [
  { keyword: 'customer-service', pages: 3 },
  { keyword: 'bpo', pages: 3 },
  { keyword: 'call-center', pages: 3 },
  { keyword: 'it', pages: 2 },
  { keyword: 'accounting', pages: 2 },
  { keyword: 'sales', pages: 2 },
  { keyword: 'marketing', pages: 2 },
  { keyword: 'hr', pages: 2 },
];

// ============================================
// CATEGORY MAPPING
// ============================================
const CATEGORY_MAPPING = {
  'bpo': 'BPO',
  'customer service': 'Customer Support',
  'call center': 'Customer Support',
  'csr': 'Customer Support',
  'virtual assistant': 'Virtual Assistant',
  'va': 'Virtual Assistant',
  'remote': 'Remote / WFH',
  'work from home': 'Remote / WFH',
  'wfh': 'Remote / WFH',
  'home based': 'Remote / WFH',
  'it': 'IT & Software',
  'software': 'IT & Software',
  'developer': 'IT & Software',
  'programmer': 'IT & Software',
  'sales': 'Sales',
  'data entry': 'Admin & Office',
  'encoder': 'Admin & Office',
  'accounting': 'Accounting & Finance',
  'accountant': 'Accounting & Finance',
  'bookkeeper': 'Accounting & Finance',
  'hr': 'HR',
  'human resources': 'HR',
  'marketing': 'Marketing',
  'fresh graduate': 'Fresh Graduate',
  'no experience': 'No Experience',
};

// Cache for category IDs
let categoryCache = {};
let sourceCache = {};

// ============================================
// HELPERS
// ============================================
function generateJobHash(job) {
  const str = `${job.source_job_id || ''}-${job.title || ''}-${job.job_url || ''}`;
  return crypto.createHash('sha256').update(str).digest('hex');
}

function detectRemoteType(title, description, tags) {
  const text = `${title || ''} ${description || ''} ${tags || ''}`.toLowerCase();
  if (/work\s*(from|at)\s*home|wfh|remote|home\s*based|telecommute/.test(text)) return 'remote';
  if (/hybrid/.test(text)) return 'hybrid';
  return 'onsite';
}

function normalizeSalary(job) {
  let min = job.salary_min || null;
  let max = job.salary_max || null;
  if (min && max && min > max) [min, max] = [max, min];
  return { min, max, currency: job.salary_currency || 'PHP' };
}

function guessCategory(title, description, tags) {
  const text = `${title || ''} ${description || ''} ${tags || ''}`.toLowerCase();
  for (const [keyword, category] of Object.entries(CATEGORY_MAPPING)) {
    if (text.includes(keyword)) return category;
  }
  return null;
}

function extractCity(title, description, tags) {
  const text = `${title || ''} ${description || ''} ${tags || ''}`.toLowerCase();
  const cities = ['Manila', 'Makati', 'Taguig', 'Pasig', 'Quezon City', 'Davao', 'Cebu',
    'Mandaue', 'Cagayan de Oro', 'Iloilo', 'Bacolod', 'Zamboanga', 'Angeles', 'Baguio',
    'Pampanga', 'Laguna', 'Cavite', 'Batangas', 'Rizal', 'Clark'];
  for (const city of cities) {
    if (text.includes(city.toLowerCase())) return city;
  }
  if (/remote|home\s*based|wfh|work\s*from\s*home/.test(text)) return 'Remote';
  return 'Philippines';
}

// ============================================
// LOAD CACHES
// ============================================
async function loadCaches() {
  const { data: categories } = await supabase.from('categories').select('id, name');
  if (categories) {
    for (const cat of categories) {
      categoryCache[cat.name.toLowerCase()] = cat.id;
    }
  }
  
  const { data: sources } = await supabase.from('sources').select('id, name');
  if (sources) {
    for (const src of sources) {
      sourceCache[src.name.toLowerCase()] = src.id;
    }
  }
  
  console.log(`📋 Loaded ${Object.keys(categoryCache).length} categories, ${Object.keys(sourceCache).length} sources`);
}

// ============================================
// FETCH FROM ONLINEJOBS.PH
// ============================================
async function fetchFromOnlineJobs(keyword, pages = 1) {
  try {
    console.log(`  🐍 OnlineJobs: "${keyword}"...`);
    const pythonScript = `
import sys, json
sys.path.insert(0, r'${__dirname}/scrapers')
from onlinejobs_scraper import scrape_jobs
jobs = scrape_jobs(keyword="${keyword}", max_pages=${pages}, headless=True)
print("ONLINEJOBS_RESULT:" + json.dumps(jobs))
`;
    const tempScript = path.join(__dirname, `_temp_oj_${Date.now()}.py`);
    require('fs').writeFileSync(tempScript, pythonScript);
    
    const result = execSync(`python "${tempScript}"`, {
      encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, timeout: 300000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    
    try { require('fs').unlinkSync(tempScript); } catch (e) {}
    
    const match = result.match(/ONLINEJOBS_RESULT:(.*)/s);
    if (match) {
      const jobs = JSON.parse(match[1]);
      console.log(`  ✅ ${jobs.length} jobs`);
      return jobs;
    }
    return [];
  } catch (e) {
    console.log(`  ❌ Error: ${e.message}`);
    return [];
  }
}

// ============================================
// FETCH FROM KALIBRR
// ============================================
async function fetchFromKalibrr(keyword, pages = 3) {
  try {
    console.log(`  🐍 Kalibrr: "${keyword}"...`);
    const result = execSync(`python "${__dirname}/scrapers/kalibrr_scraper.py" "${keyword}" ${pages}`, {
      encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, timeout: 300000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    
    const match = result.match(/KALIBRR_RESULT:(.*)/s);
    if (match) {
      const jobs = JSON.parse(match[1]);
      console.log(`  ✅ ${jobs.length} jobs`);
      return jobs;
    }
    console.log(`  ⚠️ No results`);
    return [];
  } catch (e) {
    console.log(`  ❌ Error: ${e.message}`);
    return [];
  }
}

// ============================================
// PROCESS JOB
// ============================================
async function processJob(job, sourceId) {
  try {
    const salary = normalizeSalary(job);
    const remoteType = detectRemoteType(job.title, job.description, job.tags);
    const categoryName = detectCategory(job.title, job.description);
    const city = extractCity(job.title, job.description, job.tags);
    const hashKey = generateJobHash(job);
    const salaryFormatted = formatSalary(salary.min, salary.max);
    const badges = getBadges({ ...job, ...salary, remote_type: remoteType });
    
    const categoryId = categoryName ? categoryCache[categoryName.toLowerCase()] || null : null;
    
    const cleanJob = {
      source_id: sourceId,
      source_job_id: job.source_job_id || String(Date.now()),
      category_id: categoryId,
      title: job.title || 'Untitled',
      company: job.company || 'Unknown',
      location: job.city || job.location || 'Philippines',
      city: city,
      country: 'Philippines',
      salary_min: salary.min,
      salary_max: salary.max,
      salary_currency: salary.currency,
      salary_visible: salary.visible,
      remote_type: remoteType,
      employment_type: job.employment_type || null,
      description: job.description || '',
      snippet: (job.description || '').substring(0, 200),
      job_url: job.job_url || '',
      apply_url: job.job_url || '',
      posted_at: job.posted_at || new Date().toISOString(),
      hash_key: hashKey,
      is_active: true,
    };
    
    const { error } = await supabase
      .from('jobs_clean')
      .upsert(cleanJob, { onConflict: 'source_id, source_job_id' });
    
    if (error) {
      console.log(`  ⚠️ DB error: ${error.message}`);
      return 'error';
    }
    return 'inserted';
  } catch (error) {
    console.log(`  ⚠️ Process error: ${error.message}`);
    return 'error';
  }
}
// ============================================
// GET OR CREATE SOURCE
// ============================================
async function getOrCreateSource(name, url) {
  let { data: source } = await supabase
    .from('sources')
    .select('id')
    .eq('name', name)
    .maybeSingle();
  
  if (!source) {
    const { data: newSource } = await supabase
      .from('sources')
      .insert({ name, base_url: url, api_endpoint: url, rate_limit_per_hour: 50, is_active: true })
      .select('id')
      .single();
    source = newSource;
    console.log(`📝 Created source: ${name} (${source.id})`);
  }
  
  sourceCache[name.toLowerCase()] = source.id;
  return source.id;
}

// ============================================
// MAIN SYNC
// ============================================
async function runSync() {
  const startTime = Date.now();
  console.log(`🚀 Job Copilot Sync — ${new Date().toISOString()}\n`);
  
  await loadCaches();
  
  // Ensure sources exist
  const onlineJobsId = await getOrCreateSource('OnlineJobs.ph', 'https://www.onlinejobs.ph');
  const kalibrrId = await getOrCreateSource('Kalibrr', 'https://www.kalibrr.com');
  
  // Create sync log
  const { data: syncLog } = await supabase.from('sync_logs').insert({
    source_id: onlineJobsId,
    started_at: new Date().toISOString(),
    status: 'running',
  }).select('id').single();
  
  let totalFetched = 0, totalInserted = 0, totalErrors = 0;
  
  // ============================================
  // ONLINEJOBS.PH
  // ============================================
  console.log('\n📦 SOURCE: OnlineJobs.ph');
  for (const query of ONLINEJOBS_QUERIES) {
    console.log(`\n🔍 "${query.keyword}" (${query.pages} pages)`);
    const jobs = await fetchFromOnlineJobs(query.keyword, query.pages);
    totalFetched += jobs.length;
    
    for (let j = 0; j < jobs.length; j++) {
      jobs[j].source_name = 'OnlineJobs.ph';
      const result = await processJob(jobs[j], onlineJobsId);
      if (result === 'inserted') totalInserted++;
      else totalErrors++;
      if ((j + 1) % 30 === 0) console.log(`  📊 ${j + 1}/${jobs.length}`);
    }
    console.log(`  ✅ ${jobs.length} jobs`);
  }
  
  // ============================================
  // KALIBRR
  // ============================================
  console.log('\n📦 SOURCE: Kalibrr');
  for (const query of KALIBRR_QUERIES) {
    console.log(`\n🔍 "${query.keyword}" (${query.pages} pages)`);
    const jobs = await fetchFromKalibrr(query.keyword, query.pages);
    totalFetched += jobs.length;
    
    for (let j = 0; j < jobs.length; j++) {
      const result = await processJob(jobs[j], kalibrrId);
      if (result === 'inserted') totalInserted++;
      else totalErrors++;
      if ((j + 1) % 30 === 0) console.log(`  📊 ${j + 1}/${jobs.length}`);
    }
    console.log(`  ✅ ${jobs.length} jobs`);
  }
  
  // Expire old jobs
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  await supabase.from('jobs_clean').update({ is_active: false })
    .lt('updated_at', sevenDaysAgo.toISOString()).eq('is_active', true);
  
  // Update sync log
  const endedAt = new Date().toISOString();
  await supabase.from('sync_logs').update({
    ended_at, jobs_fetched: totalFetched, jobs_new: totalInserted, jobs_updated: 0,
    errors: totalErrors, status: 'success',
  }).eq('id', syncLog.id);
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  const { count } = await supabase.from('jobs_clean')
    .select('*', { count: 'exact', head: true }).eq('is_active', true);
  
  console.log('\n========================================');
  console.log('✅ SYNC COMPLETE');
  console.log(`   Fetched:  ${totalFetched}`);
  console.log(`   Inserted: ${totalInserted}`);
  console.log(`   Errors:   ${totalErrors}`);
  console.log(`   Duration: ${duration}s`);
  console.log(`   Active:   ${count} jobs`);
  console.log('========================================\n');
}

runSync().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });