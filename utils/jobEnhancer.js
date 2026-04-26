// ==========================================================
// PRODUCTION CATEGORY + SALARY + BADGE SYSTEM
// Rewrite Entirely
//
// Put in:
// jobcopilot-api/utils/jobEnhancer.js
//
// Then use in:
// sync.js
// /api/jobs
// ==========================================================

const DAY_MS = 24 * 60 * 60 * 1000;

// ==========================================================
// CATEGORY ENGINE
// ==========================================================

const CATEGORY_RULES = [
  {
    name: "Customer Support",
    keywords: [
      "customer",
      "csr",
      "call center",
      "support",
      "service representative",
      "chat support",
      "helpdesk",
    ],
  },

  {
    name: "Virtual Assistant",
    keywords: [
      "virtual assistant",
      "va",
      "executive assistant",
      "admin assistant",
      "general assistant",
    ],
  },

  {
    name: "IT & Software",
    keywords: [
      "developer",
      "engineer",
      "software",
      "frontend",
      "backend",
      "full stack",
      "programmer",
      "it ",
      "qa",
      "tester",
      "cybersecurity",
      "devops",
    ],
  },

  {
    name: "Creative / Design",
    keywords: [
      "designer",
      "graphic",
      "video editor",
      "video",
      "ui",
      "ux",
      "canva",
      "photoshop",
      "content creator",
    ],
  },

  {
    name: "Marketing",
    keywords: [
      "marketing",
      "seo",
      "social media",
      "facebook ads",
      "ads specialist",
      "brand",
      "copywriter",
    ],
  },

  {
    name: "Finance / Accounting",
    keywords: [
      "bookkeeper",
      "accountant",
      "accounting",
      "payroll",
      "finance",
      "auditor",
    ],
  },

  {
    name: "Sales",
    keywords: [
      "sales",
      "appointment setter",
      "closer",
      "lead generation",
      "business development",
      "telemarketer",
    ],
  },

  {
    name: "Healthcare",
    keywords: [
      "nurse",
      "medical",
      "clinic",
      "health",
      "doctor",
      "pharmacy",
    ],
  },
];

function detectCategory(title = "", description = "") {
  const haystack =
    `${title} ${description}`.toLowerCase();

  for (const rule of CATEGORY_RULES) {
    for (const word of rule.keywords) {
      if (haystack.includes(word)) {
        return rule.name;
      }
    }
  }

  return "General";
}

// ==========================================================
// SALARY ENGINE
// ==========================================================

function cleanNumber(value) {
  if (!value) return null;

  const n = Number(value);

  if (isNaN(n)) return null;

  if (n <= 0) return null;

  return Math.round(n);
}

function normalizeSalary(min, max) {
  min = cleanNumber(min);
  max = cleanNumber(max);

  if (!min && !max) {
    return {
      salary_min: null,
      salary_max: null,
      salary_visible: false,
    };
  }

  if (min && !max) max = min;
  if (!min && max) min = max;

  if (min > max) {
    const temp = min;
    min = max;
    max = temp;
  }

  // unrealistic values protection
  if (max > 1000000) max = null;
  if (min > 1000000) min = null;

  return {
    salary_min: min,
    salary_max: max,
    salary_visible: !!(min || max),
  };
}

function formatSalary(min, max) {
  min = cleanNumber(min);
  max = cleanNumber(max);

  if (!min && !max) return "Salary TBD";

  const fmt = (v) => {
    if (v >= 1000) {
      return `₱${Math.round(v / 1000)}k`;
    }

    return `₱${v}`;
  };

  if (min && max) {
    if (min === max) return fmt(min);

    return `${fmt(min)} – ${fmt(max)}`;
  }

  return fmt(min || max);
}

// ==========================================================
// BADGE ENGINE
// ==========================================================

function isNew(postedAt) {
  if (!postedAt) return false;

  const posted = new Date(postedAt).getTime();

  if (!posted) return false;

  return Date.now() - posted <= DAY_MS;
}

function isHot(job = {}) {
  const title =
    (job.title || "").toLowerCase();

  const salary =
    cleanNumber(job.salary_max) || 0;

  const hotWords = [
    "urgent",
    "immediate",
    "hiring",
    "asap",
  ];

  const urgent =
    hotWords.some((x) =>
      title.includes(x)
    );

  return urgent || salary >= 60000;
}

function isRemote(job = {}) {
  const r =
    (job.remote_type || "").toLowerCase();

  return (
    r.includes("remote") ||
    r.includes("wfh")
  );
}

function getBadges(job = {}) {
  const badges = [];

  if (isNew(job.posted_at)) {
    badges.push({
      label: "NEW",
      color: "#22c55e",
    });
  }

  if (isRemote(job)) {
    badges.push({
      label: "REMOTE",
      color: "#3b82f6",
    });
  }

  if (isHot(job)) {
    badges.push({
      label: "HOT",
      color: "#ef4444",
    });
  }

  return badges;
}

// ==========================================================
// MAIN ENHANCER
// ==========================================================

function enhanceJob(job = {}) {
  const salary =
    normalizeSalary(
      job.salary_min,
      job.salary_max
    );

  const category =
    detectCategory(
      job.title,
      job.description
    );

  const badges =
    getBadges({
      ...job,
      ...salary,
    });

  return {
    ...job,

    category,

    ...salary,

    salary_label: formatSalary(
      salary.salary_min,
      salary.salary_max
    ),

    badges,
  };
}

// ==========================================================
// BULK
// ==========================================================

function enhanceJobs(rows = []) {
  return rows.map(enhanceJob);
}

// ==========================================================
// EXPORTS
// ==========================================================

module.exports = {
  enhanceJob,
  enhanceJobs,
  detectCategory,
  formatSalary,
  getBadges,
};