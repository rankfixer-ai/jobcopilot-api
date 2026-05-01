"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const { createClient } = require("@supabase/supabase-js");

// ===================== INIT =====================

const app = express();
const PORT = process.env.PORT || 10000;

// ===================== SUPABASE =====================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ===================== MIDDLEWARE =====================

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
    ],
    credentials: true,
  })
);



// ===================== AUTH =====================

async function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization;

    if (!auth || !auth.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing token" });
    }

    const token = auth.split(" ")[1];

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    req.user = data.user;
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// ===================== HELPERS =====================

function ok(res, data) {
  return res.json(data);
}

function fail(res, code, msg) {
  return res.status(code).json({ error: msg });
}

// ===================== HEALTH =====================

app.get("/api/health", (req, res) => {
  ok(res, {
    ok: true,
    uptime: process.uptime(),
    time: Date.now(),
  });
});

// ===================== AUTH ROUTES =====================

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data, error } =
      await supabase.auth.signInWithPassword({
        email,
        password,
      });

    if (error) return fail(res, 401, "Invalid credentials");

    ok(res, {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user: data.user,
    });
  } catch {
    fail(res, 400, "Login failed");
  }
});

app.post("/api/auth/register", async (req, res) => {
console.log("REGISTER HIT");
  try {
    const { email, password, full_name } = req.body;

    const { data, error } =
      await supabase.auth.signUp({
        email,
        password,
      });

    if (error) return fail(res, 400, error.message);

    if (data.user?.id) {
      await admin.from("profiles").upsert({
        id: data.user.id,
        email,
        full_name,
      });
    }

    ok(res, { user: data.user });
  } catch {
    fail(res, 400, "Register failed");
  }
});

// ===================== JOBS =====================

app.get("/api/jobs", async (req, res) => {
  try {
    const { data, error } = await admin
      .from("jobs_clean")
      .select("*")
      .eq("is_active", true)
      .limit(20);

    if (error) throw error;

    ok(res, data);
  } catch {
    fail(res, 500, "Failed to fetch jobs");
  }
});

app.get("/api/jobs/:id", async (req, res) => {
  try {
    const { data, error } = await admin
      .from("jobs_clean")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error) return fail(res, 404, "Job not found");

    ok(res, data);
  } catch {
    fail(res, 500, "Error");
  }
});

// ===================== SAVED =====================

app.get("/api/saved", requireAuth, async (req, res) => {
  const { data } = await admin
    .from("saved_jobs")
    .select("*")
    .eq("user_id", req.user.id);

  ok(res, data || []);
});

app.post("/api/saved/:id", requireAuth, async (req, res) => {
  await admin.from("saved_jobs").upsert({
    user_id: req.user.id,
    job_id: req.params.id,
  });

  ok(res, { ok: true });
});

// ===================== 404 =====================

app.use((req, res) => {
  fail(res, 404, "Not found");
});

// ===================== ERROR HANDLER =====================

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// ===================== START =====================

app.listen(PORT, function () {
  console.log("API running on port " + PORT);
});