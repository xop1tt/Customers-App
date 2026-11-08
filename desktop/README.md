# Customers: приложение для macOS и Windows

Одна кодовая база на **Tauri 2**: интерфейс на React + TypeScript (Vite), ядро на Rust. Поведение и внешний вид на macOS
(Apple Silicon и Intel) и Windows 10/11 совпадают. Дизайн «Flat Dark»: тёмные непрозрачные поверхности, без стекла,
размытия и прозрачности, небольшие радиусы, акцентный цвет по необходимости.

```
src/                 интерфейс
  api/               типы, вызовы команд Rust, демо-бэкенд (mock.ts) для запуска в обычном браузере
  state/             хранилище, действия, события ядра
  ui/                собственные компоненты: кнопки, поля, переключатели, всплывающие окна, меню, подсказки, диалоги
  app/               оболочка, боковая панель, верхняя панель, инспектор, страницы, настройки
  styles/            токены (цвета, радиусы, движение), базовые стили, стили компонентов и приложения
src-tauri/           ядро (Rust)
  src/search/        источники (RSS, Telegram, VK, OpenStreetMap), оценка, дедупликация
  src/store.rs db.rs база лидов (SQLCipher), миграции, резервные копии
  src/cloud/         вход (Supabase Auth) и синхронизация
  src/drives.rs mail.rs crm.rs   облачные диски, почта, экспорт в CRM
  src/app/           сессия, события, трей, обновления, команды для интерфейса
  tests/stack.rs     сквозные проверки с локальным стеком Supabase (пропускаются без переменных LG_STACK_*)
installer/           установщик Inno Setup и проверка установки для Windows
scripts/             set-version.cjs (версия из тега), make-dmg.sh, screenshots.cjs
```

## Разработка

Нужны Node.js 22+ и Rust (stable). На Linux ещё `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.

```bash
cd desktop
npm ci
npm run dev            # интерфейс в браузере с демо-данными (?auth, ?welcome, ?cloud, ?local, ?update, ?whatsnew, ?platform=windows)
npx tauri dev          # настоящее приложение
npm run typecheck && npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run shots          # скриншоты интерфейса в 1080p, 1440p, 4K, на малых окнах (Playwright)
```

Облако и ключи OAuth для дисков задаются переменными окружения при сборке: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
(только публичный ключ), `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `DROPBOX_APP_KEY`, `MICROSOFT_CLIENT_ID`.
Без них собирается версия с локальными учётными записями, а ключи можно ввести в приложении.

## Сборка

```bash
npx tauri build --bundles app --target universal-apple-darwin   # macOS, универсальный .app
./scripts/make-dmg.sh out/Customers.dmg path/to/Customers.app     # dmg с ярлыком «Программы»
npx tauri build --no-bundle                                       # Windows: src-tauri/target/release/customers.exe
```

Установщик для Windows собирает Inno Setup из `installer/Customers.iss`, проверяет его `installer/check.ps1`.
Релиз по тегу `vX.Y.Z` собирает `.github/workflows/release.yml`.
