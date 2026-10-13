-- SERVISIUM 2026-10-14 · Migration 17: training tests from the venue's real menu (tasks 24–25, T050–T051)
-- Questions are generated and graded on the server; correct answers never reach the client before submit.
-- Level 1: categories / kitchen vs bar · Level 2: prices / portions · Level 3: confirmed ingredients & allergens.
-- Next level unlocks at ≥ 80 % on the previous one.

create table if not exists public.training_sessions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id bigint not null references public.restaurants(id) on delete cascade,
  staff_id bigint not null references public.restaurant_staff(id) on delete cascade,
  level integer not null check (level between 1 and 3),
  questions jsonb not null,
  answers jsonb,
  score integer,
  total integer not null,
  created_at timestamptz not null default now(),
  submitted_at timestamptz
);
create index if not exists training_sessions_staff_idx on public.training_sessions (restaurant_id, staff_id, created_at desc);
alter table public.training_sessions enable row level security;
-- no direct client access: everything goes through the functions below (which strip correct answers)
revoke all on public.training_sessions from anon, authenticated;
grant all on public.training_sessions to service_role;

create or replace function private.my_staff_id(p_rid bigint) returns bigint
language sql stable security definer set search_path = '' as $$
  select id from public.restaurant_staff where restaurant_id = p_rid and auth_user_id = (select auth.uid()) and status = 'active' limit 1
$$;

create or replace function private.training_best(p_rid bigint, p_staff bigint, p_level integer) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(max(round(100.0 * score / nullif(total, 0)))::int, 0) from public.training_sessions
  where restaurant_id = p_rid and staff_id = p_staff and level = p_level and submitted_at is not null
$$;

create or replace function public.training_generate(p_restaurant_id bigint, p_level integer, p_count integer default 10)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_staff bigint; qs jsonb := '[]'::jsonb; q record; v_id uuid; n int := least(greatest(coalesce(p_count, 10), 3), 20);
  v_allergen text; v_label text;
begin
  v_staff := private.my_staff_id(p_restaurant_id);
  if v_staff is null then raise exception 'invalid_waiter' using errcode = '22023'; end if;
  if p_level not in (1, 2, 3) then raise exception 'invalid_level' using errcode = '22023'; end if;
  if p_level > 1 and private.training_best(p_restaurant_id, v_staff, p_level - 1) < 80 then
    raise exception 'level_locked' using errcode = '22023';
  end if;

  if p_level = 1 then
    -- category of an item (3 wrong options from other categories of the same type)
    for q in select m.name, m.category, m.type from public.menu_items m
             where m.restaurant_id = p_restaurant_id and m.category is not null and coalesce(m.status, 'active') <> 'stop'
             order by random() limit n loop
      qs := qs || jsonb_build_object('text', format('До якої категорії меню належить «%s»?', q.name),
        'correct', q.category,
        'options', (select jsonb_agg(o order by random()) from (
            select q.category o union all
            (select c from (select distinct category c from public.menu_items where restaurant_id = p_restaurant_id and type = q.type
              and category is not null and category <> q.category) x order by random() limit 3)) y));
    end loop;
  elsif p_level = 2 then
    for q in select m.name, m.price, m.type, m.weight from public.menu_items m
             where m.restaurant_id = p_restaurant_id and m.price > 0 order by random() limit n loop
      qs := qs || jsonb_build_object('text', format('Скільки коштує «%s»%s?', q.name, case when q.weight is not null and q.weight <> '' then format(' (%s)', q.weight) else '' end),
        'correct', q.price::text,
        'options', (select jsonb_agg(o order by random()) from (
            select q.price::text o union all
            (select p::text from (select distinct price p from public.menu_items where restaurant_id = p_restaurant_id and type = q.type
              and price > 0 and price <> q.price) x order by random() limit 3)) y));
    end loop;
  else
    -- confirmed allergens (yes/no) and confirmed ingredients (which one belongs)
    for q in select m.name, m.allergens from public.menu_items m
             where m.restaurant_id = p_restaurant_id and m.allergens_status = 'confirmed' order by random() limit (n + 1) / 2 loop
      select a into v_allergen from unnest(array['milk','gluten','eggs','tree_nuts','fish','crustaceans','soy','sesame','mustard','celery']) a order by random() limit 1;
      v_label := case v_allergen when 'milk' then 'молоко' when 'gluten' then 'глютен' when 'eggs' then 'яйця' when 'tree_nuts' then 'горіхи'
        when 'fish' then 'рибу' when 'crustaceans' then 'ракоподібних' when 'soy' then 'сою' when 'sesame' then 'кунжут'
        when 'mustard' then 'гірчицю' else 'селеру' end;
      qs := qs || jsonb_build_object('text', format('За даними закладу, чи містить «%s» %s?', q.name, v_label),
        'correct', case when v_allergen = any (coalesce(q.allergens, '{}')) then 'Так' else 'Ні' end,
        'options', jsonb_build_array('Так', 'Ні'));
    end loop;
    for q in select m.id, m.name, m.ingredients from public.menu_items m
             where m.restaurant_id = p_restaurant_id and m.ingredients_status = 'confirmed' and jsonb_array_length(m.ingredients) > 0
             order by random() limit n / 2 loop
      qs := qs || coalesce((select jsonb_build_object('text', format('Що з переліченого входить до складу «%s»?', q.name), 'correct', good.nm,
          'options', (select jsonb_agg(o order by random()) from (select good.nm o union all
              (select distinct i->>'name' from public.menu_items m2, jsonb_array_elements(m2.ingredients) i
               where m2.restaurant_id = p_restaurant_id and m2.id <> q.id
                 and not exists (select 1 from jsonb_array_elements(q.ingredients) j where lower(j->>'name') = lower(i->>'name'))
               order by 1 limit 3)) y))
        from (select i->>'name' nm from jsonb_array_elements(q.ingredients) i order by random() limit 1) good), '[]'::jsonb);
    end loop;
  end if;

  -- keep only questions with at least 2 distinct options
  qs := coalesce((select jsonb_agg(x) from jsonb_array_elements(qs) x where jsonb_array_length(coalesce(x->'options', '[]'::jsonb)) >= 2), '[]'::jsonb);
  if jsonb_array_length(qs) = 0 then
    return jsonb_build_object('session_id', null, 'questions', '[]'::jsonb,
      'message', case when p_level = 3 then 'Для рівня 3 потрібні підтверджені закладом склад або алергени позицій.' else 'Недостатньо даних меню для тесту.' end);
  end if;

  insert into public.training_sessions (restaurant_id, staff_id, level, questions, total)
  values (p_restaurant_id, v_staff, p_level, qs, jsonb_array_length(qs)) returning id into v_id;

  return jsonb_build_object('session_id', v_id, 'level', p_level,
    'questions', (select jsonb_agg(jsonb_build_object('i', ord - 1, 'text', x->'text', 'options', x->'options') order by ord)
                  from jsonb_array_elements(qs) with ordinality t(x, ord)));
end $$;

-- p_answers: {"0": "Гриль", "1": "250", ...} (option text by question index)
create or replace function public.training_submit(p_session_id uuid, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.training_sessions; v_score int := 0; detail jsonb := '[]'::jsonb; x jsonb; i int := 0; given text;
begin
  select * into s from public.training_sessions where id = p_session_id for update;
  if not found then raise exception 'not_found' using errcode = '22023'; end if;
  if s.staff_id is distinct from private.my_staff_id(s.restaurant_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if s.submitted_at is not null then raise exception 'already_submitted' using errcode = '22023'; end if;
  for x in select value from jsonb_array_elements(s.questions) loop
    given := p_answers ->> i::text;
    if given is not null and given = x->>'correct' then v_score := v_score + 1; end if;
    detail := detail || jsonb_build_object('i', i, 'text', x->'text', 'given', given, 'correct', x->'correct', 'ok', given = x->>'correct');
    i := i + 1;
  end loop;
  update public.training_sessions set answers = p_answers, score = v_score, submitted_at = now() where id = s.id;
  return jsonb_build_object('score', v_score, 'total', s.total, 'percent', round(100.0 * v_score / nullif(s.total, 0)),
    'passed', 100.0 * v_score / nullif(s.total, 0) >= 80, 'detail', detail);
end $$;

-- own progress; managers also get the whole team
create or replace function public.training_progress(p_restaurant_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_staff bigint;
begin
  if not private.is_member(p_restaurant_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  v_staff := private.my_staff_id(p_restaurant_id);
  return jsonb_build_object(
    'me', case when v_staff is null then null else jsonb_build_object(
      'staff_id', v_staff,
      'levels', (select jsonb_agg(jsonb_build_object('level', l, 'best', private.training_best(p_restaurant_id, v_staff, l),
                  'attempts', (select count(*) from public.training_sessions where restaurant_id = p_restaurant_id and staff_id = v_staff and level = l and submitted_at is not null),
                  'unlocked', l = 1 or private.training_best(p_restaurant_id, v_staff, l - 1) >= 80)) from generate_series(1, 3) l),
      'recent', coalesce((select jsonb_agg(jsonb_build_object('level', level, 'score', score, 'total', total, 'at', submitted_at) order by submitted_at desc)
                  from (select * from public.training_sessions where restaurant_id = p_restaurant_id and staff_id = v_staff and submitted_at is not null
                        order by submitted_at desc limit 10) r), '[]'::jsonb)) end,
    'team', case when private.can_manage(p_restaurant_id) then coalesce((select jsonb_agg(jsonb_build_object(
        'staff_id', w.id, 'name', w.name, 'role', w.role,
        'l1', private.training_best(p_restaurant_id, w.id, 1), 'l2', private.training_best(p_restaurant_id, w.id, 2), 'l3', private.training_best(p_restaurant_id, w.id, 3),
        'attempts', (select count(*) from public.training_sessions where restaurant_id = p_restaurant_id and staff_id = w.id and submitted_at is not null),
        'last', (select max(submitted_at) from public.training_sessions where restaurant_id = p_restaurant_id and staff_id = w.id)) order by w.name)
      from public.restaurant_staff w where w.restaurant_id = p_restaurant_id and w.status = 'active'), '[]'::jsonb) else null end);
end $$;

revoke execute on function public.training_generate(bigint, integer, integer) from public, anon;
revoke execute on function public.training_submit(uuid, jsonb) from public, anon;
revoke execute on function public.training_progress(bigint) from public, anon;
grant execute on function public.training_generate(bigint, integer, integer) to authenticated;
grant execute on function public.training_submit(uuid, jsonb) to authenticated;
grant execute on function public.training_progress(bigint) to authenticated;
