// Shared logic for the JobSpy Search static site: Supabase auth (username +
// password, no GitHub login), server-stored saved jobs (Postgres + Row Level
// Security), boolean search parsing, triggering the scraper workflow via a
// Supabase Edge Function, and client-side PDF export.
(function (global) {
  "use strict";

  // Fill these in from your Supabase project (Project Settings -> API).
  // The anon key is safe to expose in a public frontend — Row Level Security
  // on the saved_jobs table is what actually restricts access per user.
  const SUPABASE_URL = "https://inniqenqdcmqqmvvlrzb.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_aS8f54NDRKx_0qEhEeGGfA_Ey9NSFse";

  const supabase = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ---------- Auth (username + password; a real, confirmed email is required) ----------
  // Sign-up collects a real email address and Supabase sends a confirmation
  // link to it — the account cannot log in until that link is clicked
  // (Supabase's standard "Confirm email" flow, left ON). The chosen username
  // is stored in user_metadata.username and is what the user actually types
  // to log in; get_login_email() resolves username -> current email so sign-in
  // never has to guess or reconstruct an address.
  const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  async function getUser() {
    const { data: { session } } = await supabase.auth.getSession();
    return session ? sessionToUser(session) : null;
  }

  function sessionToUser(session) {
    const meta = session.user.user_metadata || {};
    return {
      id: session.user.id,
      username: meta.username || (session.user.email || "").split("@")[0] || "User",
      email: session.user.email,
    };
  }

  function validateUsername(username) {
    if (!USERNAME_RE.test(username)) {
      return "Username must be 3-32 characters: letters, numbers, . _ or - only.";
    }
    return null;
  }

  function validatePassword(password) {
    if (!password || password.length < 6) {
      return "Password must be at least 6 characters.";
    }
    return null;
  }

  async function signUp(username, email, password) {
    const err = validateUsername(username) || validatePassword(password);
    if (err) throw new Error(err);
    if (!EMAIL_RE.test(email)) throw new Error("Enter a valid email address.");
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { username: username.trim().toLowerCase() },
        emailRedirectTo: location.origin + location.pathname.replace(/[^/]*$/, "index.html"),
      },
    });
    if (error) throw new Error(error.message);
    // With "Confirm email" on, signUp() does not return an active session —
    // the account exists but can't sign in until the emailed link is clicked.
    return { needsConfirmation: !data.session };
  }

  async function signIn(username, password) {
    const err = validateUsername(username) || validatePassword(password);
    if (err) throw new Error(err);
    const { data: email, error: lookupError } = await supabase.rpc("get_login_email", {
      p_username: username.trim().toLowerCase(),
    });
    if (lookupError || !email) throw new Error("No account found for that username.");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (/confirm/i.test(error.message)) {
        throw new Error("Please confirm your email first — check the inbox you signed up with.");
      }
      throw new Error(error.message);
    }
  }

  async function logout() {
    await supabase.auth.signOut();
    location.reload();
  }

  // ---------- Forgot password ----------
  // Resolves username -> current email (same RPC as sign-in) and asks
  // Supabase to email a recovery link. That link lands on reset-password.html
  // with a recovery token in the URL, which Supabase's client picks up
  // automatically and turns into a temporary session (see reset-password.html)
  // used only to call updatePassword() below.
  async function requestPasswordReset(username) {
    const err = validateUsername(username);
    if (err) throw new Error(err);
    // Deliberately doesn't distinguish "no such username" from "email sent" —
    // revealing which usernames exist is exactly what a forgot-password form
    // shouldn't do. Callers should always show one generic message.
    const { data: email, error: lookupError } = await supabase.rpc("get_login_email", {
      p_username: username.trim().toLowerCase(),
    });
    if (lookupError || !email) return;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname.replace(/[^/]*$/, "reset-password.html"),
    });
    if (error) throw new Error(error.message);
  }

  async function updatePassword(newPassword) {
    const err = validatePassword(newPassword);
    if (err) throw new Error(err);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw new Error(error.message);
  }

  // ---------- Changing the account's email later ----------
  // Uses Supabase's own secure-email-change flow: it sends a confirmation
  // link to the new address and only swaps it in once clicked, so login (via
  // get_login_email above) keeps resolving to whichever email is current.
  async function getEmailStatus() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    return { current: user.email || null, pending: user.new_email || null };
  }

  async function updateContactEmail(email) {
    if (!EMAIL_RE.test(email)) throw new Error("Enter a valid email address.");
    const { error } = await supabase.auth.updateUser(
      { email },
      { emailRedirectTo: location.origin + location.pathname.replace(/[^/]*$/, "personal.html") }
    );
    if (error) throw new Error(error.message);
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

  // ---------- Private per-user search runs ----------
  // Each "Run New Search" creates its own row here first; the GitHub Actions
  // workflow writes that run's results into search_results (via a service
  // role key, bypassing RLS) instead of the one shared docs/data/jobs.json —
  // so one user's search never overwrites or leaks into another's results.
  async function createSearchRun({ searchTerm, location: loc, params }) {
    const { data, error } = await supabase
      .from("search_runs")
      .insert({ search_term: searchTerm, location: loc, params })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function getSearchRun(runId) {
    const { data, error } = await supabase.from("search_runs").select("*").eq("id", runId).single();
    if (error) throw error;
    return data;
  }

  async function listSearchRuns() {
    const { data, error } = await supabase
      .from("search_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return data || [];
  }

  async function getSearchResults(runId) {
    const { data, error } = await supabase
      .from("search_results")
      .select("id:job_id, title, company, location, job_url, job_type, site, date_posted, description")
      .eq("run_id", runId);
    if (error) throw error;
    return data || [];
  }

  // Polls a run's status until it leaves "pending"/"running", calling
  // onUpdate(run) after every check. Returns a function to stop polling early.
  function pollSearchRun(runId, onUpdate, intervalMs) {
    let stopped = false;
    (async function tick() {
      while (!stopped) {
        let run;
        try {
          run = await getSearchRun(runId);
        } catch (err) {
          onUpdate(null, err);
          return;
        }
        onUpdate(run, null);
        if (run.status === "completed" || run.status === "failed") return;
        await new Promise((r) => setTimeout(r, intervalMs || 5000));
      }
    })();
    return () => { stopped = true; };
  }

  // ---------- Trigger a new scrape ----------
  // Calls a Supabase Edge Function that holds one GitHub bot token
  // server-side, so signed-in users never need a token of their own.
  async function dispatchScrape(inputs, runId) {
    const { data, error } = await supabase.functions.invoke("trigger-scrape", { body: { inputs, run_id: runId } });
    if (error) throw new Error(error.message || "Failed to trigger scrape");
    if (data && data.error) throw new Error(data.error);
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

  // ---------- Shared nav + sign-in/sign-up modal ----------
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
          <button type="button" id="navAuthBtn">${user ? "sign out" : "sign in"}</button>
        </span>
      </div>`;
    const btn = document.getElementById("navAuthBtn");
    if (btn) btn.addEventListener("click", () => (user ? logout() : openAuthModal()));
    return user;
  }

  function openAuthModal() {
    if (document.getElementById("authModalBackdrop")) return;

    let mode = "signin"; // or "signup"
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.id = "authModalBackdrop";
    backdrop.innerHTML = `
      <div class="modal">
        <h2 id="authModalTitle">Sign in</h2>
        <div class="field">
          <label for="authUsername">Username</label>
          <input type="text" id="authUsername" autocomplete="username" />
        </div>
        <div class="field" id="authEmailField" style="display:none;">
          <label for="authEmail">Email address</label>
          <input type="text" id="authEmail" autocomplete="email" placeholder="you@example.com" />
        </div>
        <div class="field" id="authPasswordField">
          <label for="authPassword">Password</label>
          <input type="password" id="authPassword" autocomplete="current-password" />
        </div>
        <p class="hint" id="authModalForgot" style="margin: 0 0 14px;">
          <button type="button" id="authForgotBtn">Forgot password?</button>
        </p>
        <p class="hint" id="authModalInfo" style="display:none;"></p>
        <p class="hint" id="authModalError" style="display:none; color: var(--danger);"></p>
        <div class="actions">
          <button type="button" id="authModalToggle">Need an account? Sign up</button>
          <span class="spacer"></span>
          <button type="button" id="authModalCancel">Cancel</button>
          <button type="button" class="primary" id="authModalSubmit">Sign in</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const title = document.getElementById("authModalTitle");
    const toggleBtn = document.getElementById("authModalToggle");
    const submitBtn = document.getElementById("authModalSubmit");
    const errorEl = document.getElementById("authModalError");
    const infoEl = document.getElementById("authModalInfo");
    const emailField = document.getElementById("authEmailField");
    const passwordField = document.getElementById("authPasswordField");
    const forgotEl = document.getElementById("authModalForgot");
    const forgotBtn = document.getElementById("authForgotBtn");
    const usernameEl = document.getElementById("authUsername");
    const emailEl = document.getElementById("authEmail");
    const passwordEl = document.getElementById("authPassword");

    function close() { backdrop.remove(); }

    function applyMode() {
      title.textContent = { signin: "Sign in", signup: "Create account", reset: "Reset password" }[mode];
      submitBtn.textContent = { signin: "Sign in", signup: "Create account", reset: "Send reset link" }[mode];
      toggleBtn.textContent = mode === "signup" ? "Have an account? Sign in" : "Need an account? Sign up";
      toggleBtn.style.display = mode === "reset" ? "none" : "inline-block";
      emailField.style.display = mode === "signup" ? "block" : "none";
      passwordField.style.display = mode === "reset" ? "none" : "block";
      forgotEl.style.display = mode === "signin" ? "block" : "none";
      errorEl.style.display = "none";
      infoEl.style.display = "none";
    }

    toggleBtn.addEventListener("click", () => { mode = mode === "signup" ? "signin" : "signup"; applyMode(); });
    document.getElementById("authModalCancel").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

    forgotBtn.addEventListener("click", () => { mode = "reset"; applyMode(); });

    submitBtn.addEventListener("click", async () => {
      errorEl.style.display = "none";
      infoEl.style.display = "none";
      submitBtn.disabled = true;
      try {
        if (mode === "signin") {
          await signIn(usernameEl.value, passwordEl.value);
          location.reload();
        } else if (mode === "signup") {
          const { needsConfirmation } = await signUp(usernameEl.value, emailEl.value, passwordEl.value);
          if (needsConfirmation) {
            const confirmMessage = `Account created! Check ${emailEl.value.trim()} for a confirmation link, then sign in.`;
            mode = "signin";
            applyMode(); // resets infoEl.style.display, so set the message after
            infoEl.textContent = confirmMessage;
            infoEl.style.display = "block";
            submitBtn.disabled = false;
          } else {
            location.reload();
          }
        } else {
          await requestPasswordReset(usernameEl.value);
          const resetMessage = "If that username has a confirmed account, a password reset link has been emailed to it.";
          mode = "signin";
          applyMode();
          infoEl.textContent = resetMessage;
          infoEl.style.display = "block";
          submitBtn.disabled = false;
        }
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = "block";
        submitBtn.disabled = false;
      }
    });

    applyMode();
    usernameEl.focus();
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  global.JobSpyApp = {
    supabase, getUser, signUp, signIn, logout, openAuthModal,
    getEmailStatus, updateContactEmail, requestPasswordReset, updatePassword,
    getSavedJobs, saveJobs, removeSavedJob,
    createSearchRun, getSearchRun, listSearchRuns, getSearchResults, pollSearchRun,
    dispatchScrape,
    parseBooleanQuery, buildPredicate, toScraperTerm,
    exportJobsToPdf, renderNav, escapeHtml,
  };
})(window);
