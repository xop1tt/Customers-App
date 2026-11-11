# Выпуск релиза

Канал один (ADR-034): Beta, Preview и Pre-release не выпускаются. Публикация релиза всегда требует отдельного
подтверждения Maksim. Claude не делает слияние в `main`, публикацию релиза и необратимые операции без его
разрешения в треде.

## 1. Релиз

1. Исправления и функции слиты в `main`, обязательные проверки зелёные (Desktop gate, Cloud gate, test, review,
   Analyze); RELEASE_CHECKLIST.md выполнен.
2. Заметки релиза `.github/release-notes/vX.Y.Z.md` слиты в `main` через PR.
3. Тег `vX.Y.Z` на коммите `main` (или Actions → Release → Run workflow с тегом). Версия в файлах берётся из
   тега (`set-version.cjs`), отдельный коммит с версией не нужен.
4. `release.yml`: release-check с тегом (версии, прежние идентификаторы, нет признака `beta`, модуля `debug` и
   devtools, нет ключей сервера) → тесты → сборки → проверка установщика Windows (установка, обновление поверх с
   сохранением данных, удаление) и пакета macOS → задача `publish` **ждёт подтверждения** в окружении
   `production` → GitHub Release с файлами `Customers-vX.Y.Z-*` → установленные версии видят обновление
   (`releases/latest`).

Теги с суффиксом (`v*-*`) `release.yml` не запускают, а release-check их отклоняет. Приложение никогда не ставит
файлы старых Beta-сборок (`Customers-Beta-*`), даже если они окажутся в релизе.

## 2. Отмена

* Ошибка в релизе — hotfix `vX.Y.Z+1`. Релиз не удаляется, если его уже скачали: исправление выпускается поверх.

## 3. Что владелец репозитория настраивает в GitHub (из workflow это сделать нельзя)

1. **Settings → Environments → `production`**: *Required reviewers* — Maksim; *Deployment branches and tags* —
   только теги `v*` (Selected tags). Без ревьюера окружение создастся само при первом запуске, но без
   подтверждения — тогда публикация пойдёт сразу.
2. **Rulesets → `main`**: запрет прямого push и force push, обязательный PR, обязательные проверки `Desktop gate`,
   `Cloud gate`, `test`, `review`, `Analyze (…)` (как в docs/ci.md). Постоянной второй ветки нет.
3. После удаления Beta (ADR-034) можно удалить окружение `beta`, переменные `SUPABASE_BETA_URL` и
   `SUPABASE_BETA_ANON_KEY`, а также старые Pre-release и теги `v*-beta.*`: workflow их больше не используют.
