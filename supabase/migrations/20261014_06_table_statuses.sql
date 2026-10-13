-- SERVISIUM 2026-10-14 · Migration 06: full table-status set for the hall (task 64, non-breaking)
alter table public.hall_table_status drop constraint if exists hall_table_status_status_check;
alter table public.hall_table_status add constraint hall_table_status_status_check
  check (status = any (array['available','busy','partial','awaiting_payment','reserved','cleaning','blocked']));
