# Development Progress Log

This document collates the work delivered across recent development sessions
on the JobSpy-based job search web app (static `docs/` frontend on GitHub
Pages + Supabase backend + GitHub Actions / Railway scraping). Entries are
grouped by feature area; commit hashes refer to `main`.

## Search & scraping correctness

- **Quoted search terms not reaching the scraper.** `toScraperTerm()` in
  `docs/assets/app.js` only stripped surrounding quotes on tokens inside the
  `NOT` branch of the boolean-query parser, so plain and `AND`/`OR` terms kept
  literal `"` characters and were rejected by the scraper. Fixed to strip
  quotes on every token. (`7acc601`)
- **Universal Singapore location default.** Added `scraper/scrape_defaults.py`
  (`resolve_location`, `resolve_country_indeed`) so every scrape path
  (on-demand, scheduled, notebook) defaults to Singapore, and only passes a
  real `country_indeed` value when the site list includes Indeed or
  Glassdoor (the only scrapers that read it) — everything else gets
  `"worldwide"`. Wired into `scraper/JOBSCRAPPER.ipynb`,
  `scraper/run_scheduled_searches.py`, and `scraper/server.py`. (`68668d7`)
- **Location/Country boxes removed from both search forms.** `docs/index.html`
  and `docs/scheduled.html` no longer expose Location or Country
  (Indeed/Glassdoor) inputs — location resolves silently via
  `scrape_defaults.py`. (`254507f`, `3871f53`)

## Scheduled (recurring) searches

- **New feature: daily/weekly scheduled searches per account.** Added
  `docs/scheduled.html`, `scraper/run_scheduled_searches.py`, and the
  `scheduled_searches` / `scheduled_search_results` tables in
  `supabase/schema.sql` (fully separate storage from the one-off
  `saved_jobs` / `search_runs` / `search_results` tables, each gated by
  owner-only RLS). Frontend helpers added to `docs/assets/app.js`:
  `createScheduledSearch`, `listScheduledSearches`,
  `setScheduledSearchActive`, `deleteScheduledSearch`,
  `getScheduledSearchResults`. (`6ee97a3`)
- **Fix: scheduled searches never producing results.** Root-caused via live
  GitHub Actions job logs — `country_indeed=""` was being passed straight
  into `scrape_jobs()`, and `jobspy.model.Country.from_string()` rejects an
  empty string outright. (`de6ab4c`)
- **Fix: scheduled searches crashing again after the first fix.** The `None`
  fallback used to patch the above still crashed —
  `Country.from_string()` calls `.strip()` unconditionally with no
  `None`-handling. Fixed by falling back to a real country string, which
  led directly to the generalized `scrape_defaults.py` design above.
  (`230c265`)

## Visual / UI

- Replaced the sign-in/up popup modal with a dedicated `login.html` page;
  removed the now-unused `.modal` / `.modal-backdrop` CSS. (`393ebaa`,
  `df7fce5`)
- Renamed the nav brand to "Besttop Career Intelligence", switched nav/brand
  font to Roboto, then to Doppio One for the site font. (`e73f9fb`,
  `a34c20e`)
- Explored and reverted a full 9-color palette restructure of
  `docs/assets/style.css` at the user's request, restoring the original
  coral-pink/teal/indigo/gold/lime palette and its light/dark
  `prefers-color-scheme` split. (`8b900a2` → `54a7872`)
- Added a scrape-progress bar under the "Run New Search" status area in
  `docs/index.html` (`.scrapeProgress` / `.scrapeProgress-bar` in
  `style.css`, `showScrapeProgress()` in `app.js`, wired into every
  `showRunStatus()` call site), using fill `#5970E3` / outline `#59B5E3`.
  (`3f96cda`)
- Added `ERROR_CODES.txt` as a draft reference for a future 4-hex-digit
  error-code scheme (auth/saved-jobs/searches/scheduled/parsing/nav/backend/
  edge-function/workflow ranges) — reference only, nothing in the codebase
  throws or displays these codes yet. (`3f96cda`)

## Infrastructure: moving on-demand scraping to Railway

- **New service: `scraper/server.py`.** A Flask app that performs on-demand,
  per-user scrapes directly (no CSV/notebook round-trip), replacing the
  `workflow_dispatch` path in `.github/workflows/scrape-jobs.yml` for that
  specific flow. Validates a shared `X-Webhook-Secret` header, runs the
  scrape on a background thread, and writes results straight into
  `search_results` / `search_runs` in Supabase — the same tables the old
  GitHub Actions path used. (`e4b4c64`)
- Rewrote the `trigger-scrape` Supabase Edge Function
  (`supabase/functions/trigger-scrape/index.ts`) to POST to the new Railway
  service (`SCRAPER_URL` + `SCRAPER_WEBHOOK_SECRET`) instead of dispatching
  a GitHub Actions workflow run. (`e4b4c64`)
- Kept `.github/workflows/scrape-jobs.yml`'s `workflow_dispatch` trigger in
  place, documented as a manual fallback if the Railway service is ever
  down; its weekly `schedule` trigger (the shared `docs/data/jobs.json`
  dataset) is unaffected. (`e4b4c64`)
- Added a `server` Poetry dependency group (`flask`, `gunicorn`) in
  `pyproject.toml`, isolated from the `python-jobspy` package published to
  PyPI. Iterated `railway.json` from a pip/`requirements-server.txt`
  approach to a Poetry-native build (`poetry install --only main,server`)
  and start command (`poetry run gunicorn --chdir scraper ... server:app`)
  after diagnosing Railway's Railpack builder failing to detect a start
  command. (`bc61c84`, `db3f3fb`)
- Regenerated `poetry.lock` after it fell out of sync with the new
  dependency group, verified via `poetry check` and a full
  `poetry install --only main,server` + import smoke test. (`8541496`)

## Outstanding / needs follow-up

- Confirm the Railway service's deploy branch and latest deploy are healthy
  now that `main` carries the regenerated lockfile.
- Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SCRAPER_WEBHOOK_SECRET`
  in Railway's dashboard.
- Redeploy the `trigger-scrape` Edge Function and set its `SCRAPER_URL` /
  `SCRAPER_WEBHOOK_SECRET` secrets via `supabase secrets set`.
- `ERROR_CODES.txt` is reference-only — no error checking/logging has been
  implemented against it yet, by explicit request.
