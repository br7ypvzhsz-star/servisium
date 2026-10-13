-- SERVISIUM 2026-10-14 · Migration 11: Realtime for hall, orders, kitchen/bar, stop list, menu (tasks 35, 43, 49; non-breaking)
-- postgres_changes honours RLS, so a device only receives rows of its own venue that it may SELECT.
do $$
declare t text;
begin
  foreach t in array array['hall_table_status', 'hall_configs', 'orders', 'order_items', 'stop_list', 'menu_items'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
