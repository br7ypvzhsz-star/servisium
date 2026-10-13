-- SERVISIUM 2026-10-14 · Migration 08: real order lifecycle (tasks 64, 53–56, 10; T039–T046). Non-breaking:
-- create_order (one-shot closed receipt) keeps working and now also gets a receipt number.
--
-- orders:      open → awaiting_payment → closed | cancelled   (table_ref = hall table id, text)
-- order_items: new → sent → preparing → ready → served | cancelled   (station kitchen|bar from menu type)
-- Every write goes through SECURITY DEFINER functions that check venue membership and waiter ownership;
-- prices are snapshotted server-side, stop list is enforced server-side.

-- ---------- columns ----------
alter table public.orders
  add column if not exists table_ref text,
  add column if not exists guests integer,
  add column if not exists guest_allergens text[] not null default '{}',
  add column if not exists note text,
  add column if not exists subtotal numeric not null default 0,
  add column if not exists discount numeric not null default 0,
  add column if not exists payment_method text,
  add column if not exists receipt_no bigint,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists bill_requested_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists closed_by uuid;

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('open', 'awaiting_payment', 'closed', 'cancelled'));
alter table public.orders drop constraint if exists orders_payment_method_check;
alter table public.orders add constraint orders_payment_method_check
  check (payment_method is null or payment_method in ('cash', 'card', 'other'));
alter table public.orders drop constraint if exists orders_discount_check;
alter table public.orders add constraint orders_discount_check check (discount >= 0);
alter table public.orders drop constraint if exists orders_guest_allergens_check;
alter table public.orders add constraint orders_guest_allergens_check
  check (guest_allergens <@ array['milk','eggs','gluten','peanuts','tree_nuts','fish','crustaceans','molluscs',
                                  'soy','celery','mustard','sesame','sulphites','lupin']::text[]);
create unique index if not exists orders_receipt_no_uq on public.orders (restaurant_id, receipt_no) where receipt_no is not null;
create index if not exists orders_open_table_idx on public.orders (restaurant_id, table_ref) where status in ('open', 'awaiting_payment');

alter table public.order_items
  add column if not exists status text not null default 'new',
  add column if not exists station text,
  add column if not exists note text,
  add column if not exists menu_name text,
  add column if not exists sent_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists ready_at timestamptz,
  add column if not exists served_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists updated_at timestamptz not null default now();

-- one-shot receipts created before this migration are already served
update public.order_items set status = 'served' where status = 'new' and order_id in (select id from public.orders where status = 'closed');

alter table public.order_items drop constraint if exists order_items_status_check;
alter table public.order_items add constraint order_items_status_check
  check (status in ('new', 'sent', 'preparing', 'ready', 'served', 'cancelled'));
alter table public.order_items drop constraint if exists order_items_station_check;
alter table public.order_items add constraint order_items_station_check
  check (station is null or station in ('kitchen', 'bar'));
create index if not exists order_items_queue_idx on public.order_items (restaurant_id, status) where status in ('sent', 'preparing', 'ready');
create index if not exists order_items_order_idx on public.order_items (order_id);

-- ---------- receipt numbers (per venue, gap-free under concurrency) ----------
create table if not exists private.receipt_counters (restaurant_id bigint primary key, last_no bigint not null default 0);
alter table private.receipt_counters enable row level security;

create or replace function private.next_receipt_no(rid bigint) returns bigint
language sql security definer set search_path = '' as $$
  insert into private.receipt_counters as rc (restaurant_id, last_no) values (rid, 1)
  on conflict (restaurant_id) do update set last_no = rc.last_no + 1
  returning last_no
$$;

-- ---------- helpers ----------
create or replace function private.order_for_write(p_order_id bigint) returns public.orders
language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found' using errcode = '22023'; end if;
  if not private.is_member(o.restaurant_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not (private.owns_staff(o.waiter_id) or private.can_manage(o.restaurant_id)) then
    raise exception 'forbidden_waiter' using errcode = '42501';
  end if;
  if not private.tenant_writable(o.restaurant_id) then raise exception 'subscription_inactive' using errcode = '42501'; end if;
  return o;
end $$;

create or replace function private.order_recalc(p_order_id bigint) returns void
language sql security definer set search_path = '' as $$
  update public.orders o set
    subtotal = s.sub,
    total = greatest(s.sub - o.discount, 0),
    updated_at = now()
  from (select coalesce(sum(qty * price), 0) sub from public.order_items
        where order_id = p_order_id and status <> 'cancelled') s
  where o.id = p_order_id
$$;

create or replace function private.set_table_status(p_restaurant_id bigint, p_table_ref text, p_status text, p_guests integer default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.hall_table_status (restaurant_id, table_id, status, guests, updated_at)
  select p_restaurant_id, p_table_ref, p_status, p_guests, now()
  where p_table_ref is not null and p_table_ref <> ''
  on conflict (restaurant_id, table_id) do update
    set status = excluded.status, guests = coalesce(excluded.guests, public.hall_table_status.guests), updated_at = now()
$$;

-- ---------- order API ----------
-- Opens (or returns the already open) order of a table.
create or replace function public.order_open(p_restaurant_id bigint, p_table_ref text, p_guests integer default null,
                                             p_guest_allergens text[] default '{}', p_waiter_id bigint default null, p_note text default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_waiter bigint; v_id bigint;
begin
  if not private.is_member(p_restaurant_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.tenant_writable(p_restaurant_id) then raise exception 'subscription_inactive' using errcode = '42501'; end if;
  if p_guests is not null and (p_guests < 0 or p_guests > 200) then raise exception 'invalid_guests' using errcode = '22023'; end if;

  if p_table_ref is not null and p_table_ref <> '' then
    select id into v_id from public.orders
    where restaurant_id = p_restaurant_id and table_ref = p_table_ref and status in ('open', 'awaiting_payment')
    order by id limit 1;
    if v_id is not null then return v_id; end if;
  end if;

  if p_waiter_id is not null and private.can_manage(p_restaurant_id) then
    v_waiter := p_waiter_id;
  else
    select s.id into v_waiter from public.restaurant_staff s
    where s.restaurant_id = p_restaurant_id and s.auth_user_id = (select auth.uid()) and s.status = 'active'
    order by s.id limit 1;
  end if;
  if v_waiter is null or not exists (select 1 from public.restaurant_staff w where w.id = v_waiter
                                     and w.restaurant_id = p_restaurant_id and w.status = 'active') then
    raise exception 'invalid_waiter' using errcode = '22023';
  end if;

  insert into public.orders (restaurant_id, waiter_id, table_ref, guests, guest_allergens, note, status, opened_at, total, subtotal)
  values (p_restaurant_id, v_waiter, nullif(p_table_ref, ''), p_guests, coalesce(p_guest_allergens, '{}'), p_note, 'open', now(), 0, 0)
  returning id into v_id;

  perform private.set_table_status(p_restaurant_id, p_table_ref, 'busy', p_guests);
  return v_id;
end $$;

create or replace function public.order_update_meta(p_order_id bigint, p_guests integer default null,
                                                    p_guest_allergens text[] default null, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  o := private.order_for_write(p_order_id);
  if o.status not in ('open', 'awaiting_payment') then raise exception 'order_closed' using errcode = '22023'; end if;
  update public.orders set
    guests = coalesce(p_guests, guests),
    guest_allergens = coalesce(p_guest_allergens, guest_allergens),
    note = coalesce(p_note, note),
    updated_at = now()
  where id = p_order_id;
  if p_guests is not null then perform private.set_table_status(o.restaurant_id, o.table_ref, 'busy', p_guests); end if;
end $$;

-- p_items: [{"menu_item_id": 1, "qty": 2, "note": "без цибулі"}]
create or replace function public.order_add_items(p_order_id bigint, p_items jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare o public.orders; n integer;
begin
  o := private.order_for_write(p_order_id);
  if o.status <> 'open' then raise exception 'order_not_open' using errcode = '22023'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'empty_items' using errcode = '22023'; end if;

  if exists (select 1 from jsonb_array_elements(p_items) x
             where coalesce((x->>'qty')::numeric, 0) <= 0 or (x->>'qty')::numeric > 1000) then
    raise exception 'invalid_qty' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) x
             left join public.menu_items m on m.id = (x->>'menu_item_id')::bigint and m.restaurant_id = o.restaurant_id
             where m.id is null) then
    raise exception 'unknown_item' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) x
             join public.stop_list s on s.menu_item_id = (x->>'menu_item_id')::bigint
              and s.restaurant_id = o.restaurant_id and s.status = 'active') then
    raise exception 'item_stopped' using errcode = '22023';
  end if;

  insert into public.order_items (order_id, restaurant_id, menu_item_id, qty, quantity, price, unit_price, total,
                                  waiter_id, status, station, note, menu_name)
  select o.id, o.restaurant_id, m.id, (x->>'qty')::numeric, (x->>'qty')::numeric, coalesce(m.price, 0), coalesce(m.price, 0),
         (x->>'qty')::numeric * coalesce(m.price, 0), o.waiter_id, 'new',
         case when m.type = 'Бар' then 'bar' else 'kitchen' end,
         nullif(left(btrim(coalesce(x->>'note', '')), 300), ''), m.name
  from jsonb_array_elements(p_items) x
  join public.menu_items m on m.id = (x->>'menu_item_id')::bigint and m.restaurant_id = o.restaurant_id;
  get diagnostics n = row_count;

  perform private.order_recalc(o.id);
  return n;
end $$;

-- qty 0 cancels; only lines not yet sent can change quantity
create or replace function public.order_update_item(p_item_id bigint, p_qty numeric default null, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare it public.order_items; o public.orders;
begin
  select * into it from public.order_items where id = p_item_id;
  if not found then raise exception 'item_not_found' using errcode = '22023'; end if;
  o := private.order_for_write(it.order_id);
  if o.status <> 'open' then raise exception 'order_not_open' using errcode = '22023'; end if;
  if p_qty is not null then
    if it.status <> 'new' then raise exception 'item_already_sent' using errcode = '22023'; end if;
    if p_qty < 0 or p_qty > 1000 then raise exception 'invalid_qty' using errcode = '22023'; end if;
    if p_qty = 0 then
      update public.order_items set status = 'cancelled', cancelled_at = now(), cancel_reason = 'removed', updated_at = now() where id = p_item_id;
    else
      update public.order_items set qty = p_qty, quantity = p_qty, total = p_qty * price, updated_at = now() where id = p_item_id;
    end if;
  end if;
  if p_note is not null then
    update public.order_items set note = nullif(left(btrim(p_note), 300), ''), updated_at = now() where id = p_item_id;
  end if;
  perform private.order_recalc(o.id);
end $$;

-- cancelling a line already sent to kitchen/bar needs a reason (audit_log keeps who/when)
create or replace function public.order_cancel_item(p_item_id bigint, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare it public.order_items; o public.orders;
begin
  select * into it from public.order_items where id = p_item_id;
  if not found then raise exception 'item_not_found' using errcode = '22023'; end if;
  o := private.order_for_write(it.order_id);
  if o.status not in ('open', 'awaiting_payment') then raise exception 'order_closed' using errcode = '22023'; end if;
  if it.status in ('served', 'cancelled') then raise exception 'item_final' using errcode = '22023'; end if;
  if it.status <> 'new' and coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required' using errcode = '22023'; end if;
  update public.order_items set status = 'cancelled', cancelled_at = now(), cancel_reason = coalesce(nullif(btrim(p_reason), ''), 'removed'),
         updated_at = now() where id = p_item_id;
  perform private.order_recalc(o.id);
end $$;

create or replace function public.order_send(p_order_id bigint)
returns integer language plpgsql security definer set search_path = '' as $$
declare o public.orders; n integer;
begin
  o := private.order_for_write(p_order_id);
  if o.status <> 'open' then raise exception 'order_not_open' using errcode = '22023'; end if;
  update public.order_items set status = 'sent', sent_at = now(), updated_at = now()
  where order_id = p_order_id and status = 'new';
  get diagnostics n = row_count;
  return n;
end $$;

-- kitchen / bar / waiter: sent → preparing → ready → served (any staff member of the venue)
create or replace function public.order_item_set_status(p_item_id bigint, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare it public.order_items;
begin
  select * into it from public.order_items where id = p_item_id for update;
  if not found then raise exception 'item_not_found' using errcode = '22023'; end if;
  if not private.is_member(it.restaurant_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not (
       (it.status = 'sent' and p_status = 'preparing') or
       (it.status in ('sent', 'preparing') and p_status = 'ready') or
       (it.status in ('ready', 'preparing', 'sent') and p_status = 'served') or
       (it.status = 'ready' and p_status = 'preparing')) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  update public.order_items set
    status = p_status,
    started_at = case when p_status = 'preparing' then coalesce(started_at, now()) else started_at end,
    ready_at = case when p_status = 'ready' then now() else ready_at end,
    served_at = case when p_status = 'served' then now() else served_at end,
    updated_at = now()
  where id = p_item_id;
end $$;

create or replace function public.order_request_bill(p_order_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  o := private.order_for_write(p_order_id);
  if o.status <> 'open' then raise exception 'order_not_open' using errcode = '22023'; end if;
  update public.orders set status = 'awaiting_payment', bill_requested_at = now(), updated_at = now() where id = p_order_id;
  perform private.set_table_status(o.restaurant_id, o.table_ref, 'awaiting_payment');
end $$;

create or replace function public.order_reopen(p_order_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  o := private.order_for_write(p_order_id);
  if o.status <> 'awaiting_payment' then raise exception 'order_not_awaiting' using errcode = '22023'; end if;
  update public.orders set status = 'open', updated_at = now() where id = p_order_id;
  perform private.set_table_status(o.restaurant_id, o.table_ref, 'busy');
end $$;

-- closes the receipt: number, payment method, discount (≤ subtotal); unserved lines must be served or cancelled first
create or replace function public.order_close(p_order_id bigint, p_payment_method text, p_discount numeric default 0)
returns table(receipt_no bigint, total numeric) language plpgsql security definer set search_path = '' as $$
declare o public.orders; v_no bigint; v_total numeric;
begin
  o := private.order_for_write(p_order_id);
  if o.status not in ('open', 'awaiting_payment') then raise exception 'order_closed' using errcode = '22023'; end if;
  if p_payment_method not in ('cash', 'card', 'other') then raise exception 'invalid_payment' using errcode = '22023'; end if;
  if coalesce(p_discount, 0) < 0 then raise exception 'invalid_discount' using errcode = '22023'; end if;
  if coalesce(p_discount, 0) > 0 and not private.can_manage(o.restaurant_id) then raise exception 'discount_forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.order_items where order_id = p_order_id and status <> 'cancelled') then
    raise exception 'empty_order' using errcode = '22023';
  end if;
  if exists (select 1 from public.order_items where order_id = p_order_id and status = 'new') then
    raise exception 'unsent_items' using errcode = '22023';
  end if;

  update public.order_items set status = 'served', served_at = coalesce(served_at, now()), updated_at = now()
  where order_id = p_order_id and status in ('sent', 'preparing', 'ready');

  update public.orders set discount = coalesce(p_discount, 0) where id = p_order_id;
  perform private.order_recalc(p_order_id);
  if (select discount > subtotal from public.orders where id = p_order_id) then raise exception 'invalid_discount' using errcode = '22023'; end if;

  v_no := private.next_receipt_no(o.restaurant_id);
  update public.orders set status = 'closed', closed_at = now(), closed_by = (select auth.uid()),
         payment_method = p_payment_method, receipt_no = v_no, updated_at = now()
  where id = p_order_id returning orders.total into v_total;

  if not exists (select 1 from public.orders where restaurant_id = o.restaurant_id and table_ref = o.table_ref
                 and status in ('open', 'awaiting_payment')) then
    perform private.set_table_status(o.restaurant_id, o.table_ref, 'cleaning', 0);
  end if;
  return query select v_no, v_total;
end $$;

-- cancelling a whole order: managers only, with a reason
create or replace function public.order_cancel(p_order_id bigint, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  o := private.order_for_write(p_order_id);
  if not private.can_manage(o.restaurant_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if o.status not in ('open', 'awaiting_payment') then raise exception 'order_closed' using errcode = '22023'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required' using errcode = '22023'; end if;
  update public.order_items set status = 'cancelled', cancelled_at = now(), cancel_reason = coalesce(cancel_reason, p_reason), updated_at = now()
  where order_id = p_order_id and status <> 'served';
  update public.orders set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason, updated_at = now() where id = p_order_id;
  perform private.order_recalc(p_order_id);
  if not exists (select 1 from public.orders where restaurant_id = o.restaurant_id and table_ref = o.table_ref
                 and status in ('open', 'awaiting_payment')) then
    perform private.set_table_status(o.restaurant_id, o.table_ref, 'available', 0);
  end if;
end $$;

-- the waiter's open orders + every venue order for managers (RLS on orders already limits SELECT the same way)
create or replace function public.open_orders(p_restaurant_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id, 'table_ref', o.table_ref, 'guests', o.guests, 'guest_allergens', o.guest_allergens, 'note', o.note,
    'status', o.status, 'subtotal', o.subtotal, 'discount', o.discount, 'total', o.total, 'opened_at', o.opened_at,
    'waiter_id', o.waiter_id, 'waiter_name', w.name,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'menu_item_id', i.menu_item_id, 'name', coalesce(i.menu_name, m.name), 'qty', i.qty, 'price', i.price,
        'status', i.status, 'station', i.station, 'note', i.note, 'sent_at', i.sent_at, 'ready_at', i.ready_at,
        'cancel_reason', i.cancel_reason) order by i.id)
      from public.order_items i left join public.menu_items m on m.id = i.menu_item_id where i.order_id = o.id), '[]'::jsonb)
  ) order by o.opened_at), '[]'::jsonb)
  from public.orders o left join public.restaurant_staff w on w.id = o.waiter_id
  where o.restaurant_id = p_restaurant_id and o.status in ('open', 'awaiting_payment')
    and private.is_member(p_restaurant_id)
    and (private.can_manage(p_restaurant_id) or private.owns_staff(o.waiter_id))
$$;

-- kitchen / bar queue: every staff member of the venue sees what has to be cooked/poured
create or replace function public.kitchen_queue(p_restaurant_id bigint, p_station text default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'order_id', i.order_id, 'table_ref', o.table_ref, 'name', coalesce(i.menu_name, m.name), 'qty', i.qty,
    'status', i.status, 'station', i.station, 'note', i.note, 'sent_at', i.sent_at, 'started_at', i.started_at,
    'ready_at', i.ready_at, 'waiter_name', w.name, 'guest_allergens', o.guest_allergens) order by i.sent_at, i.id), '[]'::jsonb)
  from public.order_items i
  join public.orders o on o.id = i.order_id
  left join public.menu_items m on m.id = i.menu_item_id
  left join public.restaurant_staff w on w.id = o.waiter_id
  where i.restaurant_id = p_restaurant_id and i.status in ('sent', 'preparing', 'ready')
    and (p_station is null or i.station = p_station)
    and private.is_member(p_restaurant_id)
$$;

-- one-shot receipt (existing UI) now also gets a receipt number and subtotal
create or replace function public.create_order(p_restaurant_id bigint, p_waiter_id bigint, p_items jsonb)
returns table(order_id bigint, total numeric) language plpgsql security definer set search_path = '' as $$
declare oid bigint; tot numeric := 0;
begin
  if not private.is_member(p_restaurant_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.tenant_writable(p_restaurant_id) then raise exception 'subscription_inactive' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'empty_order' using errcode = '22023'; end if;
  if not exists (select 1 from public.restaurant_staff w where w.id = p_waiter_id and w.restaurant_id = p_restaurant_id and w.status = 'active') then
    raise exception 'invalid_waiter' using errcode = '22023';
  end if;
  if not private.owns_staff(p_waiter_id) and not private.can_manage(p_restaurant_id) then
    raise exception 'forbidden_waiter' using errcode = '42501';
  end if;

  create temporary table _lines on commit drop as
  select (x->>'menu_item_id')::bigint as menu_item_id, sum((x->>'qty')::numeric) as qty
  from jsonb_array_elements(p_items) x group by 1;

  if exists (select 1 from _lines where qty <= 0 or qty > 1000) then raise exception 'invalid_qty' using errcode = '22023'; end if;
  if exists (select 1 from _lines l left join public.menu_items m on m.id = l.menu_item_id and m.restaurant_id = p_restaurant_id
             where m.id is null) then raise exception 'unknown_item' using errcode = '22023'; end if;
  if exists (select 1 from _lines l join public.stop_list s on s.menu_item_id = l.menu_item_id
             and s.restaurant_id = p_restaurant_id and s.status = 'active') then raise exception 'item_stopped' using errcode = '22023'; end if;

  select coalesce(sum(l.qty * coalesce(m.price, 0)), 0) into tot
  from _lines l join public.menu_items m on m.id = l.menu_item_id;

  insert into public.orders(restaurant_id, waiter_id, total, subtotal, status, opened_at, closed_at, closed_by, receipt_no)
  values (p_restaurant_id, p_waiter_id, tot, tot, 'closed', now(), now(), (select auth.uid()), private.next_receipt_no(p_restaurant_id))
  returning id into oid;

  insert into public.order_items(order_id, restaurant_id, menu_item_id, qty, quantity, price, unit_price, total, waiter_id,
                                 status, station, menu_name, served_at)
  select oid, p_restaurant_id, l.menu_item_id, l.qty, l.qty, coalesce(m.price, 0), coalesce(m.price, 0), l.qty * coalesce(m.price, 0),
         p_waiter_id, 'served', case when m.type = 'Бар' then 'bar' else 'kitchen' end, m.name, now()
  from _lines l join public.menu_items m on m.id = l.menu_item_id;

  return query select oid, tot;
end $$;

-- ---------- privileges ----------
revoke execute on function public.order_open(bigint, text, integer, text[], bigint, text) from public, anon;
revoke execute on function public.order_update_meta(bigint, integer, text[], text) from public, anon;
revoke execute on function public.order_add_items(bigint, jsonb) from public, anon;
revoke execute on function public.order_update_item(bigint, numeric, text) from public, anon;
revoke execute on function public.order_cancel_item(bigint, text) from public, anon;
revoke execute on function public.order_send(bigint) from public, anon;
revoke execute on function public.order_item_set_status(bigint, text) from public, anon;
revoke execute on function public.order_request_bill(bigint) from public, anon;
revoke execute on function public.order_reopen(bigint) from public, anon;
revoke execute on function public.order_close(bigint, text, numeric) from public, anon;
revoke execute on function public.order_cancel(bigint, text) from public, anon;
revoke execute on function public.open_orders(bigint) from public, anon;
revoke execute on function public.kitchen_queue(bigint, text) from public, anon;
grant execute on function public.order_open(bigint, text, integer, text[], bigint, text) to authenticated;
grant execute on function public.order_update_meta(bigint, integer, text[], text) to authenticated;
grant execute on function public.order_add_items(bigint, jsonb) to authenticated;
grant execute on function public.order_update_item(bigint, numeric, text) to authenticated;
grant execute on function public.order_cancel_item(bigint, text) to authenticated;
grant execute on function public.order_send(bigint) to authenticated;
grant execute on function public.order_item_set_status(bigint, text) to authenticated;
grant execute on function public.order_request_bill(bigint) to authenticated;
grant execute on function public.order_reopen(bigint) to authenticated;
grant execute on function public.order_close(bigint, text, numeric) to authenticated;
grant execute on function public.order_cancel(bigint, text) to authenticated;
grant execute on function public.open_orders(bigint) to authenticated;
grant execute on function public.kitchen_queue(bigint, text) to authenticated;
