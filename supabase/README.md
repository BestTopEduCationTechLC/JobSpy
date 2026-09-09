# JobSpy backend (Supabase)

Supabase provides everything the static site needs, with no separate server to
host:
- **Auth** — username + password, stored by Supabase (no GitHub login involved)
- **Postgres + Row Level Security** — `saved_jobs` table, each user can only
  ever see/edit their own rows
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

## 2. Create the database table

Dashboard → **SQL Editor → New query**. Paste the contents of
[`supabase/schema.sql`](schema.sql) and run it. This creates `saved_jobs` and
locks it down so `auth.uid() = user_id` on every row — one user can never see
another's saved jobs.

## 3. Turn off email confirmation

Login here is username + password, not email — under the hood each username
is mapped to a synthetic address like `alice@jobspy.local` (see
`usernameToEmail()` in `docs/assets/app.js`) that nobody can actually receive
mail at. So the "confirm your email" step needs to be disabled, or nobody
could ever finish signing up:

Dashboard → **Authentication → Providers → Email** → turn **off** "Confirm
email". (The Email provider itself should already be enabled by default —
you don't need to touch anything else on this page.)

## 4. Create the bot token and deploy the Edge Function

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

## 5. Push the frontend changes

Once `docs/assets/app.js` has your real `SUPABASE_URL` / `SUPABASE_ANON_KEY`,
commit and push — GitHub Pages picks it up on the next build.

## 6. Test it

1. Visit your GitHub Pages site. Nav should show "Not signed in — sign in".
2. Click it, choose "Need an account? Sign up", pick a username (3-32 chars,
   letters/numbers/`.`/`_`/`-`) and a password (6+ chars). You should land
   back on the site signed in immediately (no email confirmation).
3. Select jobs, click **Save selected**, then check `personal.html` — or the
   `saved_jobs` table in the Supabase Table Editor — to confirm it persisted.
4. Click **Run New Search** — check the repo's Actions tab for a new run.
5. Reload the page and sign in again with the same username/password to
   confirm login (not just signup) works.

## Notes

- Usernames are case-insensitive (stored lowercased) since they're mapped
  straight into an email address, which Supabase treats case-insensitively.
- `ALLOWED_USERNAMES` is the only access control on the scrape trigger —
  anyone with an account (if left unset) can click "Run New Search", which
  consumes your bot token's Actions minutes. Since anyone can currently sign
  up for an account, consider setting this if that matters to you.
- To see Edge Function logs: `supabase functions logs trigger-scrape`, or the
  dashboard's **Edge Functions** section.
