# SERVISIUM — порядок розгортання (cutover)

Старий сайт працює, поки не виконано крок 5. Кроки 1–4 лише додають нове.

1. Міграція `20261013_01_security_foundation.sql` (SQL Editor → Run).
2. Міграція `20261013_02_saas_schema.sql`.
3. Edge Function `pin-login` (verify_jwt = false). Джерело: `supabase/functions/pin-login/index.ts`.
4. Edge Function `analyze-hall-ai` (verify_jwt = false, перевірка в коді). Джерело: `supabase/functions/analyze-hall-ai/index.ts`. Розгортати ЛИШЕ після кроку 1, бо використовує `my_profile()`.
5. Перемикання (разом, без пауз):
   a. міграція `20261013_03_rls_cutover.sql`;
   a2. міграція `20261013_04_views_invoker.sql` (неламаюча, можна й раніше);
   b. злиття гілки `hardening/security-mobile` у `main` (GitHub Pages оновиться за хвилину).
6. Перевірка: вхід PIN, створення чека, відкриття залу, імпорт меню.
7. Відкат: тег `pre-hardening-20261013` (сайт) + схема `backup_20261013` (дані).

Відомі відкладені речі: `enrich-menu-photos` лишається старою версією (відкрита) до окремої заміни.
Обов'язково: `GEMINI_API_KEY` у Supabase Secrets.
