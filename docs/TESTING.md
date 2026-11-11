# Тестирование

Правила: существующие тесты не отключаются и не ослабляются; SKIPPED — не PASS; моки допустимы только в
изолированных unit-тестах и не выдаются за проверку настоящего Supabase. Карта покрытия по модулям — wiki
«Тестирование».

## 1. Категории и где они живут

| Категория | Что | Где | Запуск |
|---|---|---|---|
| Unit | чистая логика Rust и TypeScript | `#[cfg(test)]` в модулях, `desktop/src/**/*.test.ts(x)` | `npm run test:core`, `npm test` |
| Integration (ядро) | `Core` целиком на временной папке, секреты в памяти, сеть — заглушка | `app/*` тесты (`app::testing::fixture`) | `npm run test:core` |
| Database | SQLCipher, миграции локальной схемы, восстановление, перенос | `db::`, `store::` | `npm run database:test` |
| Backend (Supabase) | миграции, RLS, RPC, функции писем на одноразовом стенде | `supabase/tests/*.py`, `src-tauri/tests/stack.rs` | только CI `cloud.yml` (нужен Docker) |
| Frontend | компоненты и состояние | Vitest + Testing Library | `npm test` |
| UI | раскладка при размерах окна и масштабах | `scripts/screenshots.cjs` на демо-интерфейсе (сравнение снимков — позже) | `npm run shots` |
| E2E | сценарии на настоящем ядре и стенде Supabase | `src-tauri/tests/stack.rs` (Scenario Runner удалён вместе с Beta, ADR-034) | CI `cloud.yml` |
| Build | сборка для macOS universal и Windows x64, проверка пакета и установщика | `desktop.yml`, `release.yml` | CI |
| Security | идентичность приложения, release-check, RLS-тесты стенда, CodeQL, dependency review | `identity::`, `tests/test_release_check.py`, `supabase/tests`, `codeql.yml` | `npm run test:core`, `npm run release:check`, CI |
| Regression | весь набор выше на каждом PR | `Desktop gate`, `Cloud gate`, `test`, `review`, `Analyze` | CI |

## 2. Идентичность и готовность релиза (после удаления Beta, ADR-034)

Тесты Beta, Debug Menu и Scenario Runner удалены вместе с кодом по решению Maksim 2026-11-11. Остались и
добавлены проверки того, что у пользователей ничего не сломается:

| Тест | Проверяет |
|---|---|
| `identity::tests::*` (3) | идентификатор, имя, схема ссылок, сервис Связки ключей, энтропия DPAPI и папки — как у прежних версий; идентификатор совпадает с `tauri.conf.json`; запуск с чужим идентификатором останавливается |
| `paths::tests::standard_folders_match_previous_versions` | папки данных и журналов прежние на macOS, Windows и Linux |
| `secrets::tests::secrets_keep_previous_names` | прежние имя Связки ключей и энтропия DPAPI |
| `cloud::config::tests::links_from_emails_return_to_the_app` | ссылки из писем ведут в приложение (`leadgenerator://`) |
| `reports::tests::crash_reports_of_old_beta_are_not_ours` | отчёты о сбоях старой Customers Beta не попадают в отчёты приложения |
| `updates::tests::never_picks_old_beta_installers` | файлы старых Beta-сборок не устанавливаются, даже если оказались в релизе |
| `app::data::tests::backups_go_to_default_folder_or_keep_using_the_legacy_one` | резервные копии — в «Документах», прежняя папка копий продолжает использоваться |
| `tests/test_release_check.py` (25) | `release-check.cjs` проходит на проекте и ловит 20 видов порчи (идентичность, конфигурация Beta, признак `beta`, модуль `debug`, команды `debug_*`, devtools, AppId и вариант Beta установщика, облако Beta, ключи сервера); тег с суффиксом отклоняется; `set-version.cjs` принимает только X.Y.Z |
| `tests/test_workflows.py::test_no_beta_channel_workflows` | ни один workflow не собирает и не публикует Beta и Pre-release |

## 2a. Резервные копии (пакет A1)

| Тест | Проверяет |
|---|---|
| `app::data::tests::backup_includes_crm_databases_and_restores_them` | в копии есть зашифрованная база Workspace и `catalog.json`; восстановление возвращает CRM к состоянию копии, текущая база сохраняется как `before-restore` |
| `app::data::tests::old_backups_without_crm_leave_workspaces_untouched_and_pruning_removes_crm_copies` | копия прежней версии не трогает CRM; старые копии удаляются вместе с папкой `.crm` |
| `app::data::tests::crm_copy_of_another_workspace_is_refused` | чужая база в копии отклоняется, CRM не меняется |
| `supabase/tests/test_backup.py` (3) | на стенде: снимок содержит `auth.users` и таблицы CRM, счёт строк из того же снимка; восстановление в пустую базу проходит; недостающие строки проваливают проверку |
| `tests/test_workflows.py::test_cloud_backup_is_daily_read_only_and_encrypts_before_storing` | расписание, права только на чтение, проверка восстановления до шифрования, в артефакт идёт только `.gpg` |

## 2b. Учёт миграций (пакет A2)

| Тест | Проверяет |
|---|---|
| `tests/test_migration_files.py` (3) | имена файлов — версии CLI, уникальны и по порядку; `register` записывает только миграции, применённые вручную до A2; `push` без истории и повторный `register` отклоняются, `--dry-run` перед применением |
| `tests/test_workflows.py::test_migrations_are_applied_only_manually_after_the_stand_and_approval` | только ручной запуск из `main`, стенд без секретов с `test_migrations.py`, применение после стенда в окружении `database` |

