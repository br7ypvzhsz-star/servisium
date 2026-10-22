# SERVISIUM — тексти для магазинів застосунків

Однакові для Microsoft Store, Google Play і App Store (обмеження довжини вказано).
Скріншоти: `docs/store/screenshots/` (реальний інтерфейс, **синтетичний демозаклад** — див. `tools/`).

## Основне

| Поле | Значення |
|---|---|
| Назва | SERVISIUM — Art of Service |
| Коротка назва | SERVISIUM |
| Категорія | Бізнес (Business); додатково — Продуктивність (Productivity) |
| Ціна | Безкоштовно для завантаження (доступ видає адміністратор закладу) |
| Вікова оцінка | 3+ / Everyone — немає насильства, азартних ігор, контенту для дорослих. Позиції меню можуть містити назви алкогольних напоїв (див. анкету нижче) |
| Політика конфіденційності | `https://br7ypvzhsz-star.github.io/servisium/privacy.html` — **працює лише після випуску гілки в `main`** |
| Сайт / підтримка | `https://br7ypvzhsz-star.github.io/servisium/` · email підтримки — **заповнює власник** |
| Мови інтерфейсу | українська |

## Короткий опис (≤ 80 символів)

- UA: `Робоче місце офіціанта: меню, зал, замовлення, кухня, бар і навчання.` (68)
- EN: `Waiter workspace: menu, floor plan, orders, kitchen, bar and training.` (70)

## Повний опис — українською

SERVISIUM — робочий інструмент для ресторанів, барів і кафе. Офіціант, старший офіціант і адміністратор працюють в одному застосунку на телефоні, планшеті чи комп'ютері.

**Зал і замовлення**
- цифрова схема залу з поверхами й зонами, статуси столів;
- замовлення від столу до чека: позиції, коментарі, передача на кухню й бар, рахунок, закриття;
- черги кухні й бару, нормативи часу, затримки з причиною, нагадування «Готово до видачі».

**Меню**
- імпорт меню з посилання, CSV/XLSX, PDF чи фото;
- категорії й підкатегорії, ціни, вихід, склад;
- 14 алергенів ЄС зі статусом підтвердження; попередження офіціанту, якщо гість має алергію.

**Команда й навчання**
- вхід за персональним PIN, ролі з різним доступом;
- тести за реальним меню закладу, рівні й прогрес персоналу;
- зміни й аналітика: чеки, середній чек, завантаженість залу.

**AI-помічник**
- відповіді лише на основі меню вашого закладу;
- підбір напою до страви й навпаки;
- розпізнавання плану залу з фото.

Дані кожного закладу ізольовані: працівник бачить лише свій заклад. Без реклами й трекерів.
Обліковий запис створює адміністратор закладу; самостійної реєстрації немає.

## Full description — English

SERVISIUM is a work tool for restaurants, bars and cafés. Waiters, senior waiters and managers work in one app on a phone, tablet or computer.

**Floor and orders** — digital floor plan with floors and zones, table statuses; orders from table to receipt with kitchen and bar queues, preparation timers, delays and “ready to serve” reminders.

**Menu** — import from a link, CSV/XLSX, PDF or photo; categories, prices, portions, ingredients; the 14 EU allergens with confirmation status and warnings for guests' allergies.

**Team and training** — personal PIN sign-in and roles; tests built from the venue's real menu, levels and staff progress; shifts and analytics.

**AI helper** — answers based only on your venue's menu, food and drink pairing, floor-plan recognition from a photo.

Each venue's data is isolated. No ads, no trackers. Accounts are created by the venue administrator; there is no self sign-up.

## Ключові слова

ресторан, офіціант, меню, замовлення, бар, кафе, POS, зал, алергени, навчання персоналу · restaurant, waiter, menu, orders, bar, cafe, floor plan, allergens, staff training

## Відповіді для анкет

**Дані (Google Play Data safety / App Store App Privacy / Microsoft):**
- Збираються: ім'я працівника, роль (ідентифікатори облікового запису); email адміністратора; дані замовлень і чеків (не платіжні реквізити); фото, які користувач сам завантажує.
- Не збираються: геолокація, контакти, фінансова інформація (картки), історія браузера, рекламні ідентифікатори.
- Шифрування під час передачі: так (HTTPS).
- Передача третім особам для реклами: ні. Обробники: Supabase, Google Gemini (AI-функції), сервіси пошуку зображень (лише назви позицій меню) — див. `privacy.html`.
- Видалення даних: на запит через адміністратора закладу або контакт оператора.

**Алкоголь:** застосунок не продає й не рекламує алкоголь; назви напоїв — частина меню закладу для персоналу.
**Покупки в застосунку:** немає. Оплата сервісу закладом — поза застосунком (рішення власника, перевірити правила магазинів перед запуском платного тарифу).

## Нотатки для перевірки (Notes for certification) — шаблон

```
SERVISIUM is a staff tool; sign-in is required.
Demo venue: "<назва тестового закладу>". Sign in with the 4-digit PIN: <PIN — вписати лише тут, у формі магазину>.
Role: ADMIN (all modules visible). Data in the demo venue is test data.
```
PIN демоакаунта **не зберігається в репозиторії** (він публічний).
