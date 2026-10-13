-- SERVISIUM 2026-10-13 · Migration 04: sales views obey RLS (non-breaking)
-- waiter_sales_stats / waiter_monthly_sales were created without security_invoker, so any future
-- SELECT grant would bypass tenant RLS on orders/restaurant_staff. Make them run as the caller
-- and drop the meaningless TRUNCATE/TRIGGER/REFERENCES grants clients had on them.

alter view public.waiter_sales_stats   set (security_invoker = true);
alter view public.waiter_monthly_sales set (security_invoker = true);

revoke all on public.waiter_sales_stats   from anon, authenticated;
revoke all on public.waiter_monthly_sales from anon, authenticated;
