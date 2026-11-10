# Процесс разработки

## 1. Ветки

| Ветка | Что в ней | Как попадает |
|---|---|---|
| `main` | единственная постоянная ветка: Stable, из неё собираются релизы и Beta | только PR (из `feature/*` или `hotfix/*`) после зелёных обязательных проверок; без прямого push |
| `feature/<задача>` | крупная задача (например, `feature/workspaces`) | ветвится от `main`, PR в `main` |
| `hotfix/<задача>` | срочное исправление Stable | от `main`, PR в `main` |

Ветка `develop` закрыта 2026-11-10: всё из неё перенесено в `main`.

Защиту веток (Rulesets) настраивает владелец репозитория — см. RELEASE_PROCESS.md §4; автоматическое слияние
непроверенного кода в `main` запрещено.

## 2. Цикл

1. Изменение в `feature/*` → PR в `main` (CI: Desktop gate, Cloud gate, тесты, release-check).
2. Для проверки — тег `vX.Y.Z-beta.N` на коммите `main` (или ручной запуск `beta.yml` на ветке) → Beta для macOS и
   Windows, по тегу — Pre-release (Beta-канал).
3. Ручная проверка Beta (RELEASE_CHECKLIST.md), ошибки исправляются через PR в `main`, новая Beta `-beta.N+1`.
4. Тег `vX.Y.Z` → `release.yml` собирает Stable, проверяет установщики, ждёт подтверждения в окружении
   `production` и публикует релиз.

## 3. Версии

* SemVer `MAJOR.MINOR.PATCH`; Beta — `MAJOR.MINOR.PATCH-beta.N` (1.5.0-beta.1, 1.5.0-beta.2 → 1.5.0).
  Исторические четырёхчастные Stable-версии (1.0.6.2) по-прежнему принимаются.
* Источник версии — тег. `node desktop/scripts/set-version.cjs <версия>` пишет её в `package.json`,
  `tauri.conf.json`, `Cargo.toml`; `release-check.cjs --tag <тег>` проверяет, что всё совпадает.
  В репозитории между релизами лежит версия последнего Stable.
* Beta-сборка не может изменить версию Stable: это другое приложение (свой идентификатор и установка).
  Stable не видит Pre-release; Beta не ставит Stable-релизы.

## 4. Команды (`cd desktop`)

| Команда | Что делает |
|---|---|
| `npm run dev` | интерфейс в браузере с демо-данными (`?beta` — с меткой Beta) |
| `npm run dev:beta` | настоящее приложение Beta из исходников |
| `npm run typecheck` / `npm test` | типы / тесты интерфейса (Vitest) |
| `npm run test:core` | тесты Rust-ядра (Stable) |
| `npm run debug:test` | тесты Rust-ядра с признаком `beta` |
| `npm run debug:isolation` | только тесты разделения каналов |
| `npm run database:test` | тесты баз (`db::`, `store::`) |
| `npm run release:check` | готовность: версии, идентификаторы каналов, отсутствие Beta и devtools в Stable, секреты |
| `npm run debug:build` | сборка Customers Beta |
| `npm run release:build` | сборка Customers (Stable) |
| `npm run check` | всё быстрое подряд: типы, тесты интерфейса, ядро Stable и Beta, release-check |

Из корня: `python -m pytest` — тесты Python, workflow и разделения каналов (`tests/test_channels.py`).
Команды этапов 2–3 (`debug:scenario`, `debug:diagnostics`, `debug:ui`, `debug:reset`, `crm:test`, `crm:security`,
`crm:sync:test`) появятся вместе с кодом, который они запускают; пустых команд-заглушек нет.

`npx tauri dev` без beta-конфигурации запускаться не будет (защита данных Stable, DEBUG_BUILD.md §2).
