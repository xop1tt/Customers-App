# Учёт и применение миграций (пакет A2)

Источник истины схемы — файлы `supabase/migrations/ГГГГММДДччммсс_имя.sql` (только добавляющие, CLAUDE.md §6).
История применения рабочего проекта хранится там же, где её ведёт Supabase CLI:
`supabase_migrations.schema_migrations`. Применение — workflow **Migrate** (ADR-044).

## Как применить новую миграцию

1. PR с миграцией: стенд и CI зелёные (`cloud.yml`), PR слит в `main`.
2. Maksim: **Actions → Migrate → Run workflow → action = push**.
3. Задача `stand` поднимает одноразовый стенд из `main` (все миграции с нуля), повторяет `test_migrations.py`
   (повторное применение, RLS, `search_path`, нет `drop`).
4. Задача `apply` ждёт подтверждения в окружении `database` → `supabase db push --dry-run` (список ждущих) →
   `supabase db push` (применяет только ждущие и записывает их в историю) → `migration list`.
5. Проверка read-only запросом (Claude делает сам после запуска).

`action = status` показывает применённые и ждущие миграции, ничего не меняя.

## Один раз: записать историю ручного применения

До A2 все 17 миграций (по `20261111100000_marketplace.sql` включительно) применены вручную через SQL Editor —
проверено read-only запросом 2026-11-11 (есть все таблицы и функции, схемы `supabase_migrations` нет).
**Actions → Migrate → action = register** записывает в историю только эти миграции (`supabase migration repair
--status applied`), схему не меняет. Повторный `register` отклоняется; `push` без истории отклоняется, чтобы не
применить всё заново.

## Настройка (один раз, Maksim)

1. Секрет `SUPABASE_DB_URL` уже нужен для резервных копий (docs/BACKUP.md) — тот же.
2. **Settings → Environments → New environment `database`**: *Required reviewers* — Maksim;
   *Deployment branches and tags* — только `main`. Без ревьюера окружение создастся само и применение пойдёт
   без подтверждения.
3. Запустить **Migrate → register**, затем **Migrate → status**: все 17 миграций в колонке Remote.

## Откат

Миграции только добавляющие, откат приложения базу не откатывает (expand/contract, CLAUDE.md §6). Ошибочная
миграция исправляется новой миграцией. Перед `push` есть ежедневный снимок (docs/BACKUP.md); при сомнении —
**Actions → Cloud backup → Run workflow** перед применением.
