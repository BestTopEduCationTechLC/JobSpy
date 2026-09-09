const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  username TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saved_jobs (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  title TEXT,
  company TEXT,
  location TEXT,
  job_url TEXT,
  job_type TEXT,
  site TEXT,
  date_posted TEXT,
  description TEXT,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, job_id)
);
`;

async function migrate() {
  await pool.query(SCHEMA);
}

async function upsertUser(user) {
  await pool.query(
    `INSERT INTO users (id, username, avatar_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET username = $2, avatar_url = $3`,
    [user.id, user.username, user.avatar_url]
  );
}

async function listSavedJobs(userId) {
  const { rows } = await pool.query(
    `SELECT job_id AS id, title, company, location, job_url, job_type, site, date_posted, description
     FROM saved_jobs WHERE user_id = $1 ORDER BY saved_at DESC`,
    [userId]
  );
  return rows;
}

async function saveJobs(userId, jobs) {
  for (const job of jobs) {
    await pool.query(
      `INSERT INTO saved_jobs (user_id, job_id, title, company, location, job_url, job_type, site, date_posted, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, job_id) DO UPDATE SET
         title = $3, company = $4, location = $5, job_url = $6,
         job_type = $7, site = $8, date_posted = $9, description = $10`,
      [
        userId, job.id, job.title || null, job.company || null, job.location || null,
        job.job_url || null, job.job_type || null, job.site || null,
        job.date_posted || null, job.description || null,
      ]
    );
  }
}

async function removeSavedJob(userId, jobId) {
  await pool.query(`DELETE FROM saved_jobs WHERE user_id = $1 AND job_id = $2`, [userId, jobId]);
}

module.exports = { pool, migrate, upsertUser, listSavedJobs, saveJobs, removeSavedJob };
