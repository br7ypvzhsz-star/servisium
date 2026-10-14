-- SERVISIUM 2026-10-14 · Migration 21: hall history analytics (task 46) + waiter reminders (task 51)

-- ---------- 46: peak hours, table turnover, guests per table, seating duration (closed receipts only) ----------
create or replace function public.hall_history_stats(p_restaurant_id bigint, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  with o as (
    select *, extract(epoch from (closed_at - opened_at)) / 60 minutes
    from public.orders
    where restaurant_id = p_restaurant_id and status = 'closed' and closed_at >= p_from and closed_at < p_to and table_ref is not null
  ), tz as (select coalesce((select timezone from public.restaurants where id = p_restaurant_id), 'Europe/Kyiv') tz)
  select case when not private.can_manage(p_restaurant_id) then null else jsonb_build_object(
    'receipts', (select count(*) from o),
    'tables_used', (select count(distinct table_ref) from o),
    'turnover_per_table', (select round(count(*)::numeric / nullif(count(distinct table_ref), 0), 2) from o),
    'avg_guests_per_table', (select round(avg(guests), 2) from o where guests > 0),
    'avg_seating_minutes', (select round(avg(minutes)) from o where minutes between 1 and 720),
    'peak_hours', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'receipts', n, 'guests', g, 'turnover', s) order by h)
                  from (select extract(hour from (opened_at at time zone (select tz from tz)))::int h, count(*) n, coalesce(sum(guests), 0) g, sum(total) s
                        from o group by 1) x), '[]'::jsonb),
    'by_weekday', coalesce((select jsonb_agg(jsonb_build_object('dow', d, 'receipts', n, 'turnover', s) order by d)
                  from (select extract(isodow from (opened_at at time zone (select tz from tz)))::int d, count(*) n, sum(total) s from o group by 1) y), '[]'::jsonb),
    'top_tables', coalesce((select jsonb_agg(jsonb_build_object('table_ref', table_ref, 'receipts', n, 'turnover', s) order by n desc)
                  from (select table_ref, count(*) n, sum(total) s from o group by 1 order by 2 desc limit 10) z), '[]'::jsonb)
  ) end
$$;
revoke execute on function public.hall_history_stats(bigint, timestamptz, timestamptz) from public, anon;
grant execute on function public.hall_history_stats(bigint, timestamptz, timestamptz) to authenticated;

-- ---------- 51: personal reminders ----------
create table if not exists public.staff_reminders (
  id bigint generated always as identity primary key,
  restaurant_id bigint not null references public.restaurants(id) on delete cascade,
  staff_id bigint not null references public.restaurant_staff(id) on delete cascade,
  table_ref text,
  order_id bigint references public.orders(id) on delete set null,
  text text not null check (length(btrim(text)) between 1 and 200),
  due_at timestamptz not null,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists staff_reminders_due_idx on public.staff_reminders (staff_id, due_at) where done_at is null;
alter table public.staff_reminders enable row level security;
drop policy if exists staff_reminders_own on public.staff_reminders;
create policy staff_reminders_own on public.staff_reminders for select to authenticated using (private.owns_staff(staff_id));
grant select on public.staff_reminders to authenticated;
grant all on public.staff_reminders to service_role;

create or replace function public.reminder_create(p_restaurant_id bigint, p_minutes integer, p_text text, p_table_ref text default null, p_order_id bigint default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_staff bigint := private.my_staff_id(p_restaurant_id); v_id bigint;
begin
  if v_staff is null then raise exception 'invalid_waiter' using errcode = '22023'; end if;
  if p_minutes < 1 or p_minutes > 720 then raise exception 'invalid_minutes' using errcode = '22023'; end if;
  insert into public.staff_reminders (restaurant_id, staff_id, table_ref, order_id, text, due_at)
  values (p_restaurant_id, v_staff, nullif(p_table_ref, ''), p_order_id, left(btrim(p_text), 200), now() + make_interval(mins => p_minutes))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.reminder_done(p_id bigint) returns void
language sql security definer set search_path = '' as $$
  update public.staff_reminders set done_at = now() where id = p_id and private.owns_staff(staff_id) and done_at is null
$$;

create or replace function public.my_reminders(p_restaurant_id bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'table_ref', table_ref, 'order_id', order_id, 'text', text, 'due_at', due_at) order by due_at), '[]'::jsonb)
  from public.staff_reminders where restaurant_id = p_restaurant_id and staff_id = private.my_staff_id(p_restaurant_id) and done_at is null
$$;

revoke execute on function public.reminder_create(bigint, integer, text, text, bigint) from public, anon;
revoke execute on function public.reminder_done(bigint) from public, anon;
revoke execute on function public.my_reminders(bigint) from public, anon;
grant execute on function public.reminder_create(bigint, integer, text, text, bigint) to authenticated;
grant execute on function public.reminder_done(bigint) to authenticated;
grant execute on function public.my_reminders(bigint) to authenticated;
