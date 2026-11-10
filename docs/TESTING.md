# Тестирование

Правила: существующие тесты не отключаются и не ослабляются; SKIPPED — не PASS; моки допустимы только в
изолированных unit-тестах и не выдаются за проверку настоящего Supabase. Карта покрытия по модулям — wiki
«Тестирование».

## 1. Категории и где они живут

| Категория | Что | Где | Запуск |
|---|---|---|---|
| Unit | чистая логика Rust и TypeScript | `#[cfg(test)]` в модулях, `desktop/src/**/*.test.ts(x)` | `npm run test:core`, `npm test` |
| Integration (ядро) | `Core` целиком на временной папке, секреты в памяти, сеть — заглушка | `app/*` тесты (`app::testing::fixture`, `fixture_channel`) | `npm run test:core` |
| Database | SQLCipher, миграции локальной схемы, восстановление, перенос | `db::`, `store::` | `npm run database:test` |
| Backend (Supabase) | миграции, RLS, RPC, функции писем на одноразовом стенде | `supabase/tests/*.py`, `src-tauri/tests/stack.rs` | только CI `cloud.yml` (нужен Docker) |
| Frontend | компоненты и состояние | Vitest + Testing Library | `npm test` |
| UI | раскладка при размерах окна и масштабах | Debug Menu → «Интерфейс» (размеры, масштаб, поиск переполнения), `scripts/screenshots.cjs` (сравнение снимков — позже) | Debug Menu, `npm run shots` |
| E2E | сценарии пользователя на настоящем ядре | Scenario Runner (`debug/scenarios.rs`, `src-tauri/tests/scenarios.rs`) | Debug Menu → «Сценарии», `npm run debug:scenario` |
| Build | сборка Stable и Beta для macOS universal и Windows x64, проверка пакета | `desktop.yml`, `beta.yml`, `release.yml` | CI |
| Security | изоляция каналов, release-check, RLS-тесты стенда, CodeQL, dependency review | `channel::`, `tests/test_channels.py`, `supabase/tests`, `codeql.yml` | `npm run debug:isolation`, `npm run release:check`, CI |
| Regression | весь набор выше на каждом PR | `Desktop gate`, `Cloud gate`, `test`, `review`, `Analyze` | CI |

## 2. Тесты этапа 1 (разделение Stable и Beta)

| Тест | Проверяет |
|---|---|
| `channel::tests::*` (11) | различие всех изолирующих значений; значения Stable прежние; отладочная сборка — всегда Beta; отказ при чужом идентификаторе; совпадение/вложенность папок, `..`, символьные ссылки; пути пользователя в данные другого канала; метка канала (Beta пишет, Stable не пишет, обе отказываются от чужой) |
| `paths::tests::stable_channel_is_the_previous_layout_and_beta_is_separate` | Stable = прежние папки, Beta — свои, без файла настроек прежней версии |
| `secrets::tests::stable_secrets_keep_previous_names_and_beta_gets_its_own` | прежние имя Связки ключей и энтропия DPAPI у Stable; Beta не видит секреты Stable |
| `cloud::config::tests::beta_links_return_to_beta` | ссылки писем Beta ведут в Beta |
| `reports::tests::crash_reports_of_channels_do_not_mix` | отчёты о сбоях каналов не смешиваются |
| `updates::tests::stable_never_picks_beta_installers` | Stable не ставит файлы Beta |
| `app::data::tests::paths_into_other_channel_are_refused_and_nothing_changes` | перенос, восстановление, экспорт, копия в данные другого канала отклоняются в обоих каналах, файл не меняется |
| `app::data::tests::beta_keeps_backups_in_its_own_folder` | копии Beta — в своей папке, прежняя папка Stable не используется |
| `app::data::tests::beta_refuses_plaintext_database_without_touching_it` | Beta не переписывает незашифрованную базу |
| `src/app/channel.test.tsx` | метка Beta в левой панели только в Beta |
| `tests/test_channels.py` (21) | `release-check.cjs` проходит на проекте и ловит 14 видов порчи конфигурации; `set-version.cjs` принимает Beta-версии |
| `tests/test_workflows.py` (новые 3) | Beta публикует только Pre-release по тегу Beta; Stable-релиз игнорирует теги Beta и ждёт окружение `production`; CI запускает тесты Beta и release-check |

## 3. Тесты этапа 2 (Debug Menu)

| Тест | Проверяет |
|---|---|
| `debug::log::tests` (3) | маскирование токенов, ключей, паролей, почты, телефонов и путей до записи в память и файл; даты и числа не портятся; кольцевой буфер, фильтры, сохранение после перезапуска, очистка; экспорт текстом и JSON Lines |
| `debug::zip::tests` (2) | CRC-32 по эталону; архив читается обратно, порча содержимого обнаруживается (дополнительно вручную: `unzip -t` и Python `zipfile`) |
| `debug::dashboard::tests` (1) | настоящие версия, канал, Tauri, PID, память; состояния компонентов до и после входа; CPU со второго замера |
| `debug::diagnostics::tests` (3) | без входа проверки базы — SKIPPED, после входа — PASS; пробные файлы удаляются; чужая метка канала — FAIL; проверка Supabase идёт в `/auth/v1/health`, ответ 503 — FAIL; ZIP содержит отчёты, не содержит пароль и базы; в папку другого канала не сохраняется |
| `debug::testdata::tests` (4) | детерминированность; отказ без отметки «тестовая»; генерация, повторная генерация, удаление только тестовых, сброс со словом; 10 000 лидов одной транзакцией |
| `tests/scenarios.rs` (2) | все 13 сценариев PASS на настоящем ядре, временная папка удалена, в папке другого канала ничего нет; запуск одного сценария, отказ на неизвестный |
| `src/debug/debug.test.tsx` (4) | в Stable нет пункта меню и сочетания клавиш; в Beta открывается из меню и `Ctrl/Cmd+Shift+D`; запуск сценариев и итог; фильтр журнала |
| `tests/test_channels.py` (новые 5 поломок) | `release-check` ловит признак `beta` с лишними признаками, зависимость Debug Menu без `optional`, незарегистрированную команду, команду без префикса `debug_` и команду Debug Menu в обработчике Stable |

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
