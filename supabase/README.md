# JobSpy backend (Supabase)

Supabase provides everything the static site needs, with no separate server to
host:
- **Auth** — username + password, but a real email is required at sign-up and
  must be confirmed (Supabase's standard confirmation-link flow) before the
  account can log in; no GitHub login involved
- **Postgres + Row Level Security** — `saved_jobs` (each user's saved
  listings) and `search_runs`/`search_results` (each user's own private
  search history and results) — one user can never see another's rows
- **Edge Functions** — one small serverless function holds a GitHub bot
  token needed to trigger `scrape-jobs.yml`, so individual users never need
  their own token

You've already created a Supabase project and signed in — here's the rest.

## 1. Get your project's URL and anon key

Project dashboard → **Project Settings → API**. Copy:
- **Project URL** (looks like `https://xxxxxxxx.supabase.co`)
- **anon public** key (safe to expose in a public frontend — Row Level
  Security is what actually restricts access, not this key)

Paste both into `docs/assets/app.js`:

```js
const SUPABASE_URL = "https://xxxxxxxx.supabase.co";
const SUPABASE_ANON_KEY = "eyJ...";
```

## 2. Create the database tables

Dashboard → **SQL Editor → New query**. Paste the contents of
[`supabase/schema.sql`](schema.sql) and run it. This creates:
- `saved_jobs` — locked to `auth.uid() = user_id`
- `search_runs` / `search_results` — one row per "Run New Search" click plus
  that run's own results, both locked to the owning user; only a service-role
  key (never exposed to the browser) can write results or flip a run's status
- `get_login_email(username)` — a small helper function so username-based
  login can resolve to whatever the account's current confirmed email is,
  including after it's changed later (step 5's "Account" card)

## 3. Confirm email confirmation is ON

Sign-up now collects a real email address, and the account cannot log in
until that email is confirmed — this is Supabase's standard behavior and
should already be the default, but double check:

Dashboard → **Authentication → Providers → Email** → make sure "Confirm
email" is **on**. Leave **"Secure email change"** at its default (on) too —
that's what makes changing the email later (from `personal.html`'s Account
card) go through its own confirmation link rather than switching instantly.

## 4. Set the Site URL / Redirect URLs

Dashboard → **Authentication → URL Configuration**:
- **Site URL**: your GitHub Pages URL (e.g.
  `https://besttopeducationtechlc.github.io/JobSpy/docs/index.html`)
- **Redirect URLs**: add that URL, `.../docs/personal.html`, and
  `.../docs/reset-password.html` — the sign-up confirmation link redirects to
  `index.html`, an email-change confirmation redirects to `personal.html`,
  and a "forgot password" link redirects to `reset-password.html`.

## 5. Create the bot token and deploy the Edge Function

This token is what actually lets the function call `workflow_dispatch`. It
should belong to a GitHub account that's a collaborator on
`BestTopEduCationTechLC/JobSpy` with permission to run Actions. It has
nothing to do with how users log into the site — it's used purely
server-side to talk to GitHub's API.

1. https://github.com/settings/tokens → **Generate new token (classic)** →
   scope **workflow** → copy it.
2. Install the Supabase CLI if you haven't: `npm install -g supabase`.
3. From the repo root: `supabase login`, then `supabase link --project-ref xxxxxxxx`
   (project ref is the subdomain in your Project URL).
4. Set the secret:
   ```
   supabase secrets set GITHUB_BOT_TOKEN=ghp_your_token_here
   ```
   Optionally also restrict who can click "Run New Search" (these are this
   app's own usernames, not GitHub accounts):
   ```
   supabase secrets set ALLOWED_USERNAMES=alice,bob
   ```
   (leave unset to let anyone with an account on the site trigger a scrape)
5. Deploy the function:
   ```
   supabase functions deploy trigger-scrape
   ```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected into every Edge Function
automatically — you don't need to set those as secrets yourself.

## 6. Let the GitHub Actions workflow write private results

Private search runs need the workflow itself (not the Edge Function) to write
results into `search_results` and flip `search_runs.status`, using a service
role key that bypasses Row Level Security. This is a **GitHub repo secret**,
not a Supabase one:

1. Dashboard → **Project Settings → API** → copy the **service_role** key
   (this one is secret — never put it in frontend code).
2. In the GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret**, add:
   - `SUPABASE_URL` — same Project URL as step 1
   - `SUPABASE_SERVICE_ROLE_KEY` — the service_role key you just copied

Without these two secrets, a user-triggered ("Run New Search") workflow run
will fail at its "Upload private results to Supabase" step. The weekly
scheduled run and a manual run started directly from the Actions tab don't
need them at all — those still just update the shared `docs/data/jobs.json`.

## 7. Push the frontend changes

Once `docs/assets/app.js` has your real `SUPABASE_URL` / `SUPABASE_ANON_KEY`,
commit and push — GitHub Pages picks it up on the next build.

## 8. Test it

1. Visit your GitHub Pages site. Nav should show "Not signed in — sign in".
2. Click it, choose "Need an account? Sign up", and fill in a username
   (3-32 chars, letters/numbers/`.`/`_`/`-`), a real email you can check, and
   a password (6+ chars). You should see "Account created! Check ... for a
   confirmation link, then sign in" — the account cannot log in yet.
3. Open that email and click the confirmation link — it redirects back to
   `index.html`. Now go sign in with the username/password from step 2; it
   should succeed.
4. Select jobs, click **Save selected**, then check `personal.html` — or the
   `saved_jobs` table in the Supabase Table Editor — to confirm it persisted.
5. Click **Run New Search**. The page should show "Your search is running…"
   and, once the Actions run finishes, switch to showing that private result
   set — check `personal.html`'s "Your search history" to see it listed too.
6. On `personal.html`, try changing the email under **Account** to a
   different address and confirm the link that arrives there; `emailStatus`
   should update to the new address. Sign out and back in with your
   username/password to confirm login still works after the change.
7. Sign out, click **sign in**, then **Forgot password?**, enter your
   username, and submit. Open the reset email and click its link — it
   should land on `reset-password.html` and show a "New password" form
   (if it instead shows "This page only works when opened from a password
   reset email link...", the link expired or Redirect URLs isn't set up
   right). Set a new password, then sign in with it to confirm it took.

## Notes

- Usernames are case-insensitive (stored lowercased); the email tied to the
  account is whatever real address the user signed up (or later changed) to.
- `ALLOWED_USERNAMES` is the only access control on the scrape trigger —
  anyone with a confirmed account (if left unset) can click "Run New
  Search", which consumes your bot token's Actions minutes. Since anyone can
  sign up (with any real email they can access), consider setting this if
  that matters to you.
- Because sign-up requires confirming a real email, an account can't be
  fully created without access to that inbox — that's the actual gate on
  who can use the site, not the username/password by themselves.
- To see Edge Function logs: `supabase functions logs trigger-scrape`, or the
  dashboard's **Edge Functions** section. For the workflow's own logs
  (including the Supabase upload step), check the run in the repo's
  **Actions** tab.
