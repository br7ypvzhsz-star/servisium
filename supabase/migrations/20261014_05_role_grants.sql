-- SERVISIUM 2026-10-14 · Migration 05: table privileges (non-breaking, additive)
-- The project does not auto-grant new public tables to API roles (postgres default ACL gives only
-- Dxtm). Result: service_role could not UPDATE restaurant_staff, so pin-login failed with 403 when
-- linking auth_user_id; authenticated users could not reach the tables added in migration 02.
-- RLS stays the gate for authenticated: every table below has tenant-scoped policies.

-- service role (Edge Functions only; bypasses RLS by design)
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant usage, select on sequences to service_role;

-- signed-in users on the migration-02 tables (policies: is_admin / is_member / can_manage)
grant select on public.audit_log, public.billing_events, public.import_runs, public.plans to authenticated;
grant select, insert, update, delete on public.hall_configs, public.hall_table_status to authenticated;
grant usage, select on all sequences in schema public to authenticated;
