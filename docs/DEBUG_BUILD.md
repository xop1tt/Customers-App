# Debug/Beta: отдельная версия рядом со Stable

Статус: **реализовано** (этап 1). Сборки macOS и Windows и установщик Beta проверяются в GitHub Actions
(`beta.yml`); в облачном контейнере разработки проверены Linux-сборка Beta, её запуск и отказ при чужой метке.

## 1. Что отличается

| | Stable (`Customers`) | Beta (`Customers Beta`) |
|---|---|---|
| Сборка | `npm run release:build` (`tauri build`) | `npm run debug:build` (`--features beta --config src-tauri/tauri.beta.conf.json`), а также любая отладочная сборка |
| Идентификатор | `local.leadgenerator.app` (прежний) | `local.customers.beta` |
| Приложение | `Customers.app`, `Customers.exe`, исполняемый файл `customers` | `Customers Beta.app`, `Customers Beta.exe`, `customers-beta` |
| Данные macOS | `~/Library/Application Support/Lead Generator`, журналы `~/Library/Logs/LeadGenerator` | `~/Library/Application Support/Customers Beta`, `~/Library/Logs/Customers Beta` |
| Данные Windows | `%LOCALAPPDATA%\Customers` | `%LOCALAPPDATA%\Customers Beta` |
| Данные Linux (разработка) | `~/.local/share/customers` | `~/.local/share/customers-beta` |
| Настройки WebView, состояние окна | папка по идентификатору `local.leadgenerator.app` | папка `local.customers.beta` |
| Секреты и ключи баз | Связка ключей «LeadGenerator» / DPAPI `Customers.Secrets.v1` | Связка ключей «Customers Beta» / DPAPI `Customers.Beta.Secrets.v1`, файлы в своей папке |
| Резервные копии | `Документы/Customers Backups` (и прежняя `Lead Generator Backups`) | `Документы/Customers Beta Backups` |
| Ссылки из писем | `leadgenerator://` | `customers-beta://` |
| Установщик Windows | AppId `{6B0F7C1E-…}`, `%LOCALAPPDATA%\Programs\Customers` | AppId `{A3E4C2B8-…}`, `%LOCALAPPDATA%\Programs\Customers Beta` |
| Образ macOS | `Customers-vX.Y.Z-macOS.dmg` с `Customers.app` | `Customers-Beta-vX.Y.Z-beta.N-macOS.dmg` с `Customers Beta.app` (ложится рядом) |
| Автозапуск, уведомления, значок в трее | по имени/идентификатору Stable | свои (имя `Customers Beta`, свой идентификатор) |
| Облако | `SUPABASE_URL`, `SUPABASE_ANON_KEY` (рабочий проект) | только `SUPABASE_BETA_URL`, `SUPABASE_BETA_ANON_KEY` (отдельный проект); без них — без облака |
| Обновления | `releases/latest` (без Pre-release), только файлы `Customers-v…` | встроенная проверка выключена; новые сборки — со страницы Pre-release |
| Отчёты о сбоях | файлы `customers…`, `Customers…`, `LeadGenerator…` (кроме Beta) | только `customers-beta…`, `Customers Beta…` |
| Метка в интерфейсе | нет | «Beta» рядом с названием в левой панели |

Код: `desktop/src-tauri/src/channel.rs` (все значения), `paths.rs` (`AppPaths::for_channel`), `secrets.rs`
(`channel_store`), `cloud/config.rs` (`embedded`), `shell.rs` (запуск), `installer/Customers.iss` (`/DBeta`),
`scripts/make-dmg.sh`.

## 2. Защита от пересечения

Проверяется **до создания любых файлов** (`shell::refuse_if_not_isolated` и повторно в `build_env`):

1. Идентификатор из конфигурации Tauri совпадает с каналом сборки. Пример: `npx tauri dev` без beta-конфигурации
   даёт отладочную сборку (канал Beta) с идентификатором Stable — запуск остановится с объяснением
   «используйте npm run dev:beta».
2. Папки данных, журналов и копий канала не совпадают и не вложены в папки другого канала (с учётом `..`,
   ссылок и регистра букв на macOS/Windows).
3. Метка `channel.json` в папке данных: Beta ставит свою и не работает в папке с чужой меткой; Stable метку
   **не пишет** (её папка не меняется), но отказывается работать в папке с меткой Beta.

При нарушении — окно с объяснением и выход; база не открывается, журналы и настройки не пишутся.

Во время работы тем же правилом проверяется каждый путь, выбранный пользователем: перенос базы, восстановление
из копии, экспорт в файл, папка резервных копий, открытие базы по сохранённому пути. Путь в данные другого канала
отклоняется с сообщением, файл не меняется. Beta, кроме того, не открывает **незашифрованные** базы (их могла
создать только Stable 1.0; открытие переписало бы файл ключом Beta).

Даже если всё это обойти, Beta не прочитает базу Stable: ключ шифрования Stable лежит в другом хранилище секретов.

## 3. Миграции

Внедрение каналов не меняет данные Stable: никаких миграций, меток или новых файлов в её папках. Stable-сборка
из этой ветки ведёт себя как прежде (тесты `paths::standard_folders_match_previous_versions`,
`channel::stable_identity_matches_previous_versions`, `release-check`).

## 4. Как пользоваться

```bash
cd desktop
npm run dev:beta          # приложение Beta из исходников (горячая перезагрузка интерфейса)
npm run debug:build       # сборка Customers Beta для своей системы
npm run debug:test        # тесты ядра с признаком beta
npm run debug:isolation   # только тесты разделения каналов
npm run release:check     # статическая проверка: версии, идентификаторы, отсутствие Beta в Stable
```

Готовые сборки Beta: Actions → Beta → артефакты `beta-macos`, `beta-windows` (ручной запуск) или
Releases → Pre-release (тег `vX.Y.Z-beta.N`). Обе версии ставятся и работают одновременно.

Облако Beta (по желанию): создать отдельный бесплатный проект Supabase по `docs/cloud-setup.md`, добавить в
настройках репозитория переменные `SUPABASE_BETA_URL` и `SUPABASE_BETA_ANON_KEY`, в Auth → URL Configuration
разрешить `customers-beta://auth/callback`. Сборка остановится, если адрес совпадёт с рабочим.

## 5. Ограничения

* Встроенное обновление Beta не сделано (этап 2): сейчас Beta обновляется установкой новой сборки поверх.
* Подпись macOS для Beta — ad-hoc; при первом запуске нужно «Открыть» через контекстное меню.
* Ключи OAuth облачных дисков в Beta не встраиваются (подключение дисков вручную, как в сборке без ключей).
* Проверено в контейнере (Linux): сборка Beta, запуск, создание только своих папок, отказ при чужой метке.
  macOS и Windows (Связка ключей, DPAPI, установщик рядом со Stable) — в CI `beta.yml` и `desktop.yml`.
