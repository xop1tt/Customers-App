# CLAUDE.md — правила работы в репозитории Customers

Customers — бесплатная CRM со встроенным поиском клиентов для macOS и Windows. Владелец и единственный разработчик —
Maksim (не программист); код пишет Claude Code. Отвечать и писать документацию — по-русски.

## 1. Что где

| Путь | Что |
|---|---|
| `desktop/src` | интерфейс: React + TypeScript (`app/` экраны, `state/` хранилище, `api/` вызовы ядра и демо-бэкенды `mock*.ts`, `lib/` чистая логика, `ui/` кит, `styles/` токены) |
| `desktop/src-tauri/src` | Rust-ядро `customers_lib`: `commands.rs` (тонкие команды) → `app/` (Core), `workspace/` (CRM, команды `ws_*`), `search/` (генератор лидов), `cloud/` (Auth, синхронизация, Realtime), `secrets.rs` (Keychain/DPAPI), `db.rs`/`store.rs` (SQLCipher) |
| `supabase/migrations` | схема PostgreSQL: RLS, RPC, триггеры. Источник истины для прав и инвариантов CRM |
| `supabase/functions` | Edge Functions на Deno (письма, удаление аккаунта, неактивные аккаунты) |
| `supabase/tests` | pytest на одноразовом стенде Supabase (`supabase/tests/stack/up.sh`) |
| `tests/` | pytest: workflow, каналы, иконки и наследие Python-генератора (`src/leadgen`, удаляется пакетом D2) |
| `docs/` | для разработки: ARCHITECTURE, DECISIONS (журнал ADR), ROADMAP, SECURITY_MODEL, TESTING, ci |
| `wiki/` | для пользователей, публикуется workflow `wiki.yml` |

Прочитать перед крупной задачей: `docs/ROADMAP.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`.

## 2. Согласование (обязательно)

* Работа идёт пакетами из `docs/ROADMAP.md` по порядку, один пакет за раз. Новые функции вне списка не начинаются.
* Без явного «да» Maksim в треде задачи нельзя: слияние в `main`, публикация релиза, любые запросы на запись в рабочий
  проект Supabase (`ldbbbssoevprnrbhcnjy`), удаление данных пользователей, изменение бизнес-логики, прав,
  авторизации, лицензии, платные сервисы. Молчание и уточняющий вопрос — не согласие.
* Проект Supabase «Mirada» не трогать никогда.
* Запись в Supabase Maksim делает сам по инструкции (SQL Editor / Dashboard): подтверждения инструментов Supabase
  ему недоступны. Чтение (`select`, advisors, список таблиц) можно выполнять самому.
* Не делаем: Web-версию, мобильные приложения, Beta/Preview, AI-функции, enterprise-домены (ADR-033, 034, 039).

## 3. Ветки и PR

* Ветка от `main`, PR в `main`. Прямой push в `main` запрещён; слияние — Maksim (Approve владельца кода + CodeQL).
* Из контейнера нельзя удалять ветки и пушить теги (403): об этом просить Maksim.
* Перед словами «PR готов» проверить, что CI зелёный: Maksim сливает быстро.

## 4. Проверки перед push

Из `desktop/` (нужен `npm ci`; `desktop/dist` должен существовать до сборки Rust — сначала `npm run build`):

| Что | Команда |
|---|---|
| типы, тесты интерфейса, ядро, release-check | `npm run check` |
| только интерфейс | `npm run typecheck && npm test` |
| только ядро | `npm run test:core` |
| стиль Rust | `cargo fmt --check` и `cargo clippy --lib --bins -D warnings` (в `src-tauri`) |

Из корня: `python -m pytest` (покрытие ≥ 90 %). Облачные тесты: `python -m pytest supabase/tests` при запущенном
стенде. В контейнере нет Docker: стенд поднимается без него (Postgres 16 + бинарники GoTrue/PostgREST/Deno в
`/var/tmp`, см. память проекта) или проверяется только в CI `cloud.yml`. macOS/Windows-код (Keychain, DPAPI,
установщик) проверяется только в CI.

## 5. Тесты

* Тесты — эталон. Не отключать, не ослаблять, не удалять ради зелёного CI; SKIPPED ≠ PASS. Упал тест — чинить код.
* Новое поведение — новые тесты; старые меняются только если иначе нельзя подключить функцию, и без ослабления.
* CodeQL ругается на пароли-литералы в тестах: собирать их во время выполнения.
* `supabase/tests/test_sync_rls.py` ищет имя серверной роли в `desktop/scripts` — не писать его там буквально.

## 6. Миграции Supabase

* Только добавляющие: старые файлы в `supabase/migrations` не меняются, `drop function` запрещён тестом
  (`test_migrations.py`). Повторное применение должно быть безопасным (`if not exists`, `create or replace`).
* Каждая таблица `public` — `enable` + `force row level security`; security definer функции — `set search_path = ''`
  и проверка прав (`private.require_perm` / `private.is_member`); у `anon` нет прав на таблицы.
* Новая CRM-таблица подключается через `private.crm_attach(...)` (ADR-027).
* Порядок: стенд и CI зелёные → PR → Maksim применяет миграцию в рабочем проекте → проверка read-only запросом.
* Откат приложения не откатывает базу: схема должна работать с предыдущей версией клиента (expand/contract).

## 7. Кроссплатформенность и интерфейс

* Одно приложение для macOS 12+ и Windows 10+; поведение одинаковое. Масштабы Windows 100–200 % и минимальное окно
  880×560 должны работать.
* Дизайн Flat Dark: непрозрачные плоские поверхности, без стекла, размытия и градиентов. Цвета и размеры — токены
  `styles/tokens.css`. Тексты интерфейса — русские, английский через `lib/i18n.en.ts` (ключ — русская строка).
* Существенные изменения интерфейса — сначала макеты на согласование (пакет C1).
* Демо в браузере: `npm run dev`, флаги URL `?team ?auth ?welcome ?cloud ?local ?update ?whatsnew ?platform=windows`.

## 8. Релизы

* Версия берётся из тега `vX.Y.Z` (`release.yml`, ручной запуск или тег от Maksim); файлы между релизами не
  обязаны совпадать с версией релиза.
* Публикация ждёт подтверждения в окружении `production`. Сначала слияние исправления, потом релиз.
* Заметки релиза — `.github/release-notes/vX.Y.Z.md`.

## 9. Известные ловушки

* `tokio::spawn` на главном потоке без рантайма роняет приложение в release (`panic = abort`): использовать
  `shell::enter_async_runtime()`.
* GitHub Actions закреплены по полному SHA (`tests/test_workflows.py`); SHA узнавать через `git ls-remote`.
* Windows не даёт переименовать открытый файл SQLite.
* Обязательные проверки CI — агрегаторы `Desktop gate` и `Cloud gate`.

## 10. Definition of Done

Требование выполнено; тесты на новое поведение есть и зелёные локально и в CI; миграции проверены на стенде;
документация (`docs/`, при необходимости `wiki/`, ADR) обновлена; в отчёте Maksim — что сделано, что проверено,
что не проверено и почему, что нужно сделать ему.
