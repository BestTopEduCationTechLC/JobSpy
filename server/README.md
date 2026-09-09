# JobSpy backend (Tier 2)

A small Express server providing:
- GitHub OAuth login (real per-user accounts, no tokens needed by end users)
- Server-stored saved jobs (Postgres) — works across devices, not just one browser
- A `/api/trigger-scrape` endpoint that dispatches the `scrape-jobs.yml` workflow
  using one bot token held only on the server

## 1. Create the database

You need a Postgres database reachable by your backend. Easiest path: Render's own
managed Postgres (free tier available).

1. Go to https://dashboard.render.com → **New** → **PostgreSQL**.
2. Give it a name, pick the free plan, create it.
3. Once it's up, copy its **Internal Database URL** (if backend + DB are both on
   Render) or **External Database URL** (if hosting the DB elsewhere) — this is
   your `DATABASE_URL`.

The app creates its own tables automatically on first boot (see `db.js`), so no
manual migration step is needed.

## 2. Create the GitHub OAuth App

1. Go to https://github.com/settings/developers → **OAuth Apps** → **New OAuth App**.
   (Use a personal or org account that makes sense as the app's owner — this does
   not need to be the same account as the bot token in step 3.)
2. Fill in:
   - **Application name**: anything, e.g. "JobSpy Search"
   - **Homepage URL**: your GitHub Pages URL, e.g.
     `https://besttopeducationtechlc.github.io/JobSpy`
   - **Authorization callback URL**: `https://YOUR-BACKEND-DOMAIN/auth/github/callback`
     (you'll know the exact domain once you create the Render service in step 4 —
     Render gives you a `https://<service-name>.onrender.com` URL; you can create
     the OAuth App first with a placeholder and edit the callback URL after, or
     create the Render service first and come back here)
3. Click **Register application**.
4. Copy the **Client ID**, then click **Generate a new client secret** and copy
   that too — you won't be able to see the secret again.

## 3. Create the bot token (server-side scrape trigger)

This token is what actually lets the backend call `workflow_dispatch` on your
behalf. It should belong to a GitHub account that's a collaborator on
`BestTopEduCationTechLC/JobSpy` with permission to run Actions.

1. Go to https://github.com/settings/tokens → **Generate new token (classic)**.
2. Scope: check **workflow**.
3. Copy the token — this is `GITHUB_BOT_TOKEN`. Treat it like a password; it is
   never exposed to end users, only stored as a server env var.

## 4. Deploy the backend to Render

1. Push this `server/` directory to GitHub (either as part of this repo, or its
   own repo — either works, Render just needs a repo + a root directory).
2. Go to https://dashboard.render.com → **New** → **Web Service**.
3. Connect the repo. If `server/` is a subdirectory of a larger repo, set
   **Root Directory** to `server`.
4. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free (or whatever you prefer)
5. Add the environment variables (Render → your service → **Environment**):

   | Key | Value |
   |---|---|
   | `GITHUB_CLIENT_ID` | from step 2 |
   | `GITHUB_CLIENT_SECRET` | from step 2 |
   | `GITHUB_CALLBACK_URL` | `https://<your-render-service>.onrender.com/auth/github/callback` |
   | `FRONTEND_URL` | your GitHub Pages URL, no trailing slash |
   | `SESSION_SECRET` | random string — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `GITHUB_BOT_TOKEN` | from step 3 |
   | `DATABASE_URL` | from step 1 |
   | `ALLOWED_GITHUB_LOGINS` | optional comma-separated GitHub usernames; blank allows anyone to log in |

6. Click **Create Web Service**. Render will build and deploy; watch the logs for
   `JobSpy backend listening on :10000` (or similar) to confirm it started, and
   for any "Missing required environment variable" errors if something's unset.
7. Once it's live, go back to the GitHub OAuth App (step 2) and make sure the
   **Authorization callback URL** exactly matches `GITHUB_CALLBACK_URL` above
   (including `https://` and no trailing slash).

## 5. Point the frontend at the backend

Edit `docs/assets/app.js` and set:

```js
const BACKEND_URL = "https://<your-render-service>.onrender.com";
```

Commit and push — GitHub Pages will pick it up on the next build.

## 6. Test it

1. Visit your GitHub Pages site. The nav should show "Not signed in — sign in
   with GitHub".
2. Click it, authorize the OAuth app, and you should land back on the site
   signed in.
3. Select some jobs and click **Save selected** — check the `saved_jobs` table
   in your Postgres DB, or just reload `personal.html`, to confirm it persisted.
4. Click **Run New Search** — check the repo's Actions tab for a new run.

## Notes

- Render's free tier spins down after inactivity; the first request after a
  while will be slow (~30s) while it wakes back up. That's normal.
- `ALLOWED_GITHUB_LOGINS` is the only real access control here — anyone who logs
  in (if left blank) can click "Run New Search", which consumes your bot
  token's Actions minutes. Set an allowlist if you want to restrict that.
- Session cookies are `sameSite: "lax"` and `secure: true`, which requires both
  the frontend and backend to be served over HTTPS (GitHub Pages and Render
  both are, by default).
