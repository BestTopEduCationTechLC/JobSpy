// Shared logic for the JobSpy Search static site: identity, saved jobs,
// boolean search parsing, triggering the scraper workflow, and PDF export.
(function (global) {
  "use strict";

  const GH_OWNER = "BestTopEduCationTechLC";
  const GH_REPO = "JobSpy";
  const GH_WORKFLOW = "scrape-jobs.yml";
  const GH_REF = "TESTING";

  const KEY_USERNAME = "jobspy_username";
  const KEY_SAVED = "jobspy_saved_jobs";
  const KEY_TOKEN = "jobspy_gh_token";

  // ---------- Identity ("login") ----------
  // There is no backend/auth here — this is a static site. "Logging in" just
  // asks for a display name once and remembers it in this browser only, so the
  // personal page can be titled per-person as the spec asks for.
  function getUsername() {
    try { return localStorage.getItem(KEY_USERNAME) || ""; } catch (e) { return ""; }
  }

  function setUsername(name) {
    try { localStorage.setItem(KEY_USERNAME, name); } catch (e) {}
  }

  function ensureUsername() {
    let name = getUsername();
    if (!name) {
      name = (global.prompt("Welcome! What name should we use for your saved-jobs page?", "") || "").trim();
      if (!name) name = "Guest";
      setUsername(name);
    }
    return name;
  }

  // ---------- Saved jobs ----------
  function getSavedJobs() {
    try { return JSON.parse(localStorage.getItem(KEY_SAVED) || "[]"); } catch (e) { return []; }
  }

  function setSavedJobs(jobs) {
    try { localStorage.setItem(KEY_SAVED, JSON.stringify(jobs)); } catch (e) {}
  }

  function saveJobs(jobs) {
    const existing = getSavedJobs();
    const byId = new Map(existing.map((j) => [j.id, j]));
    jobs.forEach((j) => byId.set(j.id, j));
    setSavedJobs(Array.from(byId.values()));
  }

  function removeSavedJobs(ids) {
    const idSet = new Set(ids);
    setSavedJobs(getSavedJobs().filter((j) => !idSet.has(j.id)));
  }

  // ---------- GitHub token (for the "Run New Search" button) ----------
  // Stored only in this browser's localStorage and sent only to api.github.com
  // directly from the browser — this project has no server to hold it instead.
  function getToken() {
    try { return localStorage.getItem(KEY_TOKEN) || ""; } catch (e) { return ""; }
  }

  function setToken(token) {
    try {
      if (token) localStorage.setItem(KEY_TOKEN, token);
      else localStorage.removeItem(KEY_TOKEN);
    } catch (e) {}
  }

  function ensureToken() {
    let token = getToken();
    if (!token) {
      token = (global.prompt(
        "To trigger a new scrape, paste a GitHub Personal Access Token with 'workflow' scope.\n" +
        "It is saved only in this browser (localStorage) and sent only to api.github.com.\n" +
        "Create one at https://github.com/settings/tokens (classic, scope: 'workflow').",
        ""
      ) || "").trim();
      if (token) setToken(token);
    }
    return token;
  }

  async function dispatchScrape(inputs) {
    const token = ensureToken();
    if (!token) throw new Error("No GitHub token provided — cannot trigger the workflow.");

    const res = await fetch(
      `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref: GH_REF, inputs }),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        setToken(""); // bad/expired token — drop it so next attempt re-prompts
      }
      throw new Error(`GitHub API error ${res.status}: ${text || res.statusText}`);
    }
  }

  function actionsRunUrl() {
    return `https://github.com/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW}`;
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
        if (nextTok && nextTok !== "(" ) {
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
  function renderNav(activePage) {
    const name = getUsername();
    const container = document.getElementById("topnav");
    if (!container) return;
    const link = (href, label, key) =>
      `<a class="navlink${activePage === key ? " active" : ""}" href="${href}">${label}</a>`;
    container.innerHTML = `
      <div class="inner">
        <span class="brand">JobSpy Search</span>
        ${link("index.html", "Search", "index")}
        ${link("personal.html", "My Saved Jobs", "personal")}
        ${link("contact.html", "Contact", "contact")}
        <span class="whoami">
          ${name ? `Hi, ${escapeHtml(name)}` : "Not signed in"}
          <button type="button" id="navChangeName">${name ? "change name" : "set name"}</button>
        </span>
      </div>`;
    const btn = document.getElementById("navChangeName");
    if (btn) {
      btn.addEventListener("click", () => {
        const current = getUsername();
        const next = (global.prompt("Display name:", current) || "").trim();
        if (next) { setUsername(next); location.reload(); }
      });
    }
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  global.JobSpyApp = {
    getUsername, setUsername, ensureUsername,
    getSavedJobs, setSavedJobs, saveJobs, removeSavedJobs,
    getToken, setToken, ensureToken, dispatchScrape, actionsRunUrl,
    parseBooleanQuery, buildPredicate, toScraperTerm,
    exportJobsToPdf, renderNav, escapeHtml,
  };
})(window);
