-- SERVISIUM 2026-10-14 · Migration 14: preparation time and delays (tasks 47–51, 57; non-breaking)
-- prep_min/max_minutes: venue data only (no defaults are invented).
-- A delay postpones a line (or every open line of an order) until delay_until, with a reason;
-- it is synced through Realtime to the venue's staff only (RLS).
alter table public.menu_items
  add column if not exists prep_min_minutes integer,
  add column if not exists prep_max_minutes integer;
alter table public.menu_items drop constraint if exists menu_items_prep_check;
alter table public.menu_items add constraint menu_items_prep_check check (
  (prep_min_minutes is null or prep_min_minutes between 0 and 600) and
  (prep_max_minutes is null or prep_max_minutes between 0 and 600) and
  (prep_min_minutes is null or prep_max_minutes is null or prep_min_minutes <= prep_max_minutes));

alter table public.order_items
  add column if not exists prep_max_minutes integer,
  add column if not exists delay_until timestamptz,
  add column if not exists delay_reason text;

-- snapshot the venue's max prep time onto each line when it is added
create or replace function private.snapshot_prep_time() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.prep_max_minutes is null then
    select coalesce(m.prep_max_minutes, m.prep_min_minutes) into new.prep_max_minutes from public.menu_items m where m.id = new.menu_item_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_snapshot_prep on public.order_items;
create trigger trg_snapshot_prep before insert on public.order_items for each row execute function private.snapshot_prep_time();

-- delay one line (p_item_id) or every unfinished line of an order (p_order_id); p_minutes = 0 clears the delay
create or replace function public.order_delay(p_order_id bigint default null, p_item_id bigint default null,
                                              p_minutes integer default 10, p_reason text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_rid bigint; n integer;
begin
  if p_item_id is not null then
    select restaurant_id into v_rid from public.order_items where id = p_item_id;
  elsif p_order_id is not null then
    select restaurant_id into v_rid from public.orders where id = p_order_id;
  end if;
  if v_rid is null then raise exception 'not_found' using errcode = '22023'; end if;
  if not private.is_member(v_rid) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_minutes < 0 or p_minutes > 600 then raise exception 'invalid_minutes' using errcode = '22023'; end if;
  if p_minutes > 0 and coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required' using errcode = '22023'; end if;

  update public.order_items set
    delay_until = case when p_minutes = 0 then null else now() + make_interval(mins => p_minutes) end,
    delay_reason = case when p_minutes = 0 then null else left(btrim(p_reason), 200) end,
    updated_at = now()
  where restaurant_id = v_rid
    and status in ('new', 'sent', 'preparing')
    and ((p_item_id is not null and id = p_item_id) or (p_item_id is null and order_id = p_order_id));
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.order_delay(bigint, bigint, integer, text) from public, anon;
grant execute on function public.order_delay(bigint, bigint, integer, text) to authenticated;

-- expose prep/delay fields to the waiter panel and the kitchen queue
create or replace function public.open_orders(p_restaurant_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id, 'table_ref', o.table_ref, 'guests', o.guests, 'guest_allergens', o.guest_allergens, 'note', o.note,
    'status', o.status, 'subtotal', o.subtotal, 'discount', o.discount, 'total', o.total, 'opened_at', o.opened_at,
    'waiter_id', o.waiter_id, 'waiter_name', w.name,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'menu_item_id', i.menu_item_id, 'name', coalesce(i.menu_name, m.name), 'qty', i.qty, 'price', i.price,
        'status', i.status, 'station', i.station, 'note', i.note, 'sent_at', i.sent_at, 'started_at', i.started_at,
        'ready_at', i.ready_at, 'cancel_reason', i.cancel_reason, 'prep_max_minutes', i.prep_max_minutes,
        'delay_until', i.delay_until, 'delay_reason', i.delay_reason) order by i.id)
      from public.order_items i left join public.menu_items m on m.id = i.menu_item_id where i.order_id = o.id), '[]'::jsonb)
  ) order by o.opened_at), '[]'::jsonb)
  from public.orders o left join public.restaurant_staff w on w.id = o.waiter_id
  where o.restaurant_id = p_restaurant_id and o.status in ('open', 'awaiting_payment')
    and private.is_member(p_restaurant_id)
    and (private.can_manage(p_restaurant_id) or private.owns_staff(o.waiter_id))
$$;

create or replace function public.kitchen_queue(p_restaurant_id bigint, p_station text default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'order_id', i.order_id, 'table_ref', o.table_ref, 'name', coalesce(i.menu_name, m.name), 'qty', i.qty,
    'status', i.status, 'station', i.station, 'note', i.note, 'sent_at', i.sent_at, 'started_at', i.started_at,
    'ready_at', i.ready_at, 'waiter_name', w.name, 'guest_allergens', o.guest_allergens,
    'prep_max_minutes', i.prep_max_minutes, 'delay_until', i.delay_until, 'delay_reason', i.delay_reason)
    order by coalesce(i.delay_until, i.sent_at), i.id), '[]'::jsonb)
  from public.order_items i
  join public.orders o on o.id = i.order_id
  left join public.menu_items m on m.id = i.menu_item_id
  left join public.restaurant_staff w on w.id = o.waiter_id
  where i.restaurant_id = p_restaurant_id and i.status in ('sent', 'preparing', 'ready')
    and (p_station is null or i.station = p_station)
    and private.is_member(p_restaurant_id)
$$;
