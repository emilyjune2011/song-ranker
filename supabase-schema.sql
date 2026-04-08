-- Run in Supabase SQL Editor after creating a project.
-- Dashboard → Authentication → Providers → enable "Anonymous" sign-ins.

create table if not exists public.song_ranker_sync (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.song_ranker_sync enable row level security;

create policy "Users manage own sync row"
  on public.song_ranker_sync
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