## 3a. Тесты этапов 3–7 (Workspace и CRM)

| Тест | Проверяет |
|---|---|
| `supabase/tests/test_workspaces.py` (19) | создание и лимит Workspace, личный Workspace идемпотентен, приглашение (токен один раз, чужая почта, повтор, отзыв), роли не выше своей, владелец не уходит без передачи, удалённый участник теряет доступ, чужой Workspace не виден |
| `supabase/tests/test_crm.py` (19) | права по ролям, `edit_own`, `crm_push`: идемпотентность, захват `op_id`, слияние полей, конфликт, правка удалённой записи, ссылки только внутри Workspace, статус и история сделки, задачи и напоминания, коллекции |
| `supabase/tests/test_migrations.py` (6) | повторное применение не меняет данные, старые миграции не тронуты, RLS везде, `search_path` у definer-функций, у `anon` нет прав, физического удаления нет |
| `workspace::*` (21, Rust) | очередь и слияние операций, проверки как на сервере, права, ссылки, сделки и задачи, корзина, загруженное не затирает неотправленное, отклонённое и отложенное, фильтры коллекций без SQL-инъекций, дубликаты, перенос лида, шифрование базы и привязка к Workspace, совпадение списков полей с миграциями |
| `tests/stack.rs::workspace_crm_sync_rights_and_conflicts` | на стенде: два пользователя, шаблон с сервера, приглашение, устаревшие права отклоняются сервером, конфликт поля, этап и история сделки, корзина, исключённый участник |
| `src/app/crm/crm.test.tsx` (13) | подписи и ввод полей, права в интерфейсе, эмодзи разделов, демо-ядро (версии, статусы, корзина, обязательные поля, дубликаты, коллекции, повторный перенос), место группы «Коллекции», аватары (4 и «+N», только облако), создание коллекции |

## 4. Журнал выполненных проверок

Чтобы не повторять уже сделанное: дата, что запущено, результат. SKIPPED и «только в CI» указываются явно.

| Дата | Где | Что | Результат |
|---|---|---|---|
| 2026-11-09 | контейнер (Linux) | `cargo test --locked` до изменений | 236 passed; `tests/stack.rs`: 2 теста завершились без проверки — нет переменных стенда (фактически SKIPPED) |
| 2026-11-09 | контейнер | `cargo fmt --check`, `cargo clippy -D warnings` (Stable и `--features beta`) | без замечаний |
| 2026-11-09 | контейнер | `cargo test --locked` и `cargo test --locked --features beta` после этапа 1 | 255 passed / 255 passed; `stack.rs` — 2 без стенда (SKIPPED) |
| 2026-11-09 | контейнер | `npm run typecheck`, `npm test`, `npm run build`, `npm run release:check` | типы без ошибок; 44 passed; сборка есть; 22 пункта пройдены |
| 2026-11-09 | контейнер | `python -m pytest` (как в CI, покрытие ≥ 90 %) | 166 passed, покрытие 90.57 % |
| 2026-11-09 | контейнер | `npm run debug:build` + запуск под Xvfb | создаются только `~/.local/share/customers-beta` и `local.customers.beta`; при чужой метке — окно с отказом, ничего не записано |
| 2026-11-09 | CI (PR #90) | Cloud: тест стенда нашёл имя серверной роли в `release-check.cjs` | исправлен `release-check.cjs`, тест не менялся |
| 2026-11-09 | контейнер | этап 2: `cargo fmt --check`, `cargo clippy --lib --bins -D warnings` (Stable и Beta) | без замечаний |
| 2026-11-09 | контейнер | этап 2: `cargo test --locked` / `--features beta` | Stable 255 passed (без изменений); Beta 268 passed + `tests/scenarios.rs` 2 passed (13 сценариев PASS); `stack.rs` — 2 без стенда (SKIPPED) |
| 2026-11-09 | контейнер | этап 2: `npm run typecheck`, `npm test`, `npm run build`, `npm run release:check`, `python -m pytest` | типы без ошибок; 48 passed; модуль `DebugMenu` выделен в отдельный файл сборки; 26 пунктов пройдены; pytest 171 passed |
| — | CI | macOS/Windows, установщик Beta рядом со Stable, стенд Supabase | см. проверки PR #90 |
| 2026-11-09 | контейнер | этап 2: сборка `customers-beta` (release) и запуск под Xvfb | запускается; `events.jsonl` в папке журналов Beta с записью о запуске; папок Stable не появилось |
| 2026-11-10 | контейнер | этапы 3–7: `python -m pytest supabase/tests` на локальном стенде (Postgres 16 + GoTrue + PostgREST без Docker) | 96 passed |
| 2026-11-10 | контейнер | этапы 3–7: `cargo test --locked` / `--features beta`; `cargo fmt --check`; `cargo clippy --lib --bins -D warnings` | Stable 276 passed, Beta 289 passed + сценарии; без замечаний |
| 2026-11-10 | контейнер | этапы 3–7: `cargo test --test stack` с переменными локального стенда | 3 passed (впервые в контейнере не SKIPPED) |
| 2026-11-10 | контейнер | этапы 3–7: `npm run typecheck`, `npm test`, `npm run build`, `npm run release:check` | типы без ошибок; 61 passed; сборка есть; 26 пунктов пройдены |
| 2026-11-10 | контейнер | этапы 3–7: снимки демо-интерфейса (Playwright, 1440×860) | коллекции, карточки компании и сделки, аватары, диалог коллекции, перенос лида, окно Workspace — без ошибок в консоли |
| — | CI | macOS/Windows, масштабы 125–200 %, стенд Supabase с Docker | см. проверки PR #90 |
