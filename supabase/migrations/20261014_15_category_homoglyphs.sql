-- SERVISIUM 2026-10-14 · Migration 15: fix Latin look-alike letters inside Cyrillic category words (T017, T069)
-- Source menus (Expz) contain «Iталія», «Ітaлія», «Італiя», «CША», «Пap»… which split one category into many.
-- Only words that MIX scripts are changed («Сети BBQ GRILL» stays). The original text is kept in metadata.original_category.

create or replace function private.fix_homoglyphs(s text) returns text
language sql immutable set search_path = '' as $$
  select case when s is null then null else (
    select string_agg(
      case when w ~ '[A-Za-z]' and w ~ '[А-Яа-яЁёІіЇїЄєҐґ]'
           then translate(w, 'AaBCcEeHIiKMOoPpTXxy', 'АаВСсЕеНІіКМОоРрТХху')
           else w end, ' ' order by n)
    from unnest(regexp_split_to_array(s, ' ')) with ordinality as t(w, n)
  ) end
$$;

-- existing rows (all venues), original preserved
update public.menu_items
set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('original_category', category),
    category = private.fix_homoglyphs(category)
where category is not null and private.fix_homoglyphs(category) is distinct from category;

-- future imports: normalise on the way in (import_menu_items reads it from p_items)
create or replace function private.normalize_import_category() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.category is not null and private.fix_homoglyphs(new.category) is distinct from new.category then
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('original_category', new.category);
    new.category := private.fix_homoglyphs(new.category);
  end if;
  return new;
end $$;
drop trigger if exists trg_normalize_category on public.menu_items;
create trigger trg_normalize_category before insert or update of category on public.menu_items
  for each row execute function private.normalize_import_category();

-- import_menu_items adopts legacy rows (no source_id) by name + category: compare against the NORMALISED
-- incoming category, otherwise a re-import of a source with look-alike letters would create duplicates.
do $$
declare def text;
begin
  def := pg_get_functiondef('public.import_menu_items'::regproc);
  if position('coalesce(category, '''') = coalesce(it->>''category'', '''')' in def) = 0 then
    raise exception 'import_menu_items: expected adoption clause not found — review before applying';
  end if;
  def := replace(def, 'coalesce(category, '''') = coalesce(it->>''category'', '''')',
                      'coalesce(category, '''') = coalesce(private.fix_homoglyphs(it->>''category''), '''')');
  execute def;
end $$;
