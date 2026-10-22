# SERVISIUM у Microsoft Store — покрокова інструкція (безкоштовно)

Станом на 22.10.2026: реєстрація розробника-фізичної особи в Microsoft Store **безкоштовна**, без банківської картки;
потрібні особистий акаунт Microsoft і перевірка особи (фото документа + селфі). Магазин приймає PWA.
Джерела: Windows Developer Blog (10.09.2025), Microsoft Learn «Publish a PWA to the Microsoft Store», Microsoft Store Policies 10.3, 10.5.1.

Пакет збирається **з адреси сайту**, тому після публікації зміни сайту (HTML/JS/CSS) приходять у застосунок без нової подачі.
Нову подачу потрібно робити лише при зміні `manifest.webmanifest` (назва, іконки тощо).

## 0. Передумови (не подавати раніше)

- [ ] Гілку `hardening/security-mobile` перевірено й випущено в `main` (QUEUE Q-003). Інакше в магазин піде стара версія сайту.
- [ ] Сторінка `privacy.html` доступна на сайті й у ній заповнено оператора та email (зараз там позначки `[заповнює власник]`).
- [ ] Є демоакаунт для перевірки: працівник із роллю ADMIN у **тестовому** закладі з PIN.
      Створення — запис у живу базу Supabase → окремий дозвіл власника.

## 1. Акаунт розробника (власник, ~15 хв)

1. Особистий акаунт Microsoft (не робочий/шкільний): account.microsoft.com.
2. Partner Center → «Open a developer account» → тип **Individual** → перевірка особи.

## 2. Резерв назви (власник, 2 хв)

Partner Center → **Apps and games** → **New product** → **MSIX or PWA app** → назва `SERVISIUM` → **Reserve product name**.
Потім **Product management → Product identity** → скопіювати три значення:
`Package ID`, `Publisher ID`, `Publisher display name`. Вони не секретні, але в репозиторій їх класти не потрібно.

## 3. Пакет у PWABuilder (власник, 5 хв)

1. pwabuilder.com → вставити `https://br7ypvzhsz-star.github.io/servisium/` → **Start**.
2. Якщо звіт показує «Action Items» — надіслати їх агенту завданням; manifest, іконки, service worker і скріншоти вже готові (перевірено в Chromium: помилок встановлюваності 0).
3. **Package For Stores → Windows → Generate Package** → вставити три значення з кроку 2 → **Download Package**.
4. Архів містить `.msixbundle` і `.classic.appxbundle`.

## 4. Подача (власник, ~20 хв)

Partner Center → застосунок → **Start your submission**:

| Розділ | Що вказати |
|---|---|
| Pricing and availability | Free; ринки — на вибір (Україна, ЄС…) |
| Properties | Category: **Business**; Privacy policy URL: `https://br7ypvzhsz-star.github.io/servisium/privacy.html` |
| Age ratings | анкета IARC: без насильства, азарту, покупок; користувачі не спілкуються між собою публічно → очікувано 3+ |
| Packages | завантажити обидва файли з кроку 3 |
| Store listings (Ukrainian + English) | тексти з `LISTING.md`; скріншоти `docs/store/screenshots/desktop-*.png` (2732×1536) |
| Submission options → Notes for certification | шаблон із `LISTING.md` + PIN демоакаунта (лише тут) |

Перевірка зазвичай триває 24–48 годин.

## Що робить агент, а що — власник

| Агент (готово в цьому PR) | Власник |
|---|---|
| політика конфіденційності, тексти, анкети, скріншоти, manifest зі скріншотами, ця інструкція | акаунт і перевірка особи, резерв назви, PWABuilder, подача, PIN демоакаунта, дозвіл на створення демоакаунта |
