-- SERVISIUM 2026-10-14 · Migration 16: hierarchical menu categories (handoff task 5; non-breaking)
-- Tree per venue (parent_id). menu_items keeps its text `category` (used everywhere) and gains `category_ref`.
-- A trigger keeps them in sync: an imported/edited item with a new category name gets a leaf under its type root
-- («Кухня» / «Бар»); renaming a node renames the items' text category.

create table if not exists public.menu_categories (
  id bigint generated always as identity primary key,
  restaurant_id bigint not null references public.restaurants(id) on delete cascade,
  parent_id bigint references public.menu_categories(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 80),
  item_type text check (item_type in ('Кухня', 'Бар')),
  sort integer not null default 100,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists menu_categories_uq on public.menu_categories (restaurant_id, coalesce(parent_id, 0), lower(name));
create index if not exists menu_categories_parent_idx on public.menu_categories (restaurant_id, parent_id);
alter table public.menu_categories enable row level security;
drop policy if exists menu_categories_read on public.menu_categories;
create policy menu_categories_read on public.menu_categories for select to authenticated using (private.is_member(restaurant_id));
drop policy if exists menu_categories_write on public.menu_categories;
create policy menu_categories_write on public.menu_categories for all to authenticated
  using (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id))
  with check (private.can_manage(restaurant_id) and private.tenant_writable(restaurant_id));
grant select, insert, update, delete on public.menu_categories to authenticated;
grant all on public.menu_categories to service_role;

alter table public.menu_items add column if not exists category_ref bigint references public.menu_categories(id) on delete set null;
create index if not exists menu_items_category_ref_idx on public.menu_items (category_ref);

-- root «Кухня»/«Бар» + leaf for a category name; returns the leaf id
create or replace function private.ensure_menu_category(p_rid bigint, p_type text, p_name text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_root bigint; v_leaf bigint; v_type text := case when p_type = 'Бар' then 'Бар' else 'Кухня' end;
begin
  if p_name is null or btrim(p_name) = '' then return null; end if;
  -- an existing node with this name anywhere in the venue tree wins (admin may have moved it)
  select id into v_leaf from public.menu_categories where restaurant_id = p_rid and lower(name) = lower(btrim(p_name))
    and (item_type is null or item_type = v_type) order by parent_id nulls last, id limit 1;
  if v_leaf is not null then return v_leaf; end if;
  select id into v_root from public.menu_categories where restaurant_id = p_rid and parent_id is null and lower(name) = lower(v_type) limit 1;
  if v_root is null then
    insert into public.menu_categories (restaurant_id, name, item_type, sort) values (p_rid, v_type, v_type, case when v_type = 'Кухня' then 10 else 20 end)
    returning id into v_root;
  end if;
  insert into public.menu_categories (restaurant_id, parent_id, name, item_type) values (p_rid, v_root, btrim(p_name), v_type)
  on conflict do nothing returning id into v_leaf;
  if v_leaf is null then
    select id into v_leaf from public.menu_categories where restaurant_id = p_rid and parent_id = v_root and lower(name) = lower(btrim(p_name));
  end if;
  return v_leaf;
end $$;

create or replace function private.sync_item_category() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.category is distinct from old.category or new.category_ref is null then
    new.category_ref := private.ensure_menu_category(new.restaurant_id, new.type, new.category);
  end if;
  return new;
end $$;
-- runs after trg_normalize_category (alphabetical order of trigger names: normalize < sync)
drop trigger if exists trg_sync_category on public.menu_items;
create trigger trg_sync_category before insert or update of category, type on public.menu_items
  for each row execute function private.sync_item_category();

-- renaming a node renames the text category of its items
create or replace function private.rename_category_items() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.name is distinct from old.name then
    update public.menu_items set category = new.name where category_ref = new.id;
  end if;
  return new;
end $$;
drop trigger if exists trg_rename_category on public.menu_categories;
create trigger trg_rename_category after update of name on public.menu_categories
  for each row execute function private.rename_category_items();

-- seed the tree from existing items (ordered by first appearance)
update public.menu_items set category_ref = private.ensure_menu_category(restaurant_id, type, category)
where category is not null and category_ref is null;
