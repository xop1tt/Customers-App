# Фоновое обслуживание облачной базы

Пакет A3, ADR-045. Цель — база Supabase Free не растёт без предела.

## Что и когда удаляется

Раз в сутки (03:41 UTC) workflow `.github/workflows/maintenance.yml` вызывает Edge Function `maintenance`, она —
`public.platform_maintenance()` (миграция `20261111120000_maintenance.sql`).

| Данные | Срок хранения |
|---|---|
| журнал синхронизации `sync_ops` | 30 дней |
| удалённые записи CRM (надгробия `deleted_at`) | 90 дней после удаления |
| журнал доставок маркетплейса `private.market_deliveries` | 30 дней |
| уведомления `notifications` | 90 дней |
| отметки присутствия `workspace_presence` | 1 день |
| служебные журналы почты (`email_requests`, `email_tickets`, `email_sends`) | 8 дней |
| итоги запусков `private.maintenance_runs` | 400 дней |

Не удаляются никогда: журнал аудита `audit_log`, конфликты синхронизации `sync_conflicts`, живые записи CRM.
Надгробие, на которое ещё ссылаются другие записи, остаётся до следующего запуска.

Удалённая запись старше 90 дней не восстанавливается из облака; её можно вернуть только из резервной копии
(docs/BACKUP.md, копии хранятся 90 дней).

## Защита

* Функцию вызывает только Edge Function с ключом `service_role`; у `anon` и `authenticated` нет права её выполнять.
* Edge Function принимает только `POST` с заголовком `x-cron-secret`, равным секрету `CRON_SECRET` (не короче 16
  символов). Из запроса ничего не берётся: сроки заданы в миграции.

## Что нужно один раз

1. Применить миграцию: **Actions → Migrate → Run workflow → push** (docs/MIGRATIONS.md).
2. Загрузить функцию: `npx supabase functions deploy maintenance --project-ref REF --no-verify-jwt`.
3. `CRON_SECRET` и `SUPABASE_URL` уже нужны для «Inactive accounts»; если они заданы, ничего добавлять не надо.
4. Запустить вручную **Actions → Maintenance → Run workflow** и убедиться, что ответ `{"ok":true,...}`.

## Проверка

Последние запуски (только чтение, SQL Editor):

```sql
select at, result from private.maintenance_runs order by id desc limit 7;
```

Тесты: `supabase/tests/test_maintenance.py` (стенд), `tests/test_workflows.py::test_maintenance_job_is_daily_and_uses_only_the_cron_secret`.
