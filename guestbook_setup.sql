-- Run this in Supabase Dashboard > SQL Editor.
-- The browser can read public entries. Only anonymous authenticated visitors
-- can insert their own single entry. No public update/delete access is granted.

create table if not exists public.guestbook_entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users (id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 24),
  message text not null check (char_length(message) between 1 and 140),
  created_at timestamptz not null default now()
);

alter table public.guestbook_entries enable row level security;

revoke all on table public.guestbook_entries from anon, authenticated;
grant select (id, nickname, message, created_at)
  on table public.guestbook_entries to anon, authenticated;
grant insert (owner_id, nickname, message)
  on table public.guestbook_entries to authenticated;

drop policy if exists "Anyone can read guestbook entries"
  on public.guestbook_entries;
create policy "Anyone can read guestbook entries"
  on public.guestbook_entries
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Anonymous visitors can add their own entry"
  on public.guestbook_entries;
create policy "Anonymous visitors can add their own entry"
  on public.guestbook_entries
  for insert
  to authenticated
  with check (
    owner_id = (select auth.uid())
    and (select (auth.jwt() ->> 'is_anonymous')::boolean) is true
  );

