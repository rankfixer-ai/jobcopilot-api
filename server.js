// ==========================================================
// server.js v2 — Job Copilot Production API
// Full Rewrite
// ==========================================================

// Load .env only in local development
if (process.env.NODE_ENV !== 'production') {
  const path = require("path");
  require("dotenv").config({ path: path.join(__dirname, ".env") });
}

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const {
  enhanceJobs,
  enhanceJob,
} = require("./utils/jobEnhancer");

// ==========================================================
// APP
// ==========================================================

const app = express();
const PORT =
  process.env.PORT || 3000;

const supabase =
  createClient(
    process.env
      .SUPABASE_URL,
    process.env
      .SUPABASE_SERVICE_KEY
  );

app.use(cors());
app.use(express.json());

// ==========================================================
// LOGGER
// ==========================================================

app.use(
  (
    req,
    res,
    next
  ) => {
    const start =
      Date.now();

    res.on(
      "finish",
      () => {
        const ms =
          Date.now() -
          start;

        console.log(
          `${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`
        );
      }
    );

    next();
  }
);

// ==========================================================
// SEARCH HELPERS
// ==========================================================

const SYNONYMS = {
  csr: [
    "customer service",
    "call center",
    "customer support",
    "chat support",
    "bpo",
  ],

  "customer service":
    [
      "csr",
      "call center",
      "customer support",
      "chat support",
      "bpo",
    ],

  va: [
    "virtual assistant",
    "admin assistant",
  ],

  remote: [
    "wfh",
    "work from home",
    "home based",
  ],

  "social media":
    [
      "smm",
      "facebook ads",
      "marketing",
    ],
};

function expandTerms(
  keyword = ""
) {
  const kw =
    keyword
      .toLowerCase()
      .trim();

  const list =
    SYNONYMS[kw] ||
    [];

  return [
    ...new Set([
      kw,
      ...list,
    ]),
  ].slice(0, 6);
}

function scoreJob(
  job,
  keyword
) {
  if (!keyword)
    return 0;

  const terms =
    expandTerms(
      keyword
    );

  const title =
    (
      job.title ||
      ""
    ).toLowerCase();

  const company =
    (
      job.company ||
      ""
    ).toLowerCase();

  const desc =
    (
      job.description ||
      job.snippet ||
      ""
    ).toLowerCase();

  let score = 0;

  for (const term of terms) {
    if (
      title === term
    )
      score += 1000;
    else if (
      title.startsWith(
        term
      )
    )
      score += 800;
    else if (
      title.includes(
        term
      )
    )
      score += 600;

    if (
      company.includes(
        term
      )
    )
      score += 120;

    if (
      desc.includes(
        term
      )
    )
      score += 80;
  }

  // salary bonus
  if (
    job.salary_max
  ) {
    score += Math.min(
      job.salary_max /
        10000,
      50
    );
  }

  // remote bonus
  if (
    job.remote_type ===
    "remote"
  ) {
    score += 60;
  }

  // freshness
  const d =
    new Date(
      job.posted_at
    );

  const age =
    (Date.now() -
      d.getTime()) /
    (1000 *
      60 *
      60 *
      24);

  if (age <= 1)
    score += 100;
  else if (
    age <= 3
  )
    score += 60;
  else if (
    age <= 7
  )
    score += 30;

  return score;
}

// ==========================================================
// HEALTH
// ==========================================================

app.get(
  "/api/health",
  async (
    req,
    res
  ) => {
    const {
      count,
    } =
      await supabase
        .from(
          "jobs_clean"
        )
        .select(
          "*",
          {
            count:
              "exact",
            head: true,
          }
        )
        .eq(
          "is_active",
          true
        );

    res.json({
      success: true,
      status: "ok",
      activeJobs:
        count || 0,
      time:
        new Date().toISOString(),
    });
  }
);

// ==========================================================
// JOB SEARCH
// ==========================================================

