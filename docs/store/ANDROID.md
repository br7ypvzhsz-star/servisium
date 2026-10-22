# SERVISIUM на Android без Google Play (безкоштовно)

Три шляхи, від найпростішого:

| Шлях | Вартість | Робота власника | Вигляд |
|---|---|---|---|
| **A. PWA з браузера** | 0 | немає — працює вже зараз | Chrome → ⋮ → «Встановити застосунок»; без адресного рядка |
| **B. APK з PWABuilder** | 0 | 10 хв: згенерувати й розіслати файл | окремий застосунок; **адресний рядок видно**, доки немає `assetlinks.json` (див. нижче) |
| **C. APK з Capacitor** (`mobile/`) | 0 | потрібен Android Studio на комп'ютері | повноцінний застосунок без адресного рядка |

Для персоналу закладів шляху A достатньо. B і C дають файл для розсилки й основу для Google Play у майбутньому.

## B. APK через PWABuilder

1. pwabuilder.com → `https://br7ypvzhsz-star.github.io/servisium/` → **Package For Stores → Android**.
2. Package ID: `app.servisium.waiter` (той самий, що в `mobile/capacitor.config.json`).
3. Signing key: **Create new** — PWABuilder згенерує ключ. Архів ключа й паролі зберегти в надійному місці
   (менеджер паролів), **ніколи не в репозиторій**. Без цього ключа неможливо випускати оновлення.
4. Завантажити архів: `.apk` — для встановлення напряму, `.aab` — для Google Play у майбутньому, `assetlinks.json`.
5. Встановлення на телефон: відкрити `.apk` → дозволити встановлення з цього джерела.

### Про адресний рядок

Android приховує адресний рядок лише якщо `assetlinks.json` лежить у **корені домену**:
`https://br7ypvzhsz-star.github.io/.well-known/assetlinks.json`.
Сайт зараз у підпапці (`/servisium/`), тож файл не можна покласти з цього репозиторію. Варіанти (рішення власника):
1. створити репозиторій `br7ypvzhsz-star.github.io` з одним файлом `.well-known/assetlinks.json`;
2. власний домен для сайту (наприклад, `servisium.app`) — тоді файл кладеться в цей репозиторій;
3. залишити адресний рядок (працює, але виглядає як браузер).

## C. Capacitor (повноцінна збірка)

Заготовка: `mobile/` (Capacitor 6, `appId app.servisium.waiter`). Команди на комп'ютері з Node 18+, JDK 17 і Android Studio:

```
cd mobile
npm install
npx cap add android
npm run sync
npx cap open android      # Android Studio → Build → Generate Signed Bundle / APK
```

Обмеження: Capacitor вбудовує копію сайту в застосунок — кожне оновлення сайту вимагає нової збірки APK.
У хмарному середовищі агента збірка зараз неможлива: репозиторії Android SDK/Maven/Gradle закриті (HTTP 403).
Альтернатива без комп'ютера — збірка APK через GitHub Actions (безкоштовно для публічного репозиторію);
додати workflow можна лише з окремого дозволу власника (PROTOCOL §5.4).
