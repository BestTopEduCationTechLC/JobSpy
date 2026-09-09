# JobSpy backend (Supabase)

Supabase provides everything the static site needs, with no separate server to
host:
- **Auth** — username + password, stored by Supabase (no GitHub login involved),
  with an optional real contact email a user can add and confirm afterward
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
  login keeps working even after a user later confirms a real email (step 6)

## 3. Turn off *sign-up* email confirmation

Login here is username + password, not email — under the hood each new
account is created with a synthetic address like `alice@jobspy.local` (see
`usernameToEmail()` in `docs/assets/app.js`) that nobody can actually receive
mail at. So the confirmation step for *new sign-ups* needs to be disabled, or
nobody could ever finish signing up:

Dashboard → **Authentication → Providers → Email** → turn **off** "Confirm
email". (The Email provider itself should already be enabled by default —
you don't need to touch anything else on this page.) Leave **"Secure email
change"** at its default (on) — that one's what makes step 6's real-email
confirmation actually work.

## 4. Set the Site URL / Redirect URLs

Dashboard → **Authentication → URL Configuration**:
- **Site URL**: your GitHub Pages URL (e.g.
  `https://besttopeducationtechlc.github.io/JobSpy/docs/index.html`)
- **Redirect URLs**: add that URL and `.../docs/personal.html` — the contact
  email confirmation link (step 6) redirects back to `personal.html`.

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
2. Click it, choose "Need an account? Sign up", pick a username (3-32 chars,
   letters/numbers/`.`/`_`/`-`) and a password (6+ chars). You should land
   back on the site signed in immediately (no email confirmation).
3. Select jobs, click **Save selected**, then check `personal.html` — or the
   `saved_jobs` table in the Supabase Table Editor — to confirm it persisted.
4. Click **Run New Search**. The page should show "Your search is running…"
   and, once the Actions run finishes, switch to showing that private result
   set — check `personal.html`'s "Your search history" to see it listed too.
5. On `personal.html`, add a real email under **Account** and confirm the
   link that arrives in that inbox; `emailStatus` should update to "Confirmed
   email: ...". Sign out and back in with your username/password to confirm
   login still works after the email change.

## Notes

- Usernames are case-insensitive (stored lowercased) since sign-up maps them
  into an email address, which Supabase treats case-insensitively.
- `ALLOWED_USERNAMES` is the only access control on the scrape trigger —
  anyone with an account (if left unset) can click "Run New Search", which
  consumes your bot token's Actions minutes. Since anyone can currently sign
  up for an account, consider setting this if that matters to you.
- Adding a contact email is entirely optional for users — login never
  depends on it, only on username + password.
- To see Edge Function logs: `supabase functions logs trigger-scrape`, or the
  dashboard's **Edge Functions** section. For the workflow's own logs
  (including the Supabase upload step), check the run in the repo's
  **Actions** tab.
