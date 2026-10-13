-- Аварійний відкат перемикання (повертає СТАРИЙ відкритий доступ). Використовувати лише якщо новий вхід не працює.
do $$
declare t text;
begin
  foreach t in array array['restaurants','menu_items','stop_list','restaurant_staff','orders','order_items'] loop
    execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);
    execute format('drop policy if exists rollback_open on public.%I', t);
    execute format('create policy rollback_open on public.%I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to anon, authenticated;
