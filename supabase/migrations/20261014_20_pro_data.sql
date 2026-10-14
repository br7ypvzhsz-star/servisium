-- SERVISIUM 2026-10-14 · Migration 20: PRO characteristics (tasks 6–16; Wine/Cocktail/Steak/Beverage PRO)
-- pro_kind  : wine | cocktail | steak | spirit | beer | other
-- pro       : structured facts (per kind). Never invented: filled by the venue, or parsed from the venue's own menu text.
-- pro_status: unknown | from_menu (parsed from the venue menu name/section, needs a glance) | confirmed (venue confirmed)
alter table public.menu_items
  add column if not exists pro_kind text,
  add column if not exists pro jsonb not null default '{}'::jsonb,
  add column if not exists pro_status text not null default 'unknown';
alter table public.menu_items drop constraint if exists menu_items_pro_kind_check;
alter table public.menu_items add constraint menu_items_pro_kind_check check (pro_kind is null or pro_kind in ('wine','cocktail','steak','spirit','beer','other'));
alter table public.menu_items drop constraint if exists menu_items_pro_status_check;
alter table public.menu_items add constraint menu_items_pro_status_check check (pro_status in ('unknown','from_menu','confirmed'));
alter table public.menu_items drop constraint if exists menu_items_pro_check;
alter table public.menu_items add constraint menu_items_pro_check check (jsonb_typeof(pro) = 'object');

-- English country names used by some sources → Ukrainian (display only; the original stays in category)
create or replace function private.country_uk(s text) returns text language sql immutable set search_path = '' as $$
  select case lower(btrim(coalesce(s, '')))
    when 'argentina' then 'Аргентина' when 'australia' then 'Австралія' when 'austria' then 'Австрія' when 'chile' then 'Чилі'
    when 'france' then 'Франція' when 'germany' then 'Німеччина' when 'georgia' then 'Грузія' when 'hungary' then 'Угорщина'
    when 'italy' then 'Італія' when 'moldova' then 'Молдова' when 'new zealand' then 'Нова Зеландія' when 'portugal' then 'Португалія'
    when 'south africa' then 'ПАР' when 'spain' then 'Іспанія' when 'ukraine' then 'Україна' when 'usa' then 'США'
    else nullif(btrim(s), '') end
$$;

-- Fill wine facts from the venue's own menu text: section (colour), name (sweetness, vintage, producer), category (country).
create or replace function public.pro_autofill_wines(p_restaurant_id bigint)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not private.can_manage(p_restaurant_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  with w as (
    select m.id, lower(coalesce(m.menu, '')) mn, lower(m.name) nm, m.name, m.category
    from public.menu_items m
    where m.restaurant_id = p_restaurant_id and m.type = 'Бар' and m.pro_status <> 'confirmed'
      and (lower(coalesce(m.menu, '')) ~ 'вин|ігрист|шампан'
           or lower(m.name) ~ '\((сухе|напівсухе|напівсолодке|солодке|брют|екстра)|нап/сол|нап/сух')
  ), f as (
    select id,
      case when mn ~ 'безалког' then 'non_alcoholic' when mn ~ 'ігрист|шампан' or nm ~ 'брют|brut|prosecco|просеко|cava|champagne|шампан|asti' then 'sparkling'
           when mn ~ 'біл' then 'white' when mn ~ 'червон' then 'red' when mn ~ 'рожев|помаранч' then case when nm ~ 'orange|помаранч' then 'orange' else 'rose' end
           when mn ~ 'солодк|кріплен' then 'dessert' end colour,
      case when nm ~ 'екстра[- ]?брют|extra brut' then 'extra_brut' when nm ~ 'брют|brut' then 'brut'
           when nm ~ 'екстра[- ]?сух|extra dry' then 'extra_dry' when nm ~ 'напівсух|нап/сух|semi[- ]?dry' then 'off_dry'
           when nm ~ 'напівсолод|нап/сол|semi[- ]?sweet|feinherb' then 'semi_sweet' when nm ~ '\(сухе|trocken| сухе' then 'dry'
           when nm ~ 'солодк|sweet' then 'sweet' end sweetness,
      substring(name from '(?:^|\s)((?:19|20)\d{2})(?:\s|,|$)') vintage,
      nullif(btrim(substring(name from ',\s*([^,(]+?)\s*(?:\(|$)')), '') producer,
      private.country_uk(category) country,
      mn ~ 'побакал' by_glass
    from w
  )
  update public.menu_items m set
    pro_kind = 'wine',
    pro = m.pro || jsonb_strip_nulls(jsonb_build_object('colour', f.colour, 'sweetness', f.sweetness, 'vintage', f.vintage,
            'producer', f.producer, 'country', f.country, 'by_glass', case when f.by_glass then true end, 'origin', 'menu_text')),
    pro_status = 'from_menu'
  from f where m.id = f.id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.pro_autofill_wines(bigint) from public, anon;
grant execute on function public.pro_autofill_wines(bigint) to authenticated;

-- 20b (applied separately): clean the producer — drop Cyrillic glued to a Latin word and trailing colour/sweetness words
-- («Muscat Natureo, Torresбіле нап/сол» → producer «Torres»). Applied by patching the function body:
--   producer := nullif(btrim(regexp_replace(regexp_replace(<after-comma part>, '([A-Za-z])[А-Яа-яІіЇїЄєҐґ].*$', '\1'),
--               '\s+(біле|червоне|рожеве|нап/сол|нап/сух|сухе|напівсухе|напівсолодке|солодке|брют)\b.*$', '', 'i')), '')
