-- SERVISIUM 2026-10-14 · Migration 07: structured allergens (tasks 17–23, 65; non-breaking)
-- allergens         : EU-14 codes the venue CONFIRMED for the item (existing column, now validated)
-- allergens_status  : 'unknown' until the venue confirms the list — the UI must then say «потрібне уточнення»,
--                     never «безпечно»
-- allergen_adaptations : {"<code>": {"can": true|false, "note": "що прибрати/замінити"}} — only confirmed rules
-- cross_contact_note   : venue-confirmed cross-contact risk; never a promise of absence

alter table public.menu_items
  add column if not exists allergens_status text not null default 'unknown',
  add column if not exists allergen_adaptations jsonb not null default '{}'::jsonb,
  add column if not exists cross_contact_note text,
  add column if not exists allergens_confirmed_at timestamptz,
  add column if not exists allergens_confirmed_by uuid;

update public.menu_items set allergens = '{}' where allergens is null;
alter table public.menu_items alter column allergens set default '{}';

alter table public.menu_items drop constraint if exists menu_items_allergens_status_check;
alter table public.menu_items add constraint menu_items_allergens_status_check
  check (allergens_status in ('unknown', 'confirmed'));

alter table public.menu_items drop constraint if exists menu_items_allergens_codes_check;
alter table public.menu_items add constraint menu_items_allergens_codes_check
  check (allergens <@ array['milk','eggs','gluten','peanuts','tree_nuts','fish','crustaceans','molluscs',
                            'soy','celery','mustard','sesame','sulphites','lupin']::text[]);

alter table public.menu_items drop constraint if exists menu_items_allergen_adaptations_check;
alter table public.menu_items add constraint menu_items_allergen_adaptations_check
  check (jsonb_typeof(allergen_adaptations) = 'object');

-- who/when confirmed — set server-side so the client cannot fake it
create or replace function private.stamp_allergen_confirmation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.allergens_status = 'confirmed' and (
       tg_op = 'INSERT'
       or old.allergens_status is distinct from new.allergens_status
       or old.allergens is distinct from new.allergens
       or old.allergen_adaptations is distinct from new.allergen_adaptations
       or old.cross_contact_note is distinct from new.cross_contact_note) then
    new.allergens_confirmed_at := now();
    new.allergens_confirmed_by := (select auth.uid());
  elsif new.allergens_status = 'unknown' then
    new.allergens_confirmed_at := null;
    new.allergens_confirmed_by := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_stamp_allergens on public.menu_items;
create trigger trg_stamp_allergens before insert or update on public.menu_items
  for each row execute function private.stamp_allergen_confirmation();
