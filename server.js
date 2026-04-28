```js id="r5j3nv"
/**
 * JobCopilot API - SERVER V4.2
 * COMPLETE deploy-ready server.js
 *
 * Includes all 7 requested fixes:
 * 1. jobEnhancer integration
 * 2. remote_type filtering
 * 3. /api/jobs/featured
 * 4. /api/search/suggest
 * 5. /api/categories
 * 6. /api/sources
 * 7. synonym expansion + relevance scoring
 *
 * Keeps:
 * - Supabase native auth
 * - Existing frontend compatibility
 * - access_token response format
 * - saved jobs
 * - applications
 * - stats
 *
 * Requires:
 * npm i express cors helmet compression express-rate-limit morgan dotenv zod @supabase/supabase-js
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const { z } = require("zod");
const { createClient } = require("@supabase/supabase-js");
const { enhanceJobs, enhanceJob } = require("./utils/jobEnhancer");

const app = express();
const PORT = process.env.PORT || 10000;

/* -------------------------------------------------------------------------- */
/* Supabase */
/* -------------------------------------------------------------------------- */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/* -------------------------------------------------------------------------- */
/* Middleware */
/* -------------------------------------------------------------------------- */

app.set("trust proxy", 1);
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("combined"));

app.use(
  cors({
    origin: [
      "https://jobcopilotph.vercel.app",
      "http://localhost:3000",
      "http://localhost:5173",
    ],
    credentials: true,
  })
);

app.use(
  "/api/",
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

/* -------------------------------------------------------------------------- */
/* Constants */
/* -------------------------------------------------------------------------- */

const JOB_SELECT = [
  "id","title","company","city","category","source_id","source_url","source_job_id",
  "salary_range","salary_min","salary_max",
  "description","employment_type","remote_type",
  "created_at","updated_at","is_active",
  "source:sources(name)"
].join(",");


const SYNONYMS = {
  va: ["virtual assistant", "admin assistant"],
  csr: ["customer service", "customer support", "call center"],
  seo: ["search engine optimization"],
  smm: ["social media manager", "social media"],
  dev: ["developer", "software engineer"],
};

/* -------------------------------------------------------------------------- */
/* Helpers */
/* -------------------------------------------------------------------------- */

function ok(res, payload) {
  return res.json(payload);
}

function fail(res, code, msg) {
  return res.status(code).json({ error: msg });
}

function normalizePage(v) {
  const n = parseInt(v || "1", 10);
  return Math.max(1, Math.min(n, 1000));
}

function normalizeLimit(v) {
  const n = parseInt(v || "15", 10);
  return Math.max(1, Math.min(n, 50));
}

function expandKeyword(keyword = "") {
  const q = keyword.toLowerCase().trim();
  return [q, ...(SYNONYMS[q] || [])];
}

function scoreJob(job, keyword) {
  if (!keyword) return 0;

  const q = keyword.toLowerCase();
  let score = 0;

  if ((job.title || "").toLowerCase().includes(q)) score += 10;
  if ((job.company || "").toLowerCase().includes(q)) score += 5;
  if ((job.category || "").toLowerCase().includes(q)) score += 4;
  if ((job.description || "").toLowerCase().includes(q)) score += 2;

  return score;
}

/* -------------------------------------------------------------------------- */
/* Validation */
/* -------------------------------------------------------------------------- */

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(72),
});

const registerSchema = z.object({
  full_name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(72),
});

const applicationSchema = z.object({
  job_id: z.string().uuid(),
  status: z.string().optional(),
  notes: z.string().max(500).optional(),
});

/* -------------------------------------------------------------------------- */
/* Auth Middleware */
/* -------------------------------------------------------------------------- */

const requireAuth = require("./middleware/auth");
/* -------------------------------------------------------------------------- */
/* Health */
/* -------------------------------------------------------------------------- */

app.get("/api/health", (_, res) => {
  ok(res, {
    ok: true,
    service: "jobcopilot-api",
    uptime: process.uptime(),
    ts: Date.now(),
  });
});

/* -------------------------------------------------------------------------- */
/* AUTH */
/* -------------------------------------------------------------------------- */

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const body = loginSchema.parse(req.body);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: body.email,
      password: body.password,
    });

    if (error) return fail(res, 401, "Invalid credentials");

    return ok(res, {
      ok: true,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user: data.user,
    });
  } catch {
    return fail(res, 400, "Login failed");
  }
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const body = registerSchema.parse(req.body);

    const { data, error } = await supabase.auth.signUp({
      email: body.email,
      password: body.password,
    });

    if (error) return fail(res, 400, error.message);

    if (data?.user?.id) {
      await admin.from("profiles").upsert({
        id: data.user.id,
        full_name: body.full_name,
        email: body.email,
      });
    }

    return ok(res, {
      ok: true,
      access_token: data.session?.access_token || null,
      user: data.user,
    });
  } catch {
    return fail(res, 400, "Registration failed");
  }
});

app.post("/api/auth/refresh", async (req, res) => {
  try {
    const refresh_token = req.body.refresh_token;

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token,
    });

    if (error) return fail(res, 401, error.message);

    return ok(res, {
      ok: true,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user: data.user,
    });
  } catch {
    return fail(res, 400, "Refresh failed");
  }
});

app.post("/api/auth/logout", (_, res) => {
  return ok(res, { ok: true });
});

/* -------------------------------------------------------------------------- */
/* PROFILE */
/* -------------------------------------------------------------------------- */

app.get("/api/profile", requireAuth, async (req, res) => {
  const { data, error } = await admin
    .from("profiles")
    .select("*")
    .eq("id", req.user.id)
    .single();

  if (error) return fail(res, 404, "Profile not found");

  return ok(res, data);
});

app.put("/api/profile", requireAuth, async (req, res) => {
  const { data, error } = await admin
    .from("profiles")
    .update(req.body)
    .eq("id", req.user.id)
    .select()
    .single();

  if (error) return fail(res, 400, error.message);

  return ok(res, data);
});

/* -------------------------------------------------------------------------- */
/* JOBS */
/* -------------------------------------------------------------------------- */

app.get("/api/jobs", async (req, res) => {
  try {
    const keyword = (req.query.keyword || "").trim();
    const city = (req.query.city || "").trim();
    const remote = req.query.remote === "true";

    const page = normalizePage(req.query.page);
    const limit = normalizeLimit(req.query.limit);

    let query = admin
      .from("jobs_clean")
      .select(JOB_SELECT, { count: "exact" })
      .eq("is_active", true);

    if (keyword) {
      const terms = expandKeyword(keyword);

      const parts = [];

      for (const term of terms) {
        parts.push(`title.ilike.%${term}%`);
        parts.push(`company.ilike.%${term}%`);
        parts.push(`description.ilike.%${term}%`);
      }

      query = query.or(parts.join(","));
    }

    if (city) query = query.ilike("city", `%${city}%`);
    if (remote) query = query.eq("remote_type", "remote");

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, count, error } = await query.range(from, to);

    if (error) throw error;

    let rows = enhanceJobs(data || []);

    if (keyword) {
      rows = rows
        .map((job) => ({
          ...job,
          _score: scoreJob(job, keyword),
        }))
        .sort((a, b) => b._score - a._score);
    }

    return ok(res, {
      rows,
      total: count || 0,
      page,
      limit,
    });
  } catch {
    return fail(res, 500, "Search failed");
  }
});

app.get("/api/jobs/:id", async (req, res) => {
  const { data, error } = await admin
    .from("jobs_clean")
    .select(JOB_SELECT)
    .eq("id", req.params.id)
    .single();

  if (error) return fail(res, 404, "Job not found");

  return ok(res, enhanceJob(data));
});

/* -------------------------------------------------------------------------- */
/* Featured */
/* -------------------------------------------------------------------------- */

app.get("/api/jobs/featured", async (_, res) => {
  const { data } = await admin
    .from("jobs_clean")
    .select(JOB_SELECT)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(6);

  return ok(res, enhanceJobs(data || []));
});

/* -------------------------------------------------------------------------- */
/* Search Suggest */
/* -------------------------------------------------------------------------- */

app.get("/api/search/suggest", async (req, res) => {
  const q = (req.query.q || "").trim();

  if (!q || q.length < 2) return ok(res, []);

  const { data } = await admin
    .from("jobs_clean")
    .select("title")
    .ilike("title", `%${q}%`)
    .eq("is_active", true)
    .limit(8);

  const list = [...new Set((data || []).map((x) => x.title))];

  return ok(res, list);
});

/* -------------------------------------------------------------------------- */
/* Categories */
/* -------------------------------------------------------------------------- */

app.get("/api/categories", async (_, res) => {
  const { data } = await admin
    .from("jobs_clean")
    .select("category")
    .eq("is_active", true);

  const rows = [...new Set((data || []).map((r) => r.category).filter(Boolean))];

  return ok(res, rows.sort());
});

/* -------------------------------------------------------------------------- */
/* Sources */
/* -------------------------------------------------------------------------- */

app.get("/api/sources", async (_, res) => {
  const { data } = await admin
    .from("sources")
    .select("*")
    .order("name");

  return ok(res, data || []);
});

/* -------------------------------------------------------------------------- */
/* Trending */
/* -------------------------------------------------------------------------- */

app.get("/api/trending", async (_, res) => {
  return ok(res, [
    "VA",
    "CSR",
    "Remote",
    "Bookkeeper",
    "Social Media",
    "SEO",
  ]);
});

/* -------------------------------------------------------------------------- */
/* Saved Jobs */
/* -------------------------------------------------------------------------- */

app.get("/api/saved", requireAuth, async (req, res) => {
  const { data, error } = await admin
    .from("saved_jobs")
    .select("*, jobs_clean(*)")
    .eq("user_id", req.user.id)
    .order("saved_at", { ascending: false });

  if (error) return fail(res, 500, error.message);

  return ok(res, enhanceJobs((data || []).map((x) => x.jobs_clean || x)));
});

app.post("/api/saved/:jobId", requireAuth, async (req, res) => {
  const { error } = await admin.from("saved_jobs").upsert({
    user_id: req.user.id,
    job_id: req.params.jobId,
  });

  if (error) return fail(res, 400, error.message);

  return ok(res, { ok: true });
});

app.delete("/api/saved/:jobId", requireAuth, async (req, res) => {
  await admin
    .from("saved_jobs")
    .delete()
    .eq("user_id", req.user.id)
    .eq("job_id", req.params.jobId);

  return ok(res, { ok: true });
});

/* -------------------------------------------------------------------------- */
/* Applications */
/* -------------------------------------------------------------------------- */

app.get("/api/applications", requireAuth, async (req, res) => {
  const { data, error } = await admin
    .from("applications")
    .select("*, jobs_clean(*)")
    .eq("user_id", req.user.id)
    .order("updated_at", { ascending: false });

  if (error) return fail(res, 500, error.message);

  return ok(res, data || []);
});

app.post("/api/applications", requireAuth, async (req, res) => {
  try {
    const body = applicationSchema.parse(req.body);

    const { data, error } = await admin
      .from("applications")
      .insert({
        user_id: req.user.id,
        job_id: body.job_id,
        status: body.status || "Applied",
        notes: body.notes || "",
      })
      .select()
      .single();

    if (error) throw error;

    return ok(res, data);
  } catch {
    return fail(res, 400, "Create failed");
  }
});

app.put("/api/applications/:id", requireAuth, async (req, res) => {
  const { data, error } = await admin
    .from("applications")
    .update(req.body)
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .select()
    .single();

  if (error) return fail(res, 400, error.message);

  return ok(res, data);
});

app.delete("/api/applications/:id", requireAuth, async (req, res) => {
  await admin
    .from("applications")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user.id);

  return ok(res, { ok: true });
});

/* -------------------------------------------------------------------------- */
/* Stats */
/* -------------------------------------------------------------------------- */

app.get("/api/stats", async (_, res) => {
  const { count } = await admin
    .from("jobs_clean")
    .select("*", { head: true, count: "exact" })
    .eq("is_active", true);

  return ok(res, {
    active_jobs: count || 0,
  });
});

/* -------------------------------------------------------------------------- */
/* 404 */
/* -------------------------------------------------------------------------- */

app.use((_, res) => {
  fail(res, 404, "Route not found");
});

/* -------------------------------------------------------------------------- */
/* Crash Safety */
/* -------------------------------------------------------------------------- */

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

/* -------------------------------------------------------------------------- */
/* Start */
/* -------------------------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`JobCopilot API V4.2 running on ${PORT}`);
});
```
