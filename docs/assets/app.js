// Shared logic for the JobSpy Search static site: Supabase auth (GitHub
// login), server-stored saved jobs (Postgres + Row Level Security), boolean
// search parsing, triggering the scraper workflow via a Supabase Edge
// Function, and client-side PDF export.
(function (global) {
  "use strict";

  // Fill these in from your Supabase project (Project Settings -> API).
  // The anon key is safe to expose in a public frontend — Row Level Security
  // on the saved_jobs table is what actually restricts access per user.
  const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
  const SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";

  const supabase = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ---------- Auth ----------
  async function getUser() {
    const { data: { session } } = await supabase.auth.getSession();
    return session ? sessionToUser(session) : null;
  }

  function sessionToUser(session) {
    const meta = session.user.user_metadata || {};
    return {
      id: session.user.id,
      username: meta.user_name || meta.preferred_username || session.user.email || "User",
      avatar_url: meta.avatar_url || "",
    };
  }

  function login() {
    supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: location.origin + location.pathname.replace(/[^/]*$/, "index.html") },
    });
  }

  async function logout() {
    await supabase.auth.signOut();
    location.reload();
  }

  // ---------- Saved jobs (server-stored via Supabase, per signed-in user) ----------
  async function getSavedJobs() {
    const { data, error } = await supabase
      .from("saved_jobs")
      .select("id:job_id, title, company, location, job_url, job_type, site, date_posted, description")
      .order("saved_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function saveJobs(jobs) {
    const rows = jobs.map((j) => ({
      job_id: j.id,
      title: j.title || null,
      company: j.company || null,
      location: j.location || null,
      job_url: j.job_url || null,
      job_type: j.job_type || null,
      site: j.site || null,
      date_posted: j.date_posted || null,
      description: j.description || null,
    }));
    const { error } = await supabase.from("saved_jobs").upsert(rows, { onConflict: "user_id,job_id" });
    if (error) throw error;
  }

  async function removeSavedJob(jobId) {
    const { error } = await supabase.from("saved_jobs").delete().eq("job_id", jobId);
    if (error) throw error;
  }

  // ---------- Trigger a new scrape ----------
  // Calls a Supabase Edge Function that holds one bot token server-side, so
  // signed-in users never need a GitHub token of their own.
  async function dispatchScrape(inputs) {
    const { data, error } = await supabase.functions.invoke("trigger-scrape", { body: { inputs } });
    if (error) throw new Error(error.message || "Failed to trigger scrape");
    if (data && data.error) throw new Error(data.error);
  }

  function actionsRunUrl() {
    return "https://github.com/BestTopEduCationTechLC/JobSpy/actions/workflows/scrape-jobs.yml";
  }

  // ---------- Boolean search parsing (AND / OR / NOT) ----------
  // The search bar accepts AND / OR / NOT (plus quoted phrases and parentheses).
  // This is resolved HERE, client-side, before anything reaches the scraper:
  //  - buildPredicate() gives an exact boolean filter over already-scraped jobs.
  //  - toScraperTerm() rewrites the same query into JobSpy/Indeed's own syntax
  //    (implicit AND via spaces, "-word" for NOT, OR kept as-is) so the raw
  //    AND/OR/NOT keywords never get passed into the scraper directly.
  function tokenize(input) {
    const spaced = String(input || "").replace(/([()])/g, " $1 ");
    return spaced.match(/"[^"]*"|\S+/g) || [];
  }

  function stripQuotes(tok) {
    return tok.replace(/^"|"$/g, "");
  }

  function parseBooleanQuery(input) {
    const tokens = tokenize(input);
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    function parseExpr() {
      let node = parseTerm();
      while (peek() && String(peek()).toUpperCase() === "OR") {
        next();
        node = { type: "OR", left: node, right: parseTerm() };
      }
      return node;
    }

    function parseTerm() {
      let node = parseFactor();
      while (peek() && peek() !== ")" && String(peek()).toUpperCase() !== "OR") {
        if (String(peek()).toUpperCase() === "AND") next();
        node = { type: "AND", left: node, right: parseFactor() };
      }
      return node;
    }

    function parseFactor() {
      const tok = peek();
      if (!tok) return { type: "TRUE" };
      if (String(tok).toUpperCase() === "NOT") {
        next();
        return { type: "NOT", node: parseFactor() };
      }
      if (tok === "(") {
        next();
        const inner = parseExpr();
        if (peek() === ")") next();
        return inner;
      }
      next();
      return { type: "TERM", value: stripQuotes(tok).toLowerCase() };
    }

    const ast = tokens.length ? parseExpr() : { type: "TRUE" };

    function evaluate(node, haystack) {
      switch (node.type) {
        case "TERM": return haystack.includes(node.value);
        case "AND": return evaluate(node.left, haystack) && evaluate(node.right, haystack);
        case "OR": return evaluate(node.left, haystack) || evaluate(node.right, haystack);
        case "NOT": return !evaluate(node.node, haystack);
        default: return true;
      }
    }

    return {
      matches(text) { return evaluate(ast, String(text || "").toLowerCase()); },
    };
  }

  function buildPredicate(input, fieldsFn) {
    const query = parseBooleanQuery(input);
    return function (job) {
      if (!input || !input.trim()) return true;
      return query.matches(fieldsFn(job));
    };
  }

  function toScraperTerm(input) {
    const tokens = tokenize(input);
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const upper = String(tok).toUpperCase();
      if (upper === "AND" || tok === "(" || tok === ")") continue; // implicit AND; drop grouping for the scraper term
      if (upper === "NOT") {
        const nextTok = tokens[i + 1];
        if (nextTok && nextTok !== "(") {
          out.push("-" + stripQuotes(nextTok));
          i++;
        }
        continue;
      }
      out.push(tok);
    }
    return out.join(" ").trim();
  }

  // ---------- PDF export ----------
  // Uses jsPDF (loaded separately via <script> tag on the page). Exports the
  // given jobs as a simple PDF, optionally including the full description.
  function exportJobsToPdf(jobs, options) {
    const includeDescription = !!(options && options.includeDescription);
    const jsPDFCtor = global.jspdf && global.jspdf.jsPDF;
    if (!jsPDFCtor) {
      global.alert("PDF library failed to load. Check your connection and try again.");
      return;
    }
    const doc = new jsPDFCtor({ unit: "pt", format: "a4" });
    const marginLeft = 40;
    const maxWidth = 515;
    const pageHeight = doc.internal.pageSize.getHeight();
    let y = 48;

    doc.setFontSize(16);
    doc.setFont(undefined, "bold");
    doc.text(`JobSpy export (${jobs.length} job${jobs.length === 1 ? "" : "s"})`, marginLeft, y);
    y += 26;

    jobs.forEach((job, idx) => {
      if (y > pageHeight - 90) { doc.addPage(); y = 48; }

      doc.setFontSize(13);
      doc.setFont(undefined, "bold");
      doc.text(doc.splitTextToSize(job.title || "Untitled", maxWidth), marginLeft, y);
      y += 18;

      doc.setFontSize(10.5);
      doc.setFont(undefined, "normal");
      doc.text(`${job.company || "Unknown company"} · ${job.location || ""}`, marginLeft, y);
      y += 14;

      const tags = [job.site, job.job_type, job.date_posted].filter(Boolean).join("  |  ");
      if (tags) { doc.text(tags, marginLeft, y); y += 14; }

      if (job.job_url) {
        doc.setTextColor(37, 99, 235);
        doc.textWithLink(job.job_url, marginLeft, y, { url: job.job_url });
        doc.setTextColor(0, 0, 0);
        y += 14;
      }

      if (includeDescription && job.description) {
        y += 4;
        const lines = doc.splitTextToSize(job.description, maxWidth);
        for (const line of lines) {
          if (y > pageHeight - 60) { doc.addPage(); y = 48; }
          doc.text(line, marginLeft, y);
          y += 13;
        }
      }

      y += 14;
      if (idx < jobs.length - 1) {
        doc.setDrawColor(220);
        doc.line(marginLeft, y - 8, marginLeft + maxWidth, y - 8);
      }
    });

    doc.save(`jobspy-export-${Date.now()}.pdf`);
  }

  // ---------- Shared nav ----------
  async function renderNav(activePage) {
    const container = document.getElementById("topnav");
    if (!container) return;
    const user = await getUser();
    const link = (href, label, key) =>
      `<a class="navlink${activePage === key ? " active" : ""}" href="${href}">${label}</a>`;
    container.innerHTML = `
      <div class="inner">
        <span class="brand">JobSpy Search</span>
        ${link("index.html", "Search", "index")}
        ${link("personal.html", "My Saved Jobs", "personal")}
        ${link("contact.html", "Contact", "contact")}
        <span class="whoami">
          ${user ? `Hi, ${escapeHtml(user.username)}` : "Not signed in"}
          <button type="button" id="navAuthBtn">${user ? "sign out" : "sign in with GitHub"}</button>
        </span>
      </div>`;
    const btn = document.getElementById("navAuthBtn");
    if (btn) btn.addEventListener("click", () => (user ? logout() : login()));
    return user;
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  global.JobSpyApp = {
    supabase, getUser, login, logout,
    getSavedJobs, saveJobs, removeSavedJob,
    dispatchScrape, actionsRunUrl,
    parseBooleanQuery, buildPredicate, toScraperTerm,
    exportJobsToPdf, renderNav, escapeHtml,
  };
})(window);
