-- SERVISIUM · server test suite (T079 / task 68)
-- Run in the Supabase SQL editor (or execute_sql). Everything runs in ONE transaction that always
-- ends with an exception, so the database is left untouched. The exception message is the report:
--   "SUITE RESULT: <passed>/<total> passed | FAIL: ..."
-- Fixtures: venue 1 (LUGOSH) with staff 1 = ADMIN + platform admin (linked auth user),
--           venue 3 with staff 2 = SENIOR WAITER (auth user staff-2@staff.servisium.invalid, linked here temporarily).
do $$
declare
  passed int := 0; total int := 0; fails text := '';
  u1 uuid; u2 uuid; m1 bigint; m2 bigint; o bigint; i1 bigint; r record; j jsonb; n int; t text; sid uuid; ans jsonb;

begin
  select auth_user_id into u1 from public.restaurant_staff where id = 1;
  select id into u2 from auth.users where email = 'staff-2@staff.servisium.invalid';
  update public.restaurant_staff set auth_user_id = u2 where id = 2 and auth_user_id is null;
  select id into m1 from public.menu_items where restaurant_id = 1 and type = 'Кухня' and price > 0
    and id not in (select menu_item_id from public.stop_list where status = 'active' and menu_item_id is not null) order by id limit 1;
  select id into m2 from public.menu_items where restaurant_id = 1 and type = 'Бар' and price > 0
    and id not in (select menu_item_id from public.stop_list where status = 'active' and menu_item_id is not null) order by id limit 1;

  -- ===== 1. anonymous access is closed =====
  set local role anon;
  foreach t in array array['restaurants', 'menu_items', 'restaurant_staff', 'stop_list', 'orders', 'order_items', 'hall_configs', 'menu_categories'] loop
    total := total + 1;
    begin
      execute format('select count(*) from public.%I', t) into n;
      fails := fails || format('anon can read %s; ', t);
    exception when insufficient_privilege then passed := passed + 1;
    end;
  end loop;
  total := total + 1;
  begin perform public.my_profile(); fails := fails || 'anon can call my_profile; ';
  exception when insufficient_privilege then passed := passed + 1; end;
  reset role;

  -- ===== 2. tenant isolation (staff 2 = venue 3 only) =====
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  total := total + 1; select count(*) into n from public.restaurants where id <> 3;
  if n = 0 then passed := passed + 1; else fails := fails || format('foreign restaurants visible=%s; ', n); end if;
  total := total + 1; select count(*) into n from public.menu_items where restaurant_id <> 3;
  if n = 0 then passed := passed + 1; else fails := fails || format('foreign menu visible=%s; ', n); end if;
  total := total + 1; select count(*) into n from public.restaurant_staff where restaurant_id <> 3;
  if n = 0 then passed := passed + 1; else fails := fails || format('foreign staff visible=%s; ', n); end if;
  total := total + 1;
  begin perform public.order_open(1, 'X', 1); fails := fails || 'foreign order_open allowed; ';
  exception when others then passed := passed + 1; end;
  total := total + 1;
  if jsonb_array_length(public.kitchen_queue(1, null)) = 0 and jsonb_array_length(public.open_orders(1)) = 0 then passed := passed + 1;
  else fails := fails || 'foreign queue/orders visible; '; end if;
  total := total + 1;
  begin perform public.training_generate(1, 1, 3); fails := fails || 'foreign training allowed; ';
  exception when others then passed := passed + 1; end;
  reset role;

  -- ===== 3. order lifecycle (staff 1, venue 1) =====
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  o := public.order_open(1, 'SUITE-T1', 2, array['milk']);
  total := total + 1; if public.order_open(1, 'SUITE-T1', 2) = o then passed := passed + 1; else fails := fails || 'reopen table gives new order; '; end if;
  perform public.order_add_items(o, jsonb_build_array(jsonb_build_object('menu_item_id', m1, 'qty', 2), jsonb_build_object('menu_item_id', m2, 'qty', 1)));
  select id into i1 from public.order_items where order_id = o and menu_item_id = m1;
  total := total + 1;
  begin perform public.order_close(o, 'card', 0); fails := fails || 'closed with unsent items; ';
  exception when others then passed := passed + 1; end;
  perform public.order_send(o);
  total := total + 1;
  begin perform public.order_update_item(i1, 5); fails := fails || 'qty changed after send; ';
  exception when others then passed := passed + 1; end;
  total := total + 1;
  begin perform public.order_cancel_item(i1, null); fails := fails || 'cancel sent item without reason; ';
  exception when others then passed := passed + 1; end;
  total := total + 1; n := public.order_delay(null, i1, 5, 'тест');
  if n = 1 and (select delay_until > now() from public.order_items where id = i1) then passed := passed + 1; else fails := fails || 'delay not set; '; end if;
  total := total + 1;
  begin perform public.order_delay(null, i1, 5, null); fails := fails || 'delay without reason; ';
  exception when others then passed := passed + 1; end;
  perform public.order_item_set_status(i1, 'preparing');
  perform public.order_item_set_status(i1, 'ready');
  total := total + 1; if (select count(*) from jsonb_array_elements(public.kitchen_queue(1, 'bar'))) >= 1 then passed := passed + 1; else fails := fails || 'bar queue empty; '; end if;
  perform public.order_request_bill(o);
  total := total + 1; if (select status from public.hall_table_status where restaurant_id = 1 and table_id = 'SUITE-T1') = 'awaiting_payment' then passed := passed + 1; else fails := fails || 'table not awaiting_payment; '; end if;
  select * into r from public.order_close(o, 'cash', 0);
  total := total + 1;
  if r.receipt_no is not null and r.total = (select sum(qty * price) from public.order_items where order_id = o and status <> 'cancelled') then passed := passed + 1;
  else fails := fails || format('receipt/total wrong (%s, %s); ', r.receipt_no, r.total); end if;
  total := total + 1; if (select status from public.hall_table_status where restaurant_id = 1 and table_id = 'SUITE-T1') = 'cleaning' then passed := passed + 1; else fails := fails || 'table not cleaning after close; '; end if;
  total := total + 1;
  begin perform public.order_add_items(o, jsonb_build_array(jsonb_build_object('menu_item_id', m1, 'qty', 1))); fails := fails || 'added to closed order; ';
  exception when others then passed := passed + 1; end;

  -- ===== 4. shift analytics =====
  j := public.shift_stats(1, now() - interval '1 hour', now() + interval '1 minute');
  total := total + 1;
  if (j->>'turnover')::numeric = r.total and (j->>'receipts')::int >= 1 then passed := passed + 1; else fails := fails || format('shift_stats turnover %s vs %s; ', j->>'turnover', r.total); end if;

  -- ===== 5. training (server-graded, no answer leak) =====
  j := public.training_generate(1, 1, 3);
  total := total + 1; if j::text not like '%"correct"%' and jsonb_array_length(j->'questions') >= 1 then passed := passed + 1; else fails := fails || 'training leaks answers; '; end if;
  total := total + 1;
  begin perform public.training_generate(1, 3, 3); fails := fails || 'level 3 not locked; ';
  exception when others then passed := passed + 1; end;

  -- ===== 6. hall stats =====
  reset role;
  insert into public.hall_configs (restaurant_id, config, version) values (1, '{"floors":[],"tables":[{"id":"sa","number":"1","capacity":4},{"id":"sb","number":"2","capacity":6}]}', 1)
    on conflict (restaurant_id) do update set config = excluded.config;
  insert into public.hall_table_status (restaurant_id, table_id, status, guests) values (1, 'sa', 'busy', 3)
    on conflict (restaurant_id, table_id) do update set status = 'busy', guests = 3;
  set local role authenticated;
  j := public.hall_stats(1);
  total := total + 1;
  if (j->>'seats_total')::int = 10 and (j->>'seats_free')::int = 6 and (j->>'guests_now')::int = 3 then passed := passed + 1; else fails := fails || format('hall_stats %s; ', j); end if;

  -- ===== 7. idempotent import + look-alike letters =====
  select * into r from public.menu_items where restaurant_id = 1 and metadata->>'original_category' is not null and source_id is null limit 1;
  if found then
    select count(*) into n from public.menu_items where restaurant_id = 1;
    j := public.import_menu_items(1, 'expz', null, jsonb_build_array(jsonb_build_object('name', r.name, 'category', r.metadata->>'original_category', 'type', r.type, 'price', r.price, 'source_id', 'suite-1')));
    total := total + 1;
    if (j->>'created')::int = 0 and (select count(*) from public.menu_items where restaurant_id = 1) = n then passed := passed + 1; else fails := fails || format('import duplicated: %s; ', j); end if;
    j := public.import_menu_items(1, 'expz', null, jsonb_build_array(jsonb_build_object('name', r.name, 'category', r.metadata->>'original_category', 'type', r.type, 'price', r.price, 'source_id', 'suite-1')));
    total := total + 1;
    if (j->>'created')::int = 0 and (j->>'unchanged')::int = 1 then passed := passed + 1; else fails := fails || format('re-import not unchanged: %s; ', j); end if;
  end if;

  -- ===== 8. category tree rename propagates =====
  reset role;
  select c.id, c.name into r from public.menu_categories c where c.restaurant_id = 1 and c.parent_id is not null
    and exists (select 1 from public.menu_items m where m.category_ref = c.id) limit 1;
  update public.menu_categories set name = r.name || ' SUITE' where id = r.id;
  total := total + 1;
  if not exists (select 1 from public.menu_items where category_ref = r.id and category <> r.name || ' SUITE') then passed := passed + 1; else fails := fails || 'category rename not propagated; '; end if;

  raise exception 'SUITE RESULT: %/% passed%', passed, total, case when fails = '' then '' else ' | FAIL: ' || fails end;
end $$;
