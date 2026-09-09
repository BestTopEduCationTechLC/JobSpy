-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query).
-- Creates the saved_jobs table and locks it down with Row Level Security so
-- each signed-in user can only ever read/write their own rows.

create table if not exists public.saved_jobs (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  job_id text not null,
  title text,
  company text,
  location text,
  job_url text,
  job_type text,
  site text,
  date_posted text,
  description text,
  saved_at timestamptz not null default now(),
  primary key (user_id, job_id)
);

alter table public.saved_jobs enable row level security;

create policy "Users can view their own saved jobs"
  on public.saved_jobs for select
  using (auth.uid() = user_id);

create policy "Users can insert their own saved jobs"
  on public.saved_jobs for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own saved jobs"
  on public.saved_jobs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own saved jobs"
  on public.saved_jobs for delete
  using (auth.uid() = user_id);