app.get(
  "/api/jobs",
  async (
    req,
    res
  ) => {
    try {
      const {
        keyword = "",
        city,
        remote,
        page = 1,
        limit = 20,
      } = req.query;

      const pageNum =
        parseInt(
          page
        ) || 1;

      const limitNum =
        parseInt(
          limit
        ) || 20;

      let query =
        supabase
          .from(
            "jobs_clean"
          )
          .select(
            `
          id,
          title,
          company,
          location,
          city,
          salary_min,
          salary_max,
          salary_currency,
          salary_visible,
          remote_type,
          employment_type,
          snippet,
          description,
          job_url,
          posted_at,
          created_at,
          is_active,
          source:sources(name)
        `,
            {
              count:
                "exact",
            }
          )
          .eq(
            "is_active",
            true
          )
          .limit(
            keyword
              ? 250
              : limitNum
          );

      // search filter
      if (
        keyword.trim()
      ) {
        const terms =
          expandTerms(
            keyword
          );

        const clauses =
          [];

        terms.forEach(
          (
            term
          ) => {
            clauses.push(
              `title.ilike.%${term}%`
            );
            clauses.push(
              `description.ilike.%${term}%`
            );
            clauses.push(
              `company.ilike.%${term}%`
            );
          }
        );

        query =
          query.or(
            clauses.join(
              ","
            )
          );
      }

      if (city) {
        query =
          query.ilike(
            "city",
            `%${city}%`
          );
      }

      if (
        remote ===
        "true"
      ) {
        query =
          query.eq(
            "remote_type",
            "remote"
          );
      }

      query =
        query.order(
          "posted_at",
          {
            ascending: false,
          }
        );

      const {
        data,
        error,
        count,
      } =
        await query;

      if (error)
        throw error;

      let rows =
        data || [];

      // relevance ranking
      if (
        keyword.trim()
      ) {
        rows =
          rows
            .map(
              (
                job
              ) => ({
                ...job,
                _score:
                  scoreJob(
                    job,
                    keyword
                  ),
              })
            )
            .sort(
              (
                a,
                b
              ) =>
                b._score -
                a._score
            );
      }

      // paginate
      const start =
        (pageNum -
          1) *
        limitNum;

      let paginated =
        rows.slice(
          start,
          start +
            limitNum
        );

      // enhancer
      paginated =
        enhanceJobs(
          paginated
        );

      res.json({
        success: true,
        total:
          count ||
          rows.length,
        page: pageNum,
        limit:
          limitNum,
        totalPages:
          Math.ceil(
            (count ||
              rows.length) /
              limitNum
          ),
        data: paginated,
      });
    } catch (e) {
      console.error(
        e
      );

      res
        .status(
          500
        )
        .json({
          success: false,
          error:
            e.message,
        });
    }
  }
);

// ==========================================================
// SINGLE JOB
// ==========================================================

app.get(
  "/api/jobs/:id",
  async (
    req,
    res
  ) => {
    try {
      const {
        data,
        error,
      } =
        await supabase
          .from(
            "jobs_clean"
          )
          .select(
            `
          *,
          source:sources(name)
        `
          )
          .eq(
            "id",
            req.params.id
          )
          .single();

      if (error)
        throw error;

      const row =
        enhanceJob(
          data
        );

      res.json({
        success: true,
        data: row,
      });
    } catch (e) {
      res
        .status(
          500
        )
        .json({
          success: false,
          error:
            e.message,
        });
    }
  }
);

// ==========================================================
// STATS
// ==========================================================

app.get(
  "/api/stats",
  async (
    req,
    res
  ) => {
    const {
      count:
        totalJobs,
    } =
      await supabase
        .from(
          "jobs_clean"
        )
        .select(
          "*",
          {
            count:
              "exact",
            head: true,
          }
        )
        .eq(
          "is_active",
          true
        );

    const {
      count:
        remoteJobs,
    } =
      await supabase
        .from(
          "jobs_clean"
        )
        .select(
          "*",
          {
            count:
              "exact",
            head: true,
          }
        )
        .eq(
          "is_active",
          true
        )
        .eq(
          "remote_type",
          "remote"
        );

    res.json({
      success: true,
      data: {
        totalJobs:
          totalJobs ||
          0,
        remoteJobs:
          remoteJobs ||
          0,
      },
    });
  }
);

// ==========================================================
// 404
// ==========================================================

app.use(
  (
    req,
    res
  ) => {
    res
      .status(
        404
      )
      .json({
        success: false,
        error: `Route ${req.originalUrl} not found`,
      });
  }
);

// ==========================================================
// START
// ==========================================================

app.listen(
  PORT,
  () => {
    console.log(`
╔══════════════════════════════════════╗
║ 🚀 Job Copilot API                  ║
║ 🌐 http://localhost:${PORT}         ║
║ 🔍 /api/jobs?keyword=VA             ║
║ ❤️ /api/health                      ║
╚══════════════════════════════════════╝
`);
  }
);