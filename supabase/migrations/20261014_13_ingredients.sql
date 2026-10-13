-- SERVISIUM 2026-10-14 · Migration 13: structured ingredients (instruction §5, tasks 56–58; non-breaking)
-- ingredients: [{"name": "...", "qty": "180", "unit": "г", "role": "основа|соус|гарнір|спеція|топінг|інше",
--                "allergens": ["milk"], "origin": "...", "note": "..."}]
-- ingredients_status: 'unknown' until the venue confirms the list (AI suggestions stay 'unknown').
alter table public.menu_items
  add column if not exists ingredients_status text not null default 'unknown',
  add column if not exists ingredients_confirmed_at timestamptz;
update public.menu_items set ingredients = '[]'::jsonb where ingredients is null;
alter table public.menu_items alter column ingredients set default '[]'::jsonb;
alter table public.menu_items drop constraint if exists menu_items_ingredients_check;
alter table public.menu_items add constraint menu_items_ingredients_check check (jsonb_typeof(ingredients) = 'array');
alter table public.menu_items drop constraint if exists menu_items_ingredients_status_check;
alter table public.menu_items add constraint menu_items_ingredients_status_check check (ingredients_status in ('unknown', 'confirmed'));

create or replace function private.stamp_ingredients_confirmation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.ingredients_status = 'confirmed' and (tg_op = 'INSERT'
       or old.ingredients_status is distinct from new.ingredients_status or old.ingredients is distinct from new.ingredients) then
    new.ingredients_confirmed_at := now();
  elsif new.ingredients_status = 'unknown' then
    new.ingredients_confirmed_at := null;
  end if;
  return new;
end $$;
drop trigger if exists trg_stamp_ingredients on public.menu_items;
create trigger trg_stamp_ingredients before insert or update on public.menu_items
  for each row execute function private.stamp_ingredients_confirmation();
