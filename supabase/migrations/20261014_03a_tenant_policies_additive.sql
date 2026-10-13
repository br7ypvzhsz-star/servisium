-- SERVISIUM 2026-10-14 · Migration 03a: tenant policies ALONGSIDE the old open ones (non-breaking)
-- Same 21 policies as 20261013_03_rls_cutover.sql. Permissive policies are OR-ed, so this only lets
-- signed-in staff work through the new site; anon access is unchanged until the cutover (03).
-- 03 still runs as-is afterwards: it first drops every policy on these tables and re-creates them.

grant select, insert, update, delete on public.restaurants, public.menu_items, public.stop_list,
  public.restaurant_staff, public.orders, public.order_items to authenticated;

create policy restaurants_select on public.restaurants for select to authenticated using (private.is_member(id));
create policy restaurants_insert on public.restaurants for insert to authenticated with check (private.is_platform_admin());
create policy restaurants_update on public.restaurants for update to authenticated
  using (private.is_admin(id) and private.tenant_writable(id)) with check (private.is_admin(id));
create policy restaurants_delete on public.restaurants for delete to authenticated using (private.is_platform_admin());
create policy menu_select on public.menu_items for select to authenticated using (private.is_member(restaurant_id));
create policy menu_insert on public.menu_items for insert to authenticated
  with check (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id));
create policy menu_update on public.menu_items for update to authenticated
  using (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id))
  with check (private.can_manage(restaurant_id));
create policy menu_delete on public.menu_items for delete to authenticated
  using (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id));
create policy stop_select on public.stop_list for select to authenticated using (private.is_member(restaurant_id));
create policy stop_insert on public.stop_list for insert to authenticated
  with check (private.is_member(restaurant_id) and private.tenant_writable(restaurant_id));
create policy stop_update on public.stop_list for update to authenticated
  using (private.is_member(restaurant_id) and private.tenant_writable(restaurant_id))
  with check (private.is_member(restaurant_id));
create policy stop_delete on public.stop_list for delete to authenticated
  using (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id));
create policy staff_select on public.restaurant_staff for select to authenticated
  using (private.can_manage(restaurant_id) or private.owns_staff(id));
create policy staff_update on public.restaurant_staff for update to authenticated
  using (private.is_admin(restaurant_id) and private.tenant_writable(restaurant_id))
  with check (private.is_admin(restaurant_id));
create policy staff_delete on public.restaurant_staff for delete to authenticated
  using (private.is_admin(restaurant_id) and private.tenant_writable(restaurant_id));
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
