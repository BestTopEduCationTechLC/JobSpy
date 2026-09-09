// Supabase Edge Function: dispatches the scrape-jobs.yml GitHub Actions workflow
// using one bot token held only here (as a function secret) — signed-in users
// never see or need a token of their own.
//
// Deploy: supabase functions deploy trigger-scrape
// Secrets: supabase secrets set GITHUB_BOT_TOKEN=... [ALLOWED_USERNAMES=...]

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GH_OWNER = Deno.env.get("GH_OWNER") ?? "BestTopEduCationTechLC";
const GH_REPO = Deno.env.get("GH_REPO") ?? "JobSpy";
const GH_WORKFLOW = Deno.env.get("GH_WORKFLOW") ?? "scrape-jobs.yml";
const GH_REF = Deno.env.get("GH_REF") ?? "TESTING";

const GITHUB_BOT_TOKEN = Deno.env.get("GITHUB_BOT_TOKEN");
// Usernames here refer to this app's own login (Supabase email/password),
// not GitHub accounts — see docs/assets/app.js's usernameToEmail().
const ALLOWED_USERNAMES = (Deno.env.get("ALLOWED_USERNAMES") ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!GITHUB_BOT_TOKEN) {
    return json({ error: "Server misconfigured: GITHUB_BOT_TOKEN not set" }, 500);
  }

  // Identify the caller from the Authorization header Supabase's client
  // library attaches automatically to functions.invoke() calls.
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
  if (authError || !user) {
    return json({ error: "Not signed in" }, 401);
  }

  const username = (user.user_metadata?.username || (user.email || "").split("@")[0] || "").toLowerCase();
  if (ALLOWED_USERNAMES.length > 0 && !ALLOWED_USERNAMES.includes(username)) {
    return json({ error: "Not authorized to trigger scrapes" }, 403);
  }

  let inputs = {};
  try {
    const body = await req.json();
    inputs = body?.inputs ?? {};
  } catch (_e) {
    // no body / invalid JSON -> use defaults
  }

  const ghRes = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_BOT_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: GH_REF, inputs }),
    }
  );

  if (!ghRes.ok) {
    const text = await ghRes.text().catch(() => "");
    return json({ error: `GitHub API error ${ghRes.status}: ${text}` }, 502);
  }

  return json({ ok: true });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
