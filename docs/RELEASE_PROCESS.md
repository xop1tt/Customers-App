# Выпуск Beta и Stable

Публикация Stable всегда требует отдельного подтверждения Maksim. Claude не делает push, слияние в `main`,
публикацию релиза и необратимые операции без его разрешения в треде.

## 1. Beta (Pre-release)

1. `develop` зелёный (Desktop gate, Cloud gate, test, review, Analyze).
2. `node desktop/scripts/set-version.cjs 1.3.0-beta.1`, коммит «Версия 1.3.0-beta.1» в `develop`
   (или без коммита: тег берёт версию сам, release-check сверит).
3. Тег: `git tag v1.3.0-beta.1 && git push origin v1.3.0-beta.1`.
4. `beta.yml`: проверки (типы, тесты интерфейса, ядро Stable и Beta, release-check с тегом, облако Beta не равно
   рабочему) → сборки macOS universal и Windows x64 → проверка пакета (идентификатор, ссылки, имя файла) и
   установщика рядом со Stable (`check.ps1 -Channel beta`) → публикация **Pre-release** (окружение `beta`).
5. Ручная проверка по RELEASE_CHECKLIST.md §1, ошибки — в `develop`, следующий тег `-beta.2`.

## 2. Stable

1. Beta-версия прошла RELEASE_CHECKLIST.md целиком.
2. PR `develop` → `main`: обязательные проверки зелёные, описание с итогом проверки Beta.
3. Слияние PR (человеком).
4. Тег `vX.Y.Z` на коммите слияния (или Actions → Release → Run workflow с тегом).
5. `release.yml`: release-check с тегом (версии, идентификаторы Stable прежние, Beta не включена, нет devtools,
   нет секретов) → тесты → сборки → проверка установщика Windows (установка, обновление поверх с сохранением
   данных, удаление) и пакета macOS → задача `publish` **ждёт подтверждения** в окружении `production` →
   GitHub Release с файлами `Customers-vX.Y.Z-*` → установленные Stable-версии видят обновление
   (`releases/latest`).

Теги Beta (`v*-*`) `release.yml` не запускают; Stable-приложение не видит Pre-release и файлы `Customers-Beta-*`.

## 3. Отмена

* Ошибка в Pre-release — новая Beta с исправлением; старый Pre-release можно удалить (Beta не обновляется сама).
* Ошибка в Stable — hotfix `vX.Y.Z+1`. Релиз не удаляется, если его уже скачали: исправление выпускается поверх.

## 4. Что владелец репозитория настраивает в GitHub (из workflow это сделать нельзя)

1. **Settings → Environments → New environment `production`**: *Required reviewers* — Maksim;
   *Deployment branches and tags* — только теги `v*` (Selected tags). Без ревьюера окружение создастся само при
   первом запуске, но без подтверждения — тогда публикация пойдёт сразу.
2. **Environment `beta`** — по желанию с ревьюером (Pre-release не попадает к пользователям Stable).
3. **Rulesets → `main`**: запрет прямого push и force push, обязательный PR, обязательные проверки `Desktop gate`,
   `Cloud gate`, `test`, `review`, `Analyze (…)` (как в docs/ci.md). Тот же набор — для `develop`, но без
   обязательного ревью.
4. **Variables** (по желанию): `SUPABASE_BETA_URL`, `SUPABASE_BETA_ANON_KEY` — отдельный проект Supabase для Beta.
