-- SERVISIUM 2026-10-14 · Migration 18: real-time seating analytics (tasks 44–45)
-- From the venue's digital hall (hall_configs.config.tables: id, number, capacity, floorId, zoneId)
-- and live statuses (hall_table_status). A table without a status row is «available».
create or replace function public.hall_stats(p_restaurant_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  with t as (
    select x->>'id' id, x->>'number' number, greatest(coalesce((x->>'capacity')::int, 0), 0) capacity,
           x->>'floorId' floor_id, x->>'zoneId' zone_id
    from public.hall_configs c, jsonb_array_elements(coalesce(c.config->'tables', '[]'::jsonb)) x
    where c.restaurant_id = p_restaurant_id
  ), s as (
    select t.*, coalesce(st.status, 'available') status, coalesce(st.guests, 0) guests
    from t left join public.hall_table_status st on st.restaurant_id = p_restaurant_id and st.table_id = t.id
  )
  select case when not private.is_member(p_restaurant_id) then null else jsonb_build_object(
    'tables_total', (select count(*) from s),
    'seats_total', (select coalesce(sum(capacity), 0) from s),
    'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from s group by 1) z), '{}'::jsonb),
    'guests_now', (select coalesce(sum(guests), 0) from s where status in ('busy', 'partial', 'awaiting_payment')),
    'seats_occupied', (select coalesce(sum(case when status = 'partial' then least(guests, capacity) else capacity end), 0)
                       from s where status in ('busy', 'partial', 'awaiting_payment')),
    'seats_free', (select coalesce(sum(capacity), 0) from s where status = 'available'),
    'seats_reserved', (select coalesce(sum(capacity), 0) from s where status = 'reserved'),
    'seats_blocked', (select coalesce(sum(capacity), 0) from s where status in ('blocked', 'cleaning')),
    'free_tables', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'number', number, 'capacity', capacity) order by capacity desc, number)
                             from s where status = 'available'), '[]'::jsonb),
    'max_free_table', (select max(capacity) from s where status = 'available')
  ) end
$$;
revoke execute on function public.hall_stats(bigint) from public, anon;
grant execute on function public.hall_stats(bigint) to authenticated;
