# SERVISIUM — шлях до App Store / Google Play

Етап 1 (готово): PWA — manifest, sw.js (лише оболонка), іконки, нижня навігація, safe-area.
Етап 2 (заготовка в `mobile/`): обгортка Capacitor 6, `appId app.servisium.waiter` (змінити до реєстрації, якщо потрібен інший ідентифікатор).

## Збірка (на комп'ютері з Node 18+)
cd mobile && npm install && npx cap add android && npx cap add ios && npm run sync

## Потрібне від власника (я цього не роблю й паролів не прошу)
- Apple Developer Program (99 USD/рік) і Mac із Xcode для iOS-збірки;
- Google Play Console (25 USD одноразово);
- ключі підпису (keystore для Android, сертифікати для iOS) — створює і зберігає власник;
- політика конфіденційності (URL), опис, скріншоти 6.7"/6.5" та планшетні;
- обліковий запис для рев'ю (тестовий заклад із PIN).

## Перед подачею
- Логін PIN працює на живій базі (див. DEPLOY_RUNBOOK);
- оплата підписки: якщо купується доступ до цифрових послуг усередині застосунку, Apple/Google вимагають свої покупки (комісія); продаж закладам поза застосунком (B2B через сайт) — окреме правило, перевірити актуальні умови перед подачею.

## Пакети для магазинів (R-01, 22.10.2026)
- Безкоштовні шляхи: Microsoft Store (реєстрація фізичної особи безкоштовна, приймає PWA) — `docs/store/MICROSOFT_STORE.md`;
  Android без Google Play (PWA, APK з PWABuilder, Capacitor) — `docs/store/ANDROID.md`.
- Тексти, анкети даних, шаблон нотаток для перевірки — `docs/store/LISTING.md`.
- Політика конфіденційності — `privacy.html` (uk/en); оператор і email заповнює власник.
- Скріншоти — `docs/store/screenshots/` (реальний інтерфейс, синтетичний демозаклад; відтворення — `docs/store/tools/`); додано в `manifest.webmanifest` → `screenshots`.
- Google Play (25 USD) і App Store (99 USD/рік) — платні; ці кроки вище залишаються в силі.
