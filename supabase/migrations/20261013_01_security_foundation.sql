-- SERVISIUM 2026-10-13 · Migration A: security foundation (ADDITIVE — does not change existing policies)
-- Adds: private schema, PIN pepper + lookup, rate-limit log, RLS helper functions,
-- platform_admins, staff/order RPCs. Old frontend keeps working until migration B.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- ---------- secrets / PIN storage (never exposed through the API) ----------
create table if not exists private.app_secrets (name text primary key, value bytea not null);
alter table private.app_secrets enable row level security;
insert into private.app_secrets(name, value) values ('pin_pepper', extensions.gen_random_bytes(32))
  on conflict (name) do nothing;

create table if not exists private.staff_pin (
  staff_id bigint primary key references public.restaurant_staff(id) on delete cascade,
  pin_lookup bytea,
  legacy_sha256 text,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table private.staff_pin enable row level security;
create unique index if not exists staff_pin_lookup_active_uq on private.staff_pin(pin_lookup) where active and pin_lookup is not null;
create unique index if not exists staff_pin_legacy_active_uq on private.staff_pin(legacy_sha256) where active and legacy_sha256 is not null;

insert into private.staff_pin(staff_id, legacy_sha256, active)
select id, pin_hash, (status = 'active') from public.restaurant_staff where pin_hash is not null
on conflict (staff_id) do nothing;

create table if not exists private.login_attempts (
  id bigint generated always as identity primary key,
  ip text not null,
  ok boolean not null,
  created_at timestamptz not null default now()
);
alter table private.login_attempts enable row level security;
create index if not exists login_attempts_ip_idx on private.login_attempts(ip, created_at desc);
create index if not exists login_attempts_time_idx on private.login_attempts(created_at desc);

-- keep staff_pin in sync while the old frontend may still write pin_hash
create or replace function private.sync_staff_pin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.pin_hash is not null then
      insert into private.staff_pin(staff_id, legacy_sha256, active) values (new.id, new.pin_hash, new.status = 'active')
      on conflict (staff_id) do update set legacy_sha256 = excluded.legacy_sha256, pin_lookup = null, active = excluded.active, updated_at = now();
    end if;
  elsif tg_op = 'UPDATE' then
    if new.pin_hash is not null and new.pin_hash is distinct from old.pin_hash then
      insert into private.staff_pin(staff_id, legacy_sha256, active) values (new.id, new.pin_hash, new.status = 'active')
      on conflict (staff_id) do update set legacy_sha256 = excluded.legacy_sha256, pin_lookup = null, active = excluded.active, updated_at = now();
    end if;
    if new.status is distinct from old.status then
      update private.staff_pin set active = (new.status = 'active'), updated_at = now() where staff_id = new.id;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_sync_staff_pin on public.restaurant_staff;
create trigger trg_sync_staff_pin after insert or update on public.restaurant_staff
  for each row execute function private.sync_staff_pin();

create or replace function private.pin_lookup(p text) returns bytea
language sql stable security definer set search_path = '' as $$
  select extensions.hmac(convert_to(p, 'utf8'), (select value from private.app_secrets where name = 'pin_pepper'), 'sha256')
$$;

create or replace function private.pin_in_use(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.staff_pin sp
    where sp.active and (sp.pin_lookup = private.pin_lookup(p)
       or sp.legacy_sha256 = encode(extensions.digest(convert_to(p, 'utf8'), 'sha256'), 'hex'))
  )
$$;

create or replace function private.find_staff_by_pin(p text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  lk bytea := private.pin_lookup(p);
  lg text := encode(extensions.digest(convert_to(p, 'utf8'), 'sha256'), 'hex');
  sid bigint;
begin
  select sp.staff_id into sid
  from private.staff_pin sp join public.restaurant_staff s on s.id = sp.staff_id
  where sp.active and s.status = 'active' and (sp.pin_lookup = lk or sp.legacy_sha256 = lg)
  limit 1;
  if sid is not null then
    -- upgrade legacy unsalted SHA-256 to peppered HMAC on first successful login
    update private.staff_pin set pin_lookup = lk, legacy_sha256 = null, updated_at = now()
    where staff_id = sid and (pin_lookup is distinct from lk);
  end if;
  return sid;
end $$;

-- ---------- platform admins ----------
create table if not exists public.platform_admins (
  id bigint generated always as identity primary key,
  staff_id bigint references public.restaurant_staff(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (staff_id is not null or user_id is not null)
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from anon, authenticated;
insert into public.platform_admins(staff_id)
select 1 where exists (select 1 from public.restaurant_staff where id = 1 and role = 'ADMIN')
  and not exists (select 1 from public.platform_admins where staff_id = 1);

-- ---------- RLS helper functions ----------
create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.platform_admins pa
    left join public.restaurant_staff s on s.id = pa.staff_id and s.status = 'active'
    where pa.user_id = (select auth.uid()) or s.auth_user_id = (select auth.uid())
  )
$$;

create or replace function private.has_role(rid bigint, roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_platform_admin() or exists (
    select 1 from public.restaurant_staff s
    where s.restaurant_id = rid and s.auth_user_id = (select auth.uid()) and s.status = 'active' and s.role = any (roles)
  )
$$;
create or replace function private.is_member(rid bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(rid, array['ADMIN', 'SENIOR WAITER', 'WAITER'])
$$;
create or replace function private.can_manage(rid bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(rid, array['ADMIN', 'SENIOR WAITER'])
$$;
create or replace function private.is_admin(rid bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(rid, array['ADMIN'])
$$;
create or replace function private.owns_staff(sid bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.restaurant_staff s
    where s.id = sid and s.auth_user_id = (select auth.uid()) and s.status = 'active')
$$;
grant execute on all functions in schema private to authenticated, service_role;
revoke execute on function private.pin_lookup(text), private.pin_in_use(text), private.find_staff_by_pin(text),
  private.sync_staff_pin() from authenticated, anon, public;

-- ---------- service-role wrappers for the pin-login Edge Function ----------
create or replace function public.svc_pin_login_check(p_ip text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare ip_fail int; all_fail int;
begin
  select count(*) into ip_fail from private.login_attempts where ip = p_ip and not ok and created_at > now() - interval '15 minutes';
  select count(*) into all_fail from private.login_attempts where not ok and created_at > now() - interval '10 minutes';
  return ip_fail < 8 and all_fail < 300;
end $$;

create or replace function public.svc_pin_login_record(p_ip text, p_ok boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.login_attempts(ip, ok) values (p_ip, p_ok);
  delete from private.login_attempts where created_at < now() - interval '7 days';
end $$;

create or replace function public.svc_pin_find_staff(p_pin text)
returns table (id bigint, restaurant_id bigint, name text, role text, auth_user_id uuid)
language plpgsql security definer set search_path = '' as $$
declare sid bigint;
begin
  sid := private.find_staff_by_pin(p_pin);
  if sid is null then return; end if;
  return query select s.id, s.restaurant_id, s.name, s.role, s.auth_user_id from public.restaurant_staff s where s.id = sid;
end $$;

revoke execute on function public.svc_pin_login_check(text), public.svc_pin_login_record(text, boolean),
  public.svc_pin_find_staff(text) from public, anon, authenticated;
grant execute on function public.svc_pin_login_check(text), public.svc_pin_login_record(text, boolean),
  public.svc_pin_find_staff(text) to service_role;

-- ---------- client RPCs ----------
alter table public.order_items add column if not exists restaurant_id bigint references public.restaurants(id);

create or replace function public.my_profile() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'is_platform_admin', private.is_platform_admin(),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'restaurant_id', s.restaurant_id, 'name', s.name,
                'role', s.role, 'email', s.email, 'status', s.status) order by s.id)
              from public.restaurant_staff s where s.auth_user_id = (select auth.uid()) and s.status = 'active'), '[]'::jsonb))
$$;

create or replace function public.staff_create(p_restaurant_id bigint, p_name text, p_email text, p_contact text, p_role text, p_pin text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare sid bigint;
begin
  if not private.is_admin(p_restaurant_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.tenant_writable(p_restaurant_id) then raise exception 'subscription_inactive' using errcode = '42501'; end if;
  if p_role not in ('ADMIN', 'SENIOR WAITER', 'WAITER') then raise exception 'invalid_role' using errcode = '22023'; end if;
  if p_pin !~ '^\d{4}$' then raise exception 'invalid_pin' using errcode = '22023'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if private.pin_in_use(p_pin) then raise exception 'pin_in_use' using errcode = '23505'; end if;
  insert into public.restaurant_staff(restaurant_id, name, email, contact, role, status)
  values (p_restaurant_id, btrim(p_name), nullif(lower(btrim(coalesce(p_email, ''))), ''), nullif(btrim(coalesce(p_contact, '')), ''), p_role, 'active')
  returning id into sid;
  insert into private.staff_pin(staff_id, pin_lookup, active) values (sid, private.pin_lookup(p_pin), true)
  on conflict (staff_id) do update set pin_lookup = excluded.pin_lookup, legacy_sha256 = null, active = true, updated_at = now();
  return sid;
end $$;

create or replace function public.staff_set_pin(p_staff_id bigint, p_pin text) returns void
language plpgsql security definer set search_path = '' as $$
declare rid bigint;
begin
  select restaurant_id into rid from public.restaurant_staff where id = p_staff_id;
  if rid is null or not private.is_admin(rid) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_pin !~ '^\d{4}$' then raise exception 'invalid_pin' using errcode = '22023'; end if;
  if private.pin_in_use(p_pin) and not exists (
       select 1 from private.staff_pin where staff_id = p_staff_id and (pin_lookup = private.pin_lookup(p_pin)
         or legacy_sha256 = encode(extensions.digest(convert_to(p_pin, 'utf8'), 'sha256'), 'hex'))) then
    raise exception 'pin_in_use' using errcode = '23505';
  end if;
  insert into private.staff_pin(staff_id, pin_lookup, active)
  values (p_staff_id, private.pin_lookup(p_pin), (select status = 'active' from public.restaurant_staff where id = p_staff_id))
  on conflict (staff_id) do update set pin_lookup = excluded.pin_lookup, legacy_sha256 = null, updated_at = now();
end $$;

create or replace function public.create_order(p_restaurant_id bigint, p_waiter_id bigint, p_items jsonb)
returns table (order_id bigint, total numeric)
language plpgsql security definer set search_path = '' as $$
declare oid bigint; tot numeric := 0; rec record;
begin
  if not private.is_member(p_restaurant_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.tenant_writable(p_restaurant_id) then raise exception 'subscription_inactive' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'empty_order' using errcode = '22023'; end if;
  if not exists (select 1 from public.restaurant_staff w where w.id = p_waiter_id and w.restaurant_id = p_restaurant_id and w.status = 'active') then
    raise exception 'invalid_waiter' using errcode = '22023';
  end if;
  if not private.owns_staff(p_waiter_id) and not private.can_manage(p_restaurant_id) then
    raise exception 'forbidden_waiter' using errcode = '42501';
  end if;

  create temporary table _lines on commit drop as
  select (x->>'menu_item_id')::bigint as menu_item_id, sum((x->>'qty')::numeric) as qty
  from jsonb_array_elements(p_items) x group by 1;

  if exists (select 1 from _lines where qty <= 0 or qty > 1000) then raise exception 'invalid_qty' using errcode = '22023'; end if;
  if exists (select 1 from _lines l left join public.menu_items m on m.id = l.menu_item_id and m.restaurant_id = p_restaurant_id
             where m.id is null) then raise exception 'unknown_item' using errcode = '22023'; end if;
  if exists (select 1 from _lines l join public.stop_list s on s.menu_item_id = l.menu_item_id
             and s.restaurant_id = p_restaurant_id and s.status = 'active') then raise exception 'item_stopped' using errcode = '22023'; end if;

  select coalesce(sum(l.qty * coalesce(m.price, 0)), 0) into tot
  from _lines l join public.menu_items m on m.id = l.menu_item_id;

  insert into public.orders(restaurant_id, waiter_id, total, status, opened_at, closed_at)
  values (p_restaurant_id, p_waiter_id, tot, 'closed', now(), now()) returning id into oid;

  insert into public.order_items(order_id, restaurant_id, menu_item_id, qty, quantity, price, unit_price, total, waiter_id)
  select oid, p_restaurant_id, l.menu_item_id, l.qty, l.qty, coalesce(m.price, 0), coalesce(m.price, 0), l.qty * coalesce(m.price, 0), p_waiter_id
  from _lines l join public.menu_items m on m.id = l.menu_item_id;

  return query select oid, tot;
end $$;

revoke execute on function public.my_profile(), public.staff_create(bigint, text, text, text, text, text),
  public.staff_set_pin(bigint, text), public.create_order(bigint, bigint, jsonb) from public, anon;
grant execute on function public.my_profile(), public.staff_create(bigint, text, text, text, text, text),
  public.staff_set_pin(bigint, text), public.create_order(bigint, bigint, jsonb) to authenticated;

-- guard: clients may never re-parent staff or touch auth link / legacy pin column
create or replace function private.guard_staff_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.role()) in ('anon', 'authenticated') then
    if new.restaurant_id is distinct from old.restaurant_id
       or new.auth_user_id is distinct from old.auth_user_id
       or new.pin_hash is distinct from old.pin_hash then
      raise exception 'forbidden_change' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_staff_update on public.restaurant_staff;
create trigger trg_guard_staff_update before update on public.restaurant_staff
  for each row execute function private.guard_staff_update();
