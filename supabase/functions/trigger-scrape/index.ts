// Supabase Edge Function: dispatches an on-demand scrape to the Railway-
// hosted scraper service (scraper/server.py) — signed-in users never see
// or need a token/secret of their own.
//
// Deploy: supabase functions deploy trigger-scrape
// Secrets: supabase secrets set SCRAPER_URL=... SCRAPER_WEBHOOK_SECRET=... [ALLOWED_USERNAMES=...]
//
// Fallback: the private-run path in .github/workflows/scrape-jobs.yml
// (workflow_dispatch) still exists and can be triggered manually from the
// Actions tab if this Railway service is ever down — it is no longer
// called automatically from here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SCRAPER_URL = Deno.env.get("SCRAPER_URL"); // e.g. https://your-service.up.railway.app/scrape
const SCRAPER_WEBHOOK_SECRET = Deno.env.get("SCRAPER_WEBHOOK_SECRET");

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

  if (!SCRAPER_URL || !SCRAPER_WEBHOOK_SECRET) {
    return json({ error: "Server misconfigured: SCRAPER_URL/SCRAPER_WEBHOOK_SECRET not set" }, 500);
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
  let runId = "";
  try {
    const body = await req.json();
    inputs = body?.inputs ?? {};
    runId = body?.run_id ?? "";
  } catch (_e) {
    // no body / invalid JSON -> use defaults
  }

  if (!runId) {
    return json({ error: "Missing run_id" }, 400);
  }

  // Confirm this run actually belongs to the caller before dispatching —
  // supabaseClient carries the caller's own JWT, so RLS on search_runs means
  // this select returns nothing for a run_id that isn't theirs.
  const { data: run, error: runError } = await supabaseClient
    .from("search_runs")
    .select("id")
    .eq("id", runId)
    .single();
  if (runError || !run) {
    return json({ error: "Unknown or inaccessible run_id" }, 403);
  }

  const scraperRes = await fetch(SCRAPER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": SCRAPER_WEBHOOK_SECRET,
    },
    body: JSON.stringify({ run_id: runId, inputs }),
  });

  if (!scraperRes.ok) {
    const text = await scraperRes.text().catch(() => "");
    return json({ error: `Scraper service error ${scraperRes.status}: ${text}` }, 502);
  }

  return json({ ok: true });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
