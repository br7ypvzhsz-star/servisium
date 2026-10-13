-- SERVISIUM 2026-10-13 · Migration B: SaaS schema (ADDITIVE)
-- Tenant settings (currency/locale/timezone/tax), plans & subscription status, billing events,
-- audit log, server-side hall, idempotent menu import. Requires migration 01.

-- ---------- tenant settings + subscription ----------
alter table public.restaurants
  add column if not exists slug text,
  add column if not exists currency text not null default 'UAH',
  add column if not exists locale text not null default 'uk-UA',
  add column if not exists timezone text not null default 'Europe/Kyiv',
  add column if not exists tax_mode text not null default 'none' check (tax_mode in ('none', 'included', 'added')),
  add column if not exists tax_rate numeric(5,2) not null default 0 check (tax_rate >= 0 and tax_rate <= 100),
  add column if not exists service_charge_pct numeric(5,2) not null default 0 check (service_charge_pct >= 0 and service_charge_pct <= 100),
  add column if not exists plan_code text not null default 'trial',
  add column if not exists subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing', 'active', 'past_due', 'canceled', 'suspended')),
  add column if not exists trial_ends_at timestamptz not null default (now() + interval '30 days'),
  add column if not exists paid_until timestamptz;

-- every restaurant that exists today belongs to the platform owner: never lock them out
update public.restaurants set plan_code = 'owner', subscription_status = 'active'
where subscription_status = 'trialing' and plan_code = 'trial';

create unique index if not exists restaurants_slug_uq on public.restaurants(lower(slug)) where slug is not null;

create table if not exists public.plans (
  code text primary key,
  name text not null,
  price_month numeric,              -- NULL = price not set yet by the platform owner
  currency text not null default 'UAH',
  max_staff int,
  max_tables int,
  features jsonb not null default '{}'::jsonb,
  is_public boolean not null default true,
  sort int not null default 0
);
alter table public.plans enable row level security;
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select to authenticated using (is_public or private.is_platform_admin());
insert into public.plans(code, name, max_staff, max_tables, is_public, sort) values
  ('trial', 'Пробний період', 10, 30, true, 0),
  ('start', 'Start', 15, 40, true, 1),
  ('pro', 'Pro', 60, 150, true, 2),
  ('owner', 'Власний заклад', null, null, false, 99)
on conflict (code) do nothing;
alter table public.restaurants drop constraint if exists restaurants_plan_fk;
alter table public.restaurants add constraint restaurants_plan_fk foreign key (plan_code) references public.plans(code);

-- writes are allowed while trialing/paid (+7 days grace); reads always stay allowed so the venue can still pay and export
create or replace function private.tenant_writable(rid bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_platform_admin() or exists (
    select 1 from public.restaurants r where r.id = rid and (
      (r.subscription_status = 'active' and (r.paid_until is null or r.paid_until + interval '7 days' > now()))
      or (r.subscription_status = 'trialing' and r.trial_ends_at > now())
    )
  )
$$;
grant execute on function private.tenant_writable(bigint) to authenticated, service_role;

create or replace function public.my_subscription(p_restaurant_id bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when private.is_member(p_restaurant_id) then (
    select jsonb_build_object('plan', r.plan_code, 'status', r.subscription_status, 'trial_ends_at', r.trial_ends_at,
      'paid_until', r.paid_until, 'writable', private.tenant_writable(r.id), 'currency', r.currency, 'locale', r.locale,
      'timezone', r.timezone, 'tax_mode', r.tax_mode, 'tax_rate', r.tax_rate, 'service_charge_pct', r.service_charge_pct)
    from public.restaurants r where r.id = p_restaurant_id) end
$$;
revoke execute on function public.my_subscription(bigint) from public, anon;
grant execute on function public.my_subscription(bigint) to authenticated;

create table if not exists public.billing_events (
  id bigint generated always as identity primary key,
  restaurant_id bigint references public.restaurants(id) on delete set null,
  provider text not null,
  provider_event_id text not null,
  type text not null,
  amount numeric,
  currency text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);
alter table public.billing_events enable row level security;
drop policy if exists billing_events_read on public.billing_events;
create policy billing_events_read on public.billing_events for select to authenticated
  using (restaurant_id is not null and private.is_admin(restaurant_id));

-- ---------- audit log ----------
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  restaurant_id bigint,
  actor uuid default auth.uid(),
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_rest_time_idx on public.audit_log(restaurant_id, created_at desc);
alter table public.audit_log enable row level security;
drop policy if exists audit_log_read on public.audit_log;
create policy audit_log_read on public.audit_log for select to authenticated
  using (restaurant_id is not null and private.is_admin(restaurant_id));

create or replace function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare rid bigint; eid text; det jsonb; src jsonb;
begin
  src := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  rid := coalesce((src->>'restaurant_id')::bigint, case when tg_table_name = 'restaurants' then (src->>'id')::bigint end);
  eid := src->>'id';
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value)) into det
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o on o.key = n.key
    where n.value is distinct from o.value and n.key not in ('pin_hash');
    if det is null then return new; end if;
  elsif tg_op = 'DELETE' then
    det := jsonb_build_object('old', to_jsonb(old) - 'pin_hash');
  else
    det := jsonb_build_object('new', to_jsonb(new) - 'pin_hash');
  end if;
  insert into public.audit_log(restaurant_id, action, entity, entity_id, details)
  values (rid, lower(tg_op), tg_table_name, eid, det);
  return coalesce(new, old);
end $$;

drop trigger if exists trg_audit_staff on public.restaurant_staff;
create trigger trg_audit_staff after insert or update or delete on public.restaurant_staff for each row execute function private.audit_row();
drop trigger if exists trg_audit_menu on public.menu_items;
create trigger trg_audit_menu after update or delete on public.menu_items for each row execute function private.audit_row();
drop trigger if exists trg_audit_stop on public.stop_list;
create trigger trg_audit_stop after insert or update or delete on public.stop_list for each row execute function private.audit_row();
drop trigger if exists trg_audit_rest on public.restaurants;
create trigger trg_audit_rest after update on public.restaurants for each row execute function private.audit_row();
drop trigger if exists trg_audit_orders on public.orders;
create trigger trg_audit_orders after update or delete on public.orders for each row execute function private.audit_row();

-- ---------- hall (server-side, shared by all devices) ----------
create table if not exists public.hall_configs (
  restaurant_id bigint primary key references public.restaurants(id) on delete cascade,
  config jsonb not null default '{}'::jsonb,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.hall_configs enable row level security;
drop policy if exists hall_configs_read on public.hall_configs;
drop policy if exists hall_configs_write on public.hall_configs;
create policy hall_configs_read on public.hall_configs for select to authenticated using (private.is_member(restaurant_id));
create policy hall_configs_write on public.hall_configs for all to authenticated
  using (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id))
  with check (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id));

create table if not exists public.hall_table_status (
  restaurant_id bigint not null references public.restaurants(id) on delete cascade,
  table_id text not null,
  status text not null check (status in ('available', 'busy', 'reserved', 'cleaning')),
  guests int,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (restaurant_id, table_id)
);
alter table public.hall_table_status enable row level security;
drop policy if exists hall_status_read on public.hall_table_status;
drop policy if exists hall_status_write on public.hall_table_status;
create policy hall_status_read on public.hall_table_status for select to authenticated using (private.is_member(restaurant_id));
create policy hall_status_write on public.hall_table_status for all to authenticated
  using (private.is_member(restaurant_id) and private.tenant_writable(restaurant_id))
  with check (private.is_member(restaurant_id) and private.tenant_writable(restaurant_id));

do $$ begin
  begin alter publication supabase_realtime add table public.hall_table_status; exception when others then null; end;
  begin alter publication supabase_realtime add table public.hall_configs; exception when others then null; end;
end $$;

-- ---------- idempotent menu import ----------
alter table public.menu_items
  add column if not exists currency text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists ingredients jsonb,
  add column if not exists allergens text[],
  add column if not exists content_hash text,
  add column if not exists last_seen_at timestamptz;
create unique index if not exists menu_items_source_uq on public.menu_items(restaurant_id, source, source_id)
  where source is not null and source_id is not null;
create index if not exists menu_items_rest_idx on public.menu_items(restaurant_id);

create table if not exists public.import_runs (
  id bigint generated always as identity primary key,
  restaurant_id bigint not null references public.restaurants(id) on delete cascade,
  source text not null,
  source_url text,
  created_count int not null default 0,
  updated_count int not null default 0,
  unchanged_count int not null default 0,
  adopted_count int not null default 0,
  missing_count int not null default 0,
  diff jsonb not null default '[]'::jsonb,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.import_runs enable row level security;
drop policy if exists import_runs_read on public.import_runs;
create policy import_runs_read on public.import_runs for select to authenticated using (private.can_manage(restaurant_id));

create or replace function public.import_menu_items(p_restaurant_id bigint, p_source text, p_source_url text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  it jsonb; v_id bigint; v_old public.menu_items%rowtype; v_hash text; nm text; sid text; price numeric;
  c int := 0; u int := 0; n int := 0; a int := 0; missing int := 0; run_id bigint;
  diff jsonb := '[]'::jsonb; seen bigint[] := '{}';
begin
  if not private.can_manage(p_restaurant_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.tenant_writable(p_restaurant_id) then raise exception 'subscription_inactive' using errcode = '42501'; end if;
  if coalesce(btrim(p_source), '') = '' then raise exception 'source_required' using errcode = '22023'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'empty_import' using errcode = '22023'; end if;
  if jsonb_array_length(p_items) > 5000 then raise exception 'too_many_items' using errcode = '22023'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    nm := btrim(coalesce(it->>'name', ''));
    if nm = '' then continue; end if;
    sid := nullif(btrim(coalesce(it->>'source_id', it->>'external_id', '')), '');
    begin
      price := nullif(replace(regexp_replace(coalesce(it->>'price', ''), '[^0-9.,]', '', 'g'), ',', '.'), '')::numeric;
    exception when others then price := null; end;
    v_hash := md5(concat_ws('|', nm, coalesce(it->>'description', ''), coalesce(price::text, ''), coalesce(it->>'category', ''),
                            coalesce(it->>'weight', ''), coalesce(it->>'menu', ''), coalesce(it->>'type', '')));
    v_id := null;
    if sid is not null then
      select id into v_id from public.menu_items where restaurant_id = p_restaurant_id and source = p_source and source_id = sid;
    end if;
    if v_id is null then
      -- adopt a legacy row (imported before source ids were stored) instead of creating a duplicate
      select id into v_id from public.menu_items
      where restaurant_id = p_restaurant_id and source_id is null and lower(btrim(name)) = lower(nm)
        and coalesce(category, '') = coalesce(it->>'category', '') and not (id = any (seen))
      order by id limit 1;
      if v_id is not null then a := a + 1; end if;
    end if;

    if v_id is null then
      insert into public.menu_items(restaurant_id, name, type, category, description, price, weight, photo_url, country, menu, menu_id,
                                    category_id, unit, thumbnail_url, source, source_id, currency, metadata, content_hash, last_seen_at)
      values (p_restaurant_id, nm, coalesce(nullif(it->>'type', ''), 'Кухня'), coalesce(nullif(it->>'category', ''), 'Інше'),
              nullif(it->>'description', ''), price, nullif(it->>'weight', ''), nullif(it->>'photo_url', ''), nullif(it->>'country', ''),
              nullif(it->>'menu', ''), nullif(it->>'menu_id', ''), nullif(it->>'category_id', ''), nullif(it->>'unit', ''),
              nullif(it->>'thumbnail_url', ''), p_source, sid, nullif(it->>'currency', ''), coalesce(it->'metadata', '{}'::jsonb), v_hash, now())
      returning id into v_id;
      c := c + 1;
      if jsonb_array_length(diff) < 200 then diff := diff || jsonb_build_object('op', 'insert', 'name', nm); end if;
    else
      select * into v_old from public.menu_items where id = v_id;
      if v_old.content_hash is distinct from v_hash or v_old.source_id is null then
        update public.menu_items set
          name = nm,
          type = coalesce(nullif(it->>'type', ''), type),
          category = coalesce(nullif(it->>'category', ''), category),
          description = coalesce(nullif(it->>'description', ''), description),
          price = coalesce(price, menu_items.price),
          weight = coalesce(nullif(it->>'weight', ''), weight),
          photo_url = coalesce(nullif(photo_url, ''), nullif(it->>'photo_url', '')),     -- never overwrite an existing photo
          menu = coalesce(nullif(it->>'menu', ''), menu),
          menu_id = coalesce(nullif(it->>'menu_id', ''), menu_id),
          category_id = coalesce(nullif(it->>'category_id', ''), category_id),
          thumbnail_url = coalesce(nullif(thumbnail_url, ''), nullif(it->>'thumbnail_url', '')),
          source = p_source, source_id = coalesce(sid, source_id),
          currency = coalesce(nullif(it->>'currency', ''), currency),
          content_hash = v_hash, last_seen_at = now()
        where id = v_id;
        if v_old.content_hash is distinct from v_hash then
          u := u + 1;
          if jsonb_array_length(diff) < 200 then
            diff := diff || jsonb_build_object('op', 'update', 'id', v_id, 'name', nm,
              'price', case when price is distinct from v_old.price then jsonb_build_array(v_old.price, price) end);
          end if;
        else
          n := n + 1;
        end if;
      else
        update public.menu_items set last_seen_at = now() where id = v_id;
        n := n + 1;
      end if;
    end if;
    seen := seen || v_id;
  end loop;

  -- items previously imported from this source but absent now: REPORT only, never delete or hide
  select count(*) into missing from public.menu_items
  where restaurant_id = p_restaurant_id and source = p_source and not (id = any (seen));

  insert into public.import_runs(restaurant_id, source, source_url, created_count, updated_count, unchanged_count, adopted_count, missing_count, diff)
  values (p_restaurant_id, p_source, p_source_url, c, u, n, a, missing, diff) returning id into run_id;

  return jsonb_build_object('run_id', run_id, 'created', c, 'updated', u, 'unchanged', n, 'adopted', a, 'missing', missing);
end $$;

create or replace function public.menu_duplicates(p_restaurant_id bigint)
returns table (name text, category text, copies bigint, ids bigint[])
language sql stable security definer set search_path = '' as $$
  select min(m.name), m.category, count(*), array_agg(m.id order by m.id)
  from public.menu_items m
  where m.restaurant_id = p_restaurant_id and private.can_manage(p_restaurant_id)
  group by lower(btrim(m.name)), m.category having count(*) > 1
$$;

revoke execute on function public.import_menu_items(bigint, text, text, jsonb), public.menu_duplicates(bigint) from public, anon;
grant execute on function public.import_menu_items(bigint, text, text, jsonb), public.menu_duplicates(bigint) to authenticated;

-- ---------- backfill order_items.restaurant_id / waiter_id from parent order ----------
update public.order_items oi set restaurant_id = o.restaurant_id
from public.orders o where o.id = oi.order_id and oi.restaurant_id is null;
update public.order_items oi set waiter_id = o.waiter_id
from public.orders o where o.id = oi.order_id and oi.waiter_id is null;
