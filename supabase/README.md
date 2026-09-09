# JobSpy backend (Supabase)

Supabase provides everything the static site needs, with no separate server to
host:
- **Auth** — GitHub login, hosted by Supabase (no custom OAuth server needed)
- **Postgres + Row Level Security** — `saved_jobs` table, each user can only
  ever see/edit their own rows
- **Edge Functions** — one small serverless function holds the GitHub bot
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

## 3. Enable GitHub login

Supabase needs its own GitHub OAuth App to issue logins (separate from the
bot token in step 4 — this one only identifies who's logging in, it has no
special repo permissions).

1. Dashboard → **Authentication → Providers → GitHub** → toggle it on. This
   page shows you the **Callback URL** to use (something like
   `https://xxxxxxxx.supabase.co/auth/v1/callback`) — copy it.
2. In a new tab, go to https://github.com/settings/developers → **OAuth
   Apps → New OAuth App**:
   - **Homepage URL**: your GitHub Pages URL
   - **Authorization callback URL**: paste the Supabase callback URL from
     step 1, exactly
3. Register the app, generate a client secret, and copy both the **Client
   ID** and **Client Secret** back into the Supabase GitHub provider form.
   Save.
4. Dashboard → **Authentication → URL Configuration**:
   - **Site URL**: your GitHub Pages URL (e.g.
     `https://besttopeducationtechlc.github.io/JobSpy/docs/index.html`)
   - **Redirect URLs**: add the same URL (and `.../docs/personal.html` /
     `.../docs/contact.html` if you want redirects to land there too)

## 4. Create the bot token and deploy the Edge Function

This token is what actually lets the function call `workflow_dispatch`. It
should belong to a GitHub account that's a collaborator on
`BestTopEduCationTechLC/JobSpy` with permission to run Actions.

1. https://github.com/settings/tokens → **Generate new token (classic)** →
   scope **workflow** → copy it.
2. Install the Supabase CLI if you haven't: `npm install -g supabase`.
3. From the repo root: `supabase login`, then `supabase link --project-ref xxxxxxxx`
   (project ref is the subdomain in your Project URL).
4. Set the secret:
   ```
   supabase secrets set GITHUB_BOT_TOKEN=ghp_your_token_here
   ```
   Optionally also restrict who can click "Run New Search":
   ```
   supabase secrets set ALLOWED_GITHUB_LOGINS=your-github-username,teammate-username
   ```
   (leave unset to let anyone who's logged in trigger a scrape)
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

1. Visit your GitHub Pages site. Nav should show "Not signed in — sign in
   with GitHub".
2. Click it, authorize, and you should land back on the site signed in.
3. Select jobs, click **Save selected**, then check `personal.html` — or the
   `saved_jobs` table in the Supabase Table Editor — to confirm it persisted.
4. Click **Run New Search** — check the repo's Actions tab for a new run.

## Notes

- If sign-in redirects but the nav still says "Not signed in", double-check
  the **Redirect URLs** in step 3 exactly match the page URL you're testing
  from (including `http` vs `https` and any trailing path).
- `ALLOWED_GITHUB_LOGINS` is the only access control on the scrape trigger —
  anyone who signs in (if left unset) can click "Run New Search", which
  consumes your bot token's Actions minutes.
- To see Edge Function logs: `supabase functions logs trigger-scrape`, or the
  dashboard's **Edge Functions** section.
