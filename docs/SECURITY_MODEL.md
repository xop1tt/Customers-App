# Модель безопасности

Принцип: права проверяет PostgreSQL. Интерфейс скрывает недоступные действия только для удобства; любой запрос
мимо интерфейса (curl с JWT пользователя) получает тот же отказ.

## 1. Что уже есть (до 2.0, проверено стендом `supabase/tests`)

* В приложении — только адрес проекта и публичный ключ (`CloudConfig::is_public_key` отклоняет `sb_secret_…` и JWT
  с ролью не `anon`). `service_role` есть только у Edge Functions на сервере.
* RLS `auth.uid() = user_id` на `leads`, `exclusions`, `user_settings`; `anon` прав не имеет; схема `private` закрыта.
* `sync_push` — security invoker; триггер `sync_stamp` запрещает смену владельца и время из будущего.
* Лимиты писем через хук Auth и одноразовые билеты (docs/cloud.md).
* Локально: SQLCipher, ключи в Связке ключей / DPAPI, секреты не пишутся в журналы (`reports::redact`).

## 2. Один канал и идентичность приложения

* Канал один (ADR-034): Beta-сборки, Debug Menu, Scenario Runner и генераторы тестовых данных удалены вместе с кодом.
* Идентичность приложения (`src-tauri/src/identity.rs`: идентификатор, папки, сервис Связки ключей, энтропия
  DPAPI, схема ссылок) совпадает с прежними версиями и закреплена тестами; запуск с чужим идентификатором
  останавливается до создания файлов.
* `release-check.cjs` в каждом PR проверяет: прежние идентификатор, имя, ссылки и AppId установщика; одна
  конфигурация Tauri; нет признака `beta`, модуля `debug`, команд `debug_*` и `devtools`; в клиенте нет ключей
  сервера Supabase (`tests/test_release_check.py` ловит каждое нарушение на испорченной копии).

## 3. CRM: правила RLS (этап 3)

Функции прав (`security definer`, `stable`, `set search_path = ''`, `revoke all from public, anon`):

```sql
private.is_member(ws uuid) → boolean      -- активный участник
private.has_perm(ws uuid, perm text) → boolean
private.can_edit(ws uuid, owner uuid, author uuid, assignee uuid) → boolean   -- edit или edit_own
```

Для каждой CRM-таблицы `t`:

| Действие | Политика |
|---|---|
| select | `using (private.has_perm(workspace_id, 'records.view'))` |
| insert | `with check (private.has_perm(workspace_id, 'records.create') and created_by = auth.uid())` |
| update | `using (private.can_edit(workspace_id, owner_id, created_by, …))` `with check` то же; триггер запрещает менять `workspace_id`, `id`, `created_*` |
| delete (физический) | политики нет — только мягкое удаление полем `deleted_at` (требует `records.delete`, проверяет триггер) |

Особые таблицы: `collections` (личные видит только автор: `visibility = 'workspace' or owner_id = auth.uid()`),
`audit_log` (select — `audit.view`, insert — только definer-функции), `workspace_members` / `roles` / приглашения
(select — `members.view`, запись — только RPC), `user_profiles` (select — общий Workspace с пользователем или он сам,
update — только свой).

Storage: бакет `attachments` приватный; политика `storage.objects`: путь `attachments/<ws>/…`,
`private.has_perm(ws, 'records.view')` на чтение и `records.create` на запись; ссылки — подписанные на 10 минут.

## 4. Правила для функций

* По умолчанию `security invoker` (RLS действует). `security definer` — только когда функция должна прочитать
  то, что пользователю не видно (членство, приглашения), и всегда с `set search_path = ''`, полностью квалифицированными
  именами, явной проверкой `auth.uid() is not null` и прав, `revoke execute … from public, anon`.
* Каждая definer-функция пишет `audit_log` для действий с участниками, ролями, владением, экспортом, удалением.
* Ни одна функция не принимает `user_id`/`created_by` от клиента для записи — только `auth.uid()`.

## 5. Угрозы и проверки (security-тесты этапа 3, `supabase/tests/test_workspace_security.py`)

| Попытка | Ожидаемый результат |
|---|---|
| Чтение чужого Workspace прямым `GET /rest/v1/companies?workspace_id=eq.<чужой>` | пустой ответ |
| Изменение чужой записи `PATCH` по `id` | 0 строк изменено |
| Вставка строки с чужим `workspace_id` | `42501` |
| Смена `workspace_id` своей записи на чужой | ошибка триггера |
| Viewer создаёт/меняет запись | `42501` / 0 строк |
| Employee меняет чужую запись (`edit_own`) | 0 строк |
| Повышение себя: `PATCH workspace_members` / `set_member_role(self, admin)` | нет политики / исключение |
| Admin назначает owner или меняет owner | исключение |
| `roles.manage` создаёт роль с `workspace.delete` | исключение (нет у самого) |
| Удаление последнего owner / выход последнего owner | исключение (отложенный триггер) |
| Удалённый участник читает данные и получает Realtime | пусто / канал не авторизован |
| Приглашение: чужая почта, истёкшее, отозванное, повторное принятие, подбор токена | исключение; токен 256 бит, хранится хеш |
| `crm_push` с операцией на чужой Workspace или без прав | `rejected` по каждой операции, ничего не применено |
| Ссылка задачи/заметки на запись чужого Workspace | исключение триггера |
| Подписанная ссылка на вложение чужого Workspace | отказ Storage |
| `service_role` / секретный ключ в приложении | сборка отклоняет ключ (`is_public_key`), `release-check` ищет его в коде |

Тесты идут на одноразовом стенде (`supabase/tests/stack`, CI `cloud.yml`) с настоящими PostgREST/GoTrue и
несколькими пользователями. Моки не заменяют эти проверки.
