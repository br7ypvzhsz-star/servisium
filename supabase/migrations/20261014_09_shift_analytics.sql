-- SERVISIUM 2026-10-14 · Migration 09: shifts + shift analytics (instruction §11, T048; non-breaking)
-- Turnover is NOT salary: salary rules are a separate, venue-approved configuration (T049).

create table if not exists public.shifts (
  id bigint generated always as identity primary key,
  restaurant_id bigint not null references public.restaurants(id) on delete cascade,
  staff_id bigint not null references public.restaurant_staff(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  note text,
  constraint shifts_order_check check (ended_at is null or ended_at >= started_at)
);
create unique index if not exists shifts_one_open_uq on public.shifts (staff_id) where ended_at is null;
create index if not exists shifts_rest_idx on public.shifts (restaurant_id, started_at desc);
alter table public.shifts enable row level security;
drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts for select to authenticated
  using (private.can_manage(restaurant_id) or private.owns_staff(staff_id));
grant select on public.shifts to authenticated;
grant all on public.shifts to service_role;

create or replace function public.shift_start(p_restaurant_id bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_staff bigint; v_id bigint;
begin
  select s.id into v_staff from public.restaurant_staff s
  where s.restaurant_id = p_restaurant_id and s.auth_user_id = (select auth.uid()) and s.status = 'active' limit 1;
  if v_staff is null then raise exception 'invalid_waiter' using errcode = '22023'; end if;
  select id into v_id from public.shifts where staff_id = v_staff and ended_at is null;
  if v_id is not null then return v_id; end if;
  insert into public.shifts (restaurant_id, staff_id) values (p_restaurant_id, v_staff) returning id into v_id;
  return v_id;
end $$;

create or replace function public.shift_end(p_restaurant_id bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  update public.shifts sh set ended_at = now()
  from public.restaurant_staff s
  where sh.staff_id = s.id and s.auth_user_id = (select auth.uid()) and sh.restaurant_id = p_restaurant_id and sh.ended_at is null
  returning sh.id into v_id;
  if v_id is null then raise exception 'no_open_shift' using errcode = '22023'; end if;
  return v_id;
end $$;

-- Stats for one staff member (own) or the whole venue (managers), over [p_from, p_to).
-- Only CLOSED receipts count as sales; cancelled lines/orders are reported separately.
create or replace function public.shift_stats(p_restaurant_id bigint, p_from timestamptz, p_to timestamptz, p_staff_id bigint default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_self bigint; v_staff bigint; res jsonb;
begin
  if not private.is_member(p_restaurant_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  select s.id into v_self from public.restaurant_staff s
  where s.restaurant_id = p_restaurant_id and s.auth_user_id = (select auth.uid()) and s.status = 'active' limit 1;
  if p_staff_id is not null and p_staff_id is distinct from v_self and not private.can_manage(p_restaurant_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- a WAITER without p_staff_id gets only their own numbers
  v_staff := case when p_staff_id is not null then p_staff_id
                  when private.can_manage(p_restaurant_id) then null
                  else v_self end;

  with o as (
    select * from public.orders
    where restaurant_id = p_restaurant_id and coalesce(closed_at, opened_at) >= p_from and coalesce(closed_at, opened_at) < p_to
      and (v_staff is null or waiter_id = v_staff)
  ), closed as (select * from o where status = 'closed'),
  lines as (
    select i.*, coalesce(m.category, 'Інше') category, coalesce(i.menu_name, m.name) name, coalesce(m.type, '') mtype
    from public.order_items i join closed c on c.id = i.order_id left join public.menu_items m on m.id = i.menu_item_id
    where i.status <> 'cancelled'
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'staff_id', v_staff,
    'turnover', coalesce((select sum(total) from closed), 0),
    'receipts', (select count(*) from closed),
    'avg_check', coalesce((select round(avg(total), 2) from closed), 0),
    'tables', (select count(distinct table_ref) from closed where table_ref is not null),
    'guests', coalesce((select sum(guests) from closed), 0),
    'discounts', coalesce((select sum(discount) from closed), 0),
    'open_orders', (select count(*) from o where status in ('open', 'awaiting_payment')),
    'cancelled_orders', (select count(*) from o where status = 'cancelled'),
    'cancelled_lines', (select count(*) from public.order_items i join o on o.id = i.order_id where i.status = 'cancelled'),
    'kitchen_sales', coalesce((select sum(qty * price) from lines where station = 'kitchen'), 0),
    'bar_sales', coalesce((select sum(qty * price) from lines where station = 'bar'), 0),
    'by_payment', coalesce((select jsonb_object_agg(coalesce(payment_method, 'unknown'), s) from
                    (select payment_method, sum(total) s from closed group by 1) p), '{}'::jsonb),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'qty', q, 'sum', s) order by s desc) from
                    (select category, sum(qty) q, sum(qty * price) s from lines group by 1) c), '[]'::jsonb),
    'top_items', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', q, 'sum', s) order by q desc, s desc) from
                    (select name, sum(qty) q, sum(qty * price) s from lines group by 1 order by 2 desc, 3 desc limit 15) t), '[]'::jsonb),
    'by_staff', case when v_staff is null then coalesce((select jsonb_agg(jsonb_build_object(
                    'staff_id', w.id, 'name', w.name, 'role', w.role, 'turnover', coalesce(x.t, 0), 'receipts', coalesce(x.n, 0),
                    'avg_check', coalesce(x.a, 0), 'tables', coalesce(x.tb, 0), 'guests', coalesce(x.g, 0)) order by coalesce(x.t, 0) desc)
                  from public.restaurant_staff w
                  left join (select waiter_id, sum(total) t, count(*) n, round(avg(total), 2) a, count(distinct table_ref) tb, sum(guests) g
                             from closed group by 1) x on x.waiter_id = w.id
                  where w.restaurant_id = p_restaurant_id and w.status = 'active'), '[]'::jsonb) end,
    'shifts', coalesce((select jsonb_agg(jsonb_build_object('staff_id', sh.staff_id, 'started_at', sh.started_at, 'ended_at', sh.ended_at,
                    'minutes', round(extract(epoch from (coalesce(sh.ended_at, now()) - sh.started_at)) / 60)) order by sh.started_at)
                  from public.shifts sh where sh.restaurant_id = p_restaurant_id
                    and sh.started_at < p_to and coalesce(sh.ended_at, now()) >= p_from
                    and (v_staff is null or sh.staff_id = v_staff)), '[]'::jsonb)
  ) into res;
  return res;
end $$;

create or replace function public.my_open_shift(p_restaurant_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(sh) from public.shifts sh join public.restaurant_staff s on s.id = sh.staff_id
  where sh.restaurant_id = p_restaurant_id and s.auth_user_id = (select auth.uid()) and sh.ended_at is null limit 1
$$;

revoke execute on function public.shift_start(bigint) from public, anon;
revoke execute on function public.shift_end(bigint) from public, anon;
revoke execute on function public.shift_stats(bigint, timestamptz, timestamptz, bigint) from public, anon;
revoke execute on function public.my_open_shift(bigint) from public, anon;
grant execute on function public.shift_start(bigint) to authenticated;
grant execute on function public.shift_end(bigint) to authenticated;
grant execute on function public.shift_stats(bigint, timestamptz, timestamptz, bigint) to authenticated;
grant execute on function public.my_open_shift(bigint) to authenticated;
