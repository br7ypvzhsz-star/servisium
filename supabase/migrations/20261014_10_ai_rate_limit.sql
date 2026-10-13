-- SERVISIUM 2026-10-14 · Migration 10: per-user rate limit for paid AI Edge Functions (task 67; non-breaking)
create table if not exists private.ai_calls (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  restaurant_id bigint,
  fn text not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_calls_user_idx on private.ai_calls (user_id, created_at desc);
alter table private.ai_calls enable row level security;

-- called by Edge Functions with the service role only; true = allowed (and recorded)
create or replace function public.svc_ai_rate_check(p_user uuid, p_restaurant_id bigint, p_fn text, p_per_minute integer default 20)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from private.ai_calls where created_at < now() - interval '1 day';
  if (select count(*) from private.ai_calls where user_id = p_user and created_at > now() - interval '1 minute') >= p_per_minute then
    return false;
  end if;
  insert into private.ai_calls (user_id, restaurant_id, fn) values (p_user, p_restaurant_id, p_fn);
  return true;
end $$;
revoke execute on function public.svc_ai_rate_check(uuid, bigint, text, integer) from public, anon, authenticated;
grant execute on function public.svc_ai_rate_check(uuid, bigint, text, integer) to service_role;
