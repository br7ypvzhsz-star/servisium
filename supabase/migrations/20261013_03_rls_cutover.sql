-- SERVISIUM 2026-10-13 · Migration C: RLS CUTOVER  (BREAKING for the old frontend — apply together with the new site)
-- Replaces every "using (true)" anon policy with tenant-scoped policies. Requires migrations 01 and 02.

do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public'
             and tablename in ('restaurants', 'menu_items', 'stop_list', 'restaurant_staff', 'orders', 'order_items')
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- the public (anon) key may not touch any table any more
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

alter table public.restaurants      enable row level security;
alter table public.menu_items       enable row level security;
alter table public.stop_list        enable row level security;
alter table public.restaurant_staff enable row level security;
alter table public.orders           enable row level security;
alter table public.order_items      enable row level security;

-- ---- restaurants ----
create policy restaurants_select on public.restaurants for select to authenticated using (private.is_member(id));
create policy restaurants_insert on public.restaurants for insert to authenticated with check (private.is_platform_admin());
create policy restaurants_update on public.restaurants for update to authenticated
  using (private.is_admin(id) and private.tenant_writable(id)) with check (private.is_admin(id));
create policy restaurants_delete on public.restaurants for delete to authenticated using (private.is_platform_admin());

-- ---- menu ----
create policy menu_select on public.menu_items for select to authenticated using (private.is_member(restaurant_id));
create policy menu_insert on public.menu_items for insert to authenticated
  with check (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id));
create policy menu_update on public.menu_items for update to authenticated
  using (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id))
  with check (private.can_manage(restaurant_id));
create policy menu_delete on public.menu_items for delete to authenticated
  using (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id));

-- ---- stop list ----
create policy stop_select on public.stop_list for select to authenticated using (private.is_member(restaurant_id));
create policy stop_insert on public.stop_list for insert to authenticated
  with check (private.is_member(restaurant_id) and private.tenant_writable(restaurant_id));
create policy stop_update on public.stop_list for update to authenticated
  using (private.is_member(restaurant_id) and private.tenant_writable(restaurant_id))
  with check (private.is_member(restaurant_id));
create policy stop_delete on public.stop_list for delete to authenticated
  using (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id));

-- ---- staff (rows are created through public.staff_create / PINs through public.staff_set_pin) ----
create policy staff_select on public.restaurant_staff for select to authenticated
  using (private.can_manage(restaurant_id) or private.owns_staff(id));
create policy staff_update on public.restaurant_staff for update to authenticated
  using (private.is_admin(restaurant_id) and private.tenant_writable(restaurant_id))
  with check (private.is_admin(restaurant_id));
create policy staff_delete on public.restaurant_staff for delete to authenticated
  using (private.is_admin(restaurant_id) and private.tenant_writable(restaurant_id));

-- ---- orders (rows are created through public.create_order) ----
create policy orders_select on public.orders for select to authenticated
  using (private.can_manage(restaurant_id) or private.owns_staff(waiter_id));
create policy orders_update on public.orders for update to authenticated
  using (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id))
  with check (private.can_manage(restaurant_id));
create policy orders_delete on public.orders for delete to authenticated
  using (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id));

create policy order_items_select on public.order_items for select to authenticated
  using (private.can_manage(restaurant_id) or private.owns_staff(waiter_id));
create policy order_items_update on public.order_items for update to authenticated
  using (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id))
  with check (private.can_manage(restaurant_id));
create policy order_items_delete on public.order_items for delete to authenticated
  using (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id));

-- legacy unsalted PIN hashes are now only kept in private.staff_pin
update public.restaurant_staff set pin_hash = null where pin_hash is not null;
delete from public.order_items where restaurant_id is null and order_id is null;
alter table public.order_items alter column restaurant_id set not null;

-- the PIN-lookup columns must never be readable by clients, whatever the policies say
revoke select (pin_hash) on public.restaurant_staff from authenticated;
