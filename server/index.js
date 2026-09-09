const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const cookieSession = require("cookie-session");
const db = require("./db");

const {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_CALLBACK_URL,
  FRONTEND_URL,
  SESSION_SECRET,
  GITHUB_BOT_TOKEN,
  ALLOWED_GITHUB_LOGINS,
  GH_OWNER = "BestTopEduCationTechLC",
  GH_REPO = "JobSpy",
  GH_WORKFLOW = "scrape-jobs.yml",
  GH_REF = "TESTING",
  PORT = 3000,
} = process.env;

for (const [name, value] of Object.entries({
  GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_CALLBACK_URL,
  FRONTEND_URL, SESSION_SECRET, GITHUB_BOT_TOKEN,
})) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const allowedLogins = (ALLOWED_GITHUB_LOGINS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const app = express();
app.use(express.json());
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(
  cookieSession({
    name: "jobspy_session",
    secret: SESSION_SECRET,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: "lax",
    httpOnly: true,
    secure: true,
  })
);

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Not signed in" });
  next();
}

function isAllowed(login) {
  return allowedLogins.length === 0 || allowedLogins.includes(login.toLowerCase());
}

// ---------- Auth ----------
app.get("/auth/github/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_CALLBACK_URL,
    scope: "read:user",
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

app.get("/auth/github/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send("Invalid OAuth state. Please try logging in again.");
  }
  req.session.oauthState = null;

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_CALLBACK_URL,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error_description || "No access token returned");

    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/vnd.github+json" },
    });
    const ghUser = await userRes.json();
    if (!ghUser.id) throw new Error("Could not fetch GitHub profile");

    if (!isAllowed(ghUser.login)) {
      return res.status(403).send("This GitHub account is not authorized to use this app.");
    }

    const user = { id: ghUser.id, username: ghUser.login, avatar_url: ghUser.avatar_url };
    await db.upsertUser(user);
    req.session.user = user;
    res.redirect(FRONTEND_URL);
  } catch (err) {
    console.error("OAuth callback failed:", err);
    res.status(500).send("Login failed. Please try again.");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

// ---------- Saved jobs ----------
app.get("/api/saved-jobs", requireAuth, async (req, res) => {
  res.json({ jobs: await db.listSavedJobs(req.session.user.id) });
});

app.post("/api/saved-jobs", requireAuth, async (req, res) => {
  const jobs = Array.isArray(req.body.jobs) ? req.body.jobs : [];
  await db.saveJobs(req.session.user.id, jobs);
  res.json({ ok: true });
});

app.delete("/api/saved-jobs/:jobId", requireAuth, async (req, res) => {
  await db.removeSavedJob(req.session.user.id, req.params.jobId);
  res.json({ ok: true });
});

// ---------- Trigger a new scrape ----------
// Uses one server-held bot token so individual users never need their own PAT.
app.post("/api/trigger-scrape", requireAuth, async (req, res) => {
  if (!isAllowed(req.session.user.username)) {
    return res.status(403).json({ error: "Not authorized to trigger scrapes" });
  }
  try {
    const ghRes = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_BOT_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref: GH_REF, inputs: req.body.inputs || {} }),
      }
    );
    if (!ghRes.ok) {
      const text = await ghRes.text().catch(() => "");
      return res.status(502).json({ error: `GitHub API error ${ghRes.status}: ${text}` });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Trigger scrape failed:", err);
    res.status(500).json({ error: "Failed to trigger scrape" });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

db.migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`JobSpy backend listening on :${PORT}`));
  })
  .catch((err) => {
    console.error("Database migration failed:", err);
    process.exit(1);
  });
