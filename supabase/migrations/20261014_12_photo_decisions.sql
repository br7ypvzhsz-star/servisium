-- SERVISIUM 2026-10-14 · Migration 12: Photo Engine decision log (task 2, T030; non-breaking)
-- One row per item per run: what was decided, from which source, with what confidence and why.
create table if not exists public.photo_decisions (
  id bigint generated always as identity primary key,
  restaurant_id bigint not null references public.restaurants(id) on delete cascade,
  run_id uuid not null,
  item_name text not null,
  source_id text,
  item_type text,
  status text not null check (status in ('accepted', 'not_found', 'skipped_non_alcohol', 'storage_failed')),
  photo_url text,
  photo_source text,
  engine_source text,
  confidence numeric,
  vision_checked boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists photo_decisions_rest_idx on public.photo_decisions (restaurant_id, created_at desc);
create index if not exists photo_decisions_item_idx on public.photo_decisions (restaurant_id, source_id);
alter table public.photo_decisions enable row level security;
drop policy if exists photo_decisions_read on public.photo_decisions;
create policy photo_decisions_read on public.photo_decisions for select to authenticated using (private.can_manage(restaurant_id));
grant select on public.photo_decisions to authenticated;
grant all on public.photo_decisions to service_role;
