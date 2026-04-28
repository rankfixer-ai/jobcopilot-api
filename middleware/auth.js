const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: "Missing token" });
    }

    const token = auth.replace("Bearer ", "").trim();
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data || !data.user) {
      return res.status(401).json({ success: false, error: "Invalid token" });
    }

    req.user = data.user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
}

module.exports = requireAuth;