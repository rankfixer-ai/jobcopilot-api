// ==========================================================
// server.js v4 — Job Copilot Production API
// Added: Auth, Profiles, Saved Jobs, Application Tracker
// ==========================================================

if (process.env.NODE_ENV !== "production") {
  const path = require("path");
  require("dotenv").config({ path: path.join(__dirname, ".env") });
}

const express   = require("express");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const { enhanceJobs, enhanceJob } = require("./utils/jobEnhancer");
const { requireAuth } = require("./middleware/auth");

// ==========================================================
// APP + SUPABASE
// ==========================================================

const app  = express();
const PORT = process.env.PORT || 3000;

// Service-role client (admin, bypasses RLS) — backend only
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Auth client (respects RLS) — used for user auth operations
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY   // add SUPABASE_ANON_KEY to your .env
);

// ==========================================================
// MIDDLEWARE
// ==========================================================

const allowedOrigins = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(",").map((o) => o.trim())
  : "*";

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

// Rate limiting
app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Slow down." },
}));

// Tighter limit on auth routes
app.use("/api/auth/", rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20,
  message: { success: false, error: "Too many auth attempts. Try again later." },
}));

// ==========================================================
// LOGGER
// ==========================================================

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// ==========================================================
// SEARCH HELPERS (unchanged)
// ==========================================================

const SYNONYMS = {
  csr: ["customer service", "call center", "customer support", "chat support", "bpo"],
  "customer service": ["csr", "call center", "customer support", "chat support", "bpo"],
  va: ["virtual assistant", "admin assistant"],
  remote: ["wfh", "work from home", "home based"],
  "social media": ["smm", "facebook ads", "marketing"],
};

function expandTerms(keyword = "") {
  const kw   = keyword.toLowerCase().trim();
  const list = SYNONYMS[kw] || [];
  return [...new Set([kw, ...list])].slice(0, 6);
}

function scoreJob(job, keyword) {
  if (!keyword) return 0;
  const terms   = expandTerms(keyword);
  const title   = (job.title || "").toLowerCase();
  const company = (job.company || "").toLowerCase();
  const desc    = (job.description || job.snippet || "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title === term)            score += 1000;
    else if (title.startsWith(term)) score += 800;
    else if (title.includes(term)) score += 600;
    if (company.includes(term))    score += 120;
    if (desc.includes(term))       score += 80;
  }
  if (job.salary_max) score += Math.min(job.salary_max / 10000, 50);
  if (job.remote_type === "remote") score += 60;
  const age = (Date.now() - new Date(job.posted_at).getTime()) / 86400000;
  if (age <= 1) score += 100;
  else if (age <= 3) score += 60;
  else if (age <= 7) score += 30;
  return score;
}

const JOB_SELECT = `
  id, title, company, location, city,
  salary_min, salary_max, salary_currency, salary_visible,
  remote_type, employment_type, snippet, description,
  job_url, posted_at, created_at, is_active,
  source:sources(name)
`;

// ==========================================================
// HEALTH
// ==========================================================

app.get("/api/health", async (req, res) => {
  try {
    const { count, error } = await supabase
      .from("jobs_clean")
      .select("*", { count: "exact", head: true })
      .eq("is_active", true);
    if (error) throw error;
    res.json({ success: true, status: "ok", activeJobs: count || 0, time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// AUTH — REGISTER
// ==========================================================

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: "Email and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
    }

    // Create Supabase auth user
    const { data, error } = await supabaseAuth.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: { data: { full_name: full_name || "" } },
    });

    if (error) throw error;

    // Upsert profile row
    if (data.user) {
      await supabase.from("profiles").upsert({
        id:        data.user.id,
        email:     data.user.email,
        full_name: full_name || "",
      });
    }

    res.status(201).json({
      success: true,
      message: "Account created. Check your email to confirm.",
      user: { id: data.user?.id, email: data.user?.email },
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ==========================================================
// AUTH — LOGIN
// ==========================================================

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: "Email and password are required" });
    }

    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (error) throw error;

    res.json({
      success:      true,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at:   data.session.expires_at,
      user: {
        id:    data.user.id,
        email: data.user.email,
        name:  data.user.user_metadata?.full_name || "",
      },
    });
  } catch (e) {
    res.status(401).json({ success: false, error: "Invalid email or password" });
  }
});

// ==========================================================
// AUTH — REFRESH TOKEN
// ==========================================================

app.post("/api/auth/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ success: false, error: "refresh_token required" });
    }

    const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token });
    if (error) throw error;

    res.json({
      success:      true,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at:   data.session.expires_at,
    });
  } catch (e) {
    res.status(401).json({ success: false, error: e.message });
  }
});

// ==========================================================
// AUTH — LOGOUT
// ==========================================================

app.post("/api/auth/logout", requireAuth, async (req, res) => {
  // JWT is stateless — client should discard tokens.
  // Optionally revoke via Supabase admin if needed.
  res.json({ success: true, message: "Logged out" });
});

// ==========================================================
// PROFILE — GET
// ==========================================================

app.get("/api/profile", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", req.user.id)
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (e) {
    res.status(404).json({ success: false, error: "Profile not found" });
  }
});

// ==========================================================
// PROFILE — UPDATE
// ==========================================================

app.put("/api/profile", requireAuth, async (req, res) => {
  try {
    const allowed = ["full_name", "phone", "location", "bio", "job_title", "resume_url"];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: "No valid fields to update" });
    }

    const { data, error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// SAVED JOBS — LIST
// ==========================================================

app.get("/api/saved", requireAuth, async (req, res) => {
  try {
    const { data: saved, error } = await supabase
      .from("saved_jobs")
      .select("job_id, saved_at")
      .eq("user_id", req.user.id)
      .order("saved_at", { ascending: false });

    if (error) throw error;
    if (!saved.length) return res.json({ success: true, data: [] });

    // Fetch actual job data
    const jobIds = saved.map((s) => s.job_id);
    const { data: jobs, error: jobErr } = await supabase
      .from("jobs_clean")
      .select(JOB_SELECT)
      .in("id", jobIds)
      .eq("is_active", true);

    if (jobErr) throw jobErr;

    // Preserve saved order + attach saved_at
    const jobMap = Object.fromEntries((jobs || []).map((j) => [j.id, j]));
    const result = saved
      .filter((s) => jobMap[s.job_id])
      .map((s) => ({ ...enhanceJob(jobMap[s.job_id]), saved_at: s.saved_at }));

    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// SAVED JOBS — SAVE
// ==========================================================

app.post("/api/saved/:jobId", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("saved_jobs")
      .upsert({ user_id: req.user.id, job_id: req.params.jobId }, { onConflict: "user_id,job_id" });

    if (error) throw error;

    res.json({ success: true, message: "Job saved" });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// SAVED JOBS — UNSAVE
// ==========================================================

app.delete("/api/saved/:jobId", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("saved_jobs")
      .delete()
      .eq("user_id", req.user.id)
      .eq("job_id", req.params.jobId);

    if (error) throw error;

    res.json({ success: true, message: "Job removed from saved" });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// APPLICATIONS — LIST
// ==========================================================

app.get("/api/applications", requireAuth, async (req, res) => {
  try {
    const { status } = req.query;

    let query = supabase
      .from("applications")
      .select("*")
      .eq("user_id", req.user.id)
      .order("applied_at", { ascending: false });

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw error;

    // Fetch job details for each application
    const jobIds = [...new Set((data || []).map((a) => a.job_id))];
    let jobMap   = {};

    if (jobIds.length) {
      const { data: jobs } = await supabase
        .from("jobs_clean")
        .select(JOB_SELECT)
        .in("id", jobIds);

      jobMap = Object.fromEntries((jobs || []).map((j) => [j.id, j]));
    }

    const result = (data || []).map((app) => ({
      ...app,
      job: jobMap[app.job_id] ? enhanceJob(jobMap[app.job_id]) : null,
    }));

    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// APPLICATIONS — ADD
// ==========================================================

app.post("/api/applications", requireAuth, async (req, res) => {
  try {
    const { job_id, status = "applied", notes = "" } = req.body;
    if (!job_id) return res.status(400).json({ success: false, error: "job_id is required" });

    const VALID_STATUSES = ["applied", "interviewing", "offered", "rejected"];
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
    }

    const { data, error } = await supabase
      .from("applications")
      .insert({ user_id: req.user.id, job_id, status, notes })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ success: true, data });
  } catch (e) {
    // Duplicate check
    if (e.message?.includes("duplicate")) {
      return res.status(409).json({ success: false, error: "You already tracked this application" });
    }
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// APPLICATIONS — UPDATE STATUS
// ==========================================================

app.put("/api/applications/:id", requireAuth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const VALID_STATUSES = ["applied", "interviewing", "offered", "rejected"];

    const updates = { updated_at: new Date().toISOString() };
    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, error: "Invalid status" });
      }
      updates.status = status;
    }
    if (notes !== undefined) updates.notes = notes;

    const { data, error } = await supabase
      .from("applications")
      .update(updates)
      .eq("id", req.params.id)
      .eq("user_id", req.user.id) // ensure ownership
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: "Application not found" });

    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// APPLICATIONS — DELETE
// ==========================================================

app.delete("/api/applications/:id", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("applications")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.user.id);

    if (error) throw error;

    res.json({ success: true, message: "Application removed" });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// JOB SEARCH
// ==========================================================

app.get("/api/jobs", async (req, res) => {
  try {
    const { keyword = "", city, remote, page = 1, limit = 20 } = req.query;
    const pageNum    = Math.max(1, parseInt(page) || 1);
    const limitNum   = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const hasKeyword = keyword.trim().length > 0;

    let query = supabase
      .from("jobs_clean")
      .select(JOB_SELECT, { count: "exact" })
      .eq("is_active", true)
      .order("posted_at", { ascending: false });

    if (hasKeyword) {
      const terms   = expandTerms(keyword);
      const clauses = [];
      terms.forEach((term) => {
        clauses.push(`title.ilike.%${term}%`);
        clauses.push(`description.ilike.%${term}%`);
        clauses.push(`company.ilike.%${term}%`);
      });
      query = query.or(clauses.join(","));
    }

    if (city)           query = query.ilike("city", `%${city}%`);
    if (remote === "true") query = query.eq("remote_type", "remote");

    if (hasKeyword) {
      query = query.limit(500);
    } else {
      const from = (pageNum - 1) * limitNum;
      query = query.range(from, from + limitNum - 1);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    let rows = data || [];

    if (hasKeyword) {
      rows = rows
        .map((job) => ({ ...job, _score: scoreJob(job, keyword) }))
        .sort((a, b) => b._score - a._score);

      const total     = rows.length;
      const start     = (pageNum - 1) * limitNum;
      const paginated = enhanceJobs(rows.slice(start, start + limitNum));

      return res.json({
        success: true, total, page: pageNum, limit: limitNum,
        totalPages: Math.ceil(total / limitNum), data: paginated,
      });
    }

    res.json({
      success: true, total: count || 0, page: pageNum, limit: limitNum,
      totalPages: Math.ceil((count || 0) / limitNum),
      data: enhanceJobs(rows),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// SINGLE JOB
// ==========================================================

app.get("/api/jobs/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("jobs_clean")
      .select(`*, source:sources(name)`)
      .eq("id", req.params.id)
      .eq("is_active", true)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: "Job not found" });

    res.json({ success: true, data: enhanceJob(data) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// FEATURED JOBS
// ==========================================================

app.get("/api/jobs/featured", async (req, res) => {
  try {
    const limitNum = Math.min(20, parseInt(req.query.limit) || 6);
    const { data, error } = await supabase
      .from("jobs_clean")
      .select(JOB_SELECT)
      .eq("is_active", true)
      .not("salary_max", "is", null)
      .order("posted_at", { ascending: false })
      .limit(limitNum);

    if (error) throw error;
    res.json({ success: true, data: enhanceJobs(data || []) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// SEARCH SUGGESTIONS
// ==========================================================

app.get("/api/search/suggest", async (req, res) => {
  try {
    const { q = "" } = req.query;
    if (!q.trim()) return res.json({ success: true, data: [] });

    const { data, error } = await supabase
      .from("jobs_clean")
      .select("title")
      .eq("is_active", true)
      .ilike("title", `%${q.trim()}%`)
      .limit(10);

    if (error) throw error;

    const suggestions = [...new Set((data || []).map((j) => j.title))].slice(0, 8);
    res.json({ success: true, data: suggestions });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// STATS
// ==========================================================

app.get("/api/stats", async (req, res) => {
  try {
    const [{ count: totalJobs, error: e1 }, { count: remoteJobs, error: e2 }] = await Promise.all([
      supabase.from("jobs_clean").select("*", { count: "exact", head: true }).eq("is_active", true),
      supabase.from("jobs_clean").select("*", { count: "exact", head: true }).eq("is_active", true).eq("remote_type", "remote"),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    res.json({ success: true, data: { totalJobs: totalJobs || 0, remoteJobs: remoteJobs || 0 } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// SOURCES
// ==========================================================

app.get("/api/sources", async (req, res) => {
  try {
    const { data, error } = await supabase.from("sources").select("id, name").order("name");
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================================
// 404
// ==========================================================

app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.originalUrl} not found` });
});

// ==========================================================
// START
// ==========================================================

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║ 🚀 Job Copilot API v4               ║
║ 🌐 http://localhost:${PORT}         ║
║ 🔐 /api/auth/register               ║
║ 👤 /api/profile                     ║
║ 🔖 /api/saved                       ║
║ 📋 /api/applications                ║
║ ❤️  /api/health                     ║
╚══════════════════════════════════════╝
`);
});