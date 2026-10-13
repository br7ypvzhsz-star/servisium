-- SERVISIUM 2026-10-14 · Migration 19: onboarding checklist (task 41)
-- RESTAURANT → HALL → STAFF → MENU → CATEGORIES → TECH DATA (ingredients/prep) → ALLERGENS → PHOTOS → READY.
-- Pure read: every step is derived from real data, nothing is marked done by hand.
create or replace function public.onboarding_status(p_restaurant_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  with m as (select * from public.menu_items where restaurant_id = p_restaurant_id),
  h as (select jsonb_array_length(coalesce(config->'tables', '[]'::jsonb)) tables from public.hall_configs where restaurant_id = p_restaurant_id)
  select case when not private.can_manage(p_restaurant_id) then null else jsonb_build_object(
    'restaurant', (select jsonb_build_object('name', r.name, 'has_city', coalesce(r.city, '') <> '') from public.restaurants r where r.id = p_restaurant_id),
    'hall_tables', coalesce((select tables from h), 0),
    'staff_active', (select count(*) from public.restaurant_staff where restaurant_id = p_restaurant_id and status = 'active'),
    'staff_waiters', (select count(*) from public.restaurant_staff where restaurant_id = p_restaurant_id and status = 'active' and role = 'WAITER'),
    'menu_items', (select count(*) from m),
    'menu_with_price', (select count(*) from m where price > 0),
    'categories', (select count(*) from public.menu_categories where restaurant_id = p_restaurant_id and parent_id is not null),
    'ingredients_confirmed', (select count(*) from m where ingredients_status = 'confirmed'),
    'prep_time_set', (select count(*) from m where prep_max_minutes is not null and type = 'Кухня'),
    'kitchen_items', (select count(*) from m where type = 'Кухня'),
    'allergens_confirmed', (select count(*) from m where allergens_status = 'confirmed'),
    'with_photo', (select count(*) from m where coalesce(photo_url, '') <> ''),
    'bar_items', (select count(*) from m where type = 'Бар'),
    'bar_with_photo', (select count(*) from m where type = 'Бар' and coalesce(photo_url, '') <> '')
  ) end
$$;
revoke execute on function public.onboarding_status(bigint) from public, anon;
grant execute on function public.onboarding_status(bigint) to authenticated;
