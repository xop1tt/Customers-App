# CI, Dependabot и автослияние

Описание того, что проверяется в каждом PR, как обновляются зависимости и что нужно включить в настройках GitHub.

## Workflow

| Файл | Когда запускается | Что делает |
| --- | --- | --- |
| `desktop.yml` | PR в любую ветку, push в `main` и `develop` по путям `desktop/**` | Интерфейс (типы, тесты, release-check, сборка); Rust на Ubuntu, macOS и Windows (`cargo test --locked` и с признаком `beta`, на Ubuntu ещё `cargo fmt --check`, `cargo clippy -D warnings` и проверка актуальности `Cargo.lock`); сборка macOS (universal .app) и Windows (exe). Итог: проверка **Desktop gate**. |
| `cloud.yml` | то же для `supabase/**` и облачного модуля | Миграции, функции и клиент на одноразовом стенде. Итог: **Cloud gate**. |
| `tests.yml` | каждый PR и push в `main` | Python-тесты с порогом покрытия 90 %. Проверка называется `test`. |
| `codeql.yml` | каждый PR, push в `main`, раз в неделю | Статический анализ: actions, python, javascript-typescript, rust. |
| `dependency-review.yml` | каждый PR | Блокирует PR с новой зависимостью с известной уязвимостью (high и выше). Проверка называется `review`. |
| `dependabot-automerge.yml` | PR от Dependabot | Включает автослияние по политике ниже. Сам ничего не сливает. |
| `release.yml` | вручную или по тегу `v*` (кроме `v*-*`) | Единственный workflow, который публикует Stable-релиз; задача `publish` ждёт подтверждения в окружении `production`. PR и Dependabot его не запускают. |
| `beta.yml` | push в `develop`, тег `vX.Y.Z-beta.N`, вручную | Сборка Customers Beta (macOS, Windows, проверка установки рядом со Stable). Публикует только Pre-release и только по тегу Beta (окружение `beta`). См. DEBUG_BUILD.md. |
| `search.yml`, `diagnose.yml`, `wiki.yml` | вручную / push в `main` | Прежние процессы, не менялись. |

**Почему «gate».** У `desktop.yml` и `cloud.yml` нет фильтра путей на уровне workflow: его заменяет задача `changes`. Если PR не трогает `desktop/` (например, обновление pip), тяжёлые задачи пропускаются, а `Desktop gate` всё равно сообщает «успех». Иначе обязательная проверка висела бы в ожидании и PR нельзя было бы слить. Пропущенные матричные задачи отображаются с неразвёрнутым именем, поэтому обязательными делают именно gate, а не отдельные задачи матрицы.

Все workflow используют `permissions: contents: read`; повышенные права только в задачах `release.yml/publish`, `wiki.yml/publish`, `codeql.yml/analyze` и `dependabot-automerge.yml/automerge`. Секреты нужны только `release.yml`, `search.yml` и `diagnose.yml`; PR из форков их не получают. `pull_request_target` используется один раз (автослияние), код PR там не скачивается и не запускается. Действия закреплены полными SHA, это проверяет `tests/test_workflows.py`. Устаревшие запуски PR отменяются (`concurrency`).

## Dependabot

Экосистемы: `github-actions` (`/`), `npm` (`/desktop`), `cargo` (`/desktop/src-tauri`), `pip` (`/` и `/supabase/tests`). Проверка раз в неделю по понедельникам в 06:00 по Москве, не больше 5 открытых PR на экосистему (3 для pip). Обновления сгруппированы:

* Actions: одна группа minor и patch.
* npm: `tauri-js` (`@tauri-apps/*`, любые версии), `npm-dev`, `npm-prod` (minor и patch).
* Cargo: `tauri-rust` (`tauri`, `tauri-*`, `wry`, `tao`), `storage-crypto` (`rusqlite`, `sha2`, `hmac`, `pbkdf2`, `rand`…), остальное minor и patch одной группой.
* pip: одна группа minor и patch.
* Security-обновления идут отдельными группами `*-security`, вне расписания и лимита.
* `@types/node` major игнорируется: типы должны совпадать с Node 22 из CI.

Major-обновления вне групп приходят отдельными PR. Зависимости Deno функций Supabase (`supabase/functions/deno.lock`) Dependabot не обновляет, их меняют вручную.

## Политика автослияния Dependabot

Автослияние включается, только если одновременно: PR создан `dependabot[bot]` из этого же репозитория, не черновик, все обновляемые зависимости проходят политику, и в `main` настроены обязательные проверки (иначе GitHub слил бы PR сразу).

Разрешено: patch любых зависимостей; minor для GitHub Actions и dev-зависимостей.

Только вручную:

* любые major;
* Tauri (`tauri`, `tauri-*`, `wry`, `tao`, `@tauri-apps/*`), Rust-инструментарий;
* база данных и криптография (`rusqlite`, `libsqlite3-sys`, `sha2`, `hmac`, `pbkdf2`, `rand`, `ring`, `rustls`, `webpki`, `openssl`, `aes`, `argon2`, `chacha20`);
* minor production-зависимостей, а также `typescript`, `vite`, `@vitejs/*`;
* всё, что не удалось классифицировать.

Если после нового коммита PR перестал подходить, ранее включённое автослияние снимается. Слияние происходит только после зелёных обязательных проверок; security-обновления проходят те же проверки. Релиз автослиянием не публикуется: `release.yml` запускается только вручную или тегом.

## Что нужно включить в настройках GitHub

Эти настройки сделать из workflow нельзя, они в **Settings** репозитория.

1. **General → Pull Requests**: включить *Allow auto-merge*; по желанию включить *Automatically delete head branches*.
2. **Rules → Rulesets → New branch ruleset** (или Branches → Add branch protection rule) для `main`, Enforcement *Active*:
   * *Restrict deletions* и *Block force pushes*;
   * *Require a pull request before merging* (запрет прямого push);
   * *Require status checks to pass* и *Require branches to be up to date before merging*, обязательные проверки:
     `Desktop gate`, `Cloud gate`, `test`, `review`, `Analyze (actions)`, `Analyze (python)`, `Analyze (javascript-typescript)`, `Analyze (rust)`;
   * *Require conversation resolution before merging*;
   * не добавлять ботов и Dependabot в *Bypass list*, а в классической защите включить *Do not allow bypassing the above settings*.
   Merge при конфликтах и при красных проверках GitHub блокирует сам, как только включены обязательные проверки.
3. **Code security**: включить *Dependabot alerts* и *Dependabot security updates*; *Code scanning → default setup* оставить выключенным (его заменяет `codeql.yml`).
4. **Actions → General**: *Workflow permissions* = *Read repository contents* и *Allow GitHub Actions to create and approve pull requests* выключено; *Fork pull request workflows* = *Require approval for first-time contributors*.
5. После включения защиты один раз открыть любой PR, дождаться запуска проверок и только тогда выбирать их в списке обязательных (GitHub предлагает только те имена, которые уже встречались).

## Ограничения

* Раньше `dependabot-automerge.yml` был привязан к старому имени репозитория `xop1tt/CLIENTS` и не срабатывал; теперь проверяется владелец, а не имя.
* Работа workflow на GitHub проверяется только реальными запусками: локально проверены синтаксис, политика автослияния и условия `tests/test_workflows.py`.
* В `main` могла остаться устаревшая конфигурация CodeQL `swift` от старого Swift-приложения: сообщение «1 configuration not found» безвредно, отдельная проверка для Swift не нужна.
