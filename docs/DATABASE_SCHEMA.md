# Схема баз данных

Две базы: локальная SQLite (SQLCipher) на устройстве и PostgreSQL в Supabase (источник истины для общей базы
Workspace). Разделы «Текущая» описывают то, что работает сейчас (проверено по коду 2026-11-09), «Целевая» — план
этапов 3–8 (статус: таблицы этапов 3–7 **реализованы** миграциями `20261110120000`–`20261110120400`;
вложения, пользовательские поля и аналитика — **запланировано**).

## 1. Текущая локальная схема (генератор лидов)

Файл: `<папка данных>/users/<учётная запись>/leads.db` (или путь, выбранный пользователем), шифрование SQLCipher,
ключ в Связке ключей (macOS) / DPAPI (Windows). Схема — `desktop/src-tauri/src/store.rs`, `kv.schema_version = 2`.

| Таблица | Назначение | Ключ |
|---|---|---|
| `leads` | найденные лиды и отметки пользователя (`favorite`, `archived`, `deleted`, `excluded`, `seen`, `note`) | `lead_id` |
| `exclusions` | исключения (домен, телефон, почта, название) | `id`, уникально `(kind, value)` |
| `lead_events` | история действий с лидом | `id` |
| `source_state`, `search_queries`, `seen_objects`, `pipeline_errors` | состояние источников поиска | |
| `sync_dirty` | журнал несинхронизированных полей (пишется в одной транзакции с изменением) | `(entity, key, field)` |
| `sync_log` | журнал синхронизаций | |
| `kv` | настройки и служебные значения (`schema_version`, `sync.enabled`, курсоры, синхронизируемые ключи `SYNCED_KEYS`) | `key` |

Каналы: у Beta своя папка данных и свои ключи шифрования, поэтому её базы физически отдельные (DEBUG_BUILD.md).

## 2. Текущая схема PostgreSQL

Миграции: `20261106120000_sync_schema.sql`, `20261106120100_email_limits.sql` (**не меняются**).

| Объект | Назначение |
|---|---|
| `public.leads (user_id, lead_id)` | лиды пользователя, `field_ts`, `server_seq`, надгробие `deleted` |
| `public.exclusions (user_id, kind, value)` | исключения, `changed_at` |
| `public.user_settings (user_id, key)` | синхронизируемые настройки |
| `public.sync_seq` | общая последовательность `server_seq` |
| `private.sync_stamp()` | триггер: неизменяемый `user_id`, `server_seq` под блокировкой пользователя, время не в будущем |
| `public.sync_push(device, changes)` | пакетная выгрузка, слияние по полям, до 500 изменений, security invoker |
| `public.sync_stats()` | сводка для проверки переноса |
| `private.email_*` | лимиты писем (deny-all RLS, доступ только функциями) |

RLS: `select/insert/update/delete` только `auth.uid() = user_id`; `anon` прав не имеет.

## 3. Целевая схема PostgreSQL (новые миграции)

Порядок файлов (этап 3 и далее; имена с датой создания):

1. `…_workspaces.sql` — workspaces, user_profiles, roles, permissions, role_permissions, workspace_members, workspace_invitations, функции прав.
2. `…_crm_core.sql` — companies, contacts, crm_leads, custom_fields, custom_field_values, audit_log, sync_ops, sync_conflicts, `crm_push`.
3. `…_sales.sql` — pipelines, pipeline_stages, deals, deal_contacts, deal_stage_history.
4. `…_work.sql` — tasks, activities, notes, comments, attachments (+ политика Storage).
5. `…_collections.sql` — collections, collection_user_prefs.
6. `…_realtime.sql` — приватные каналы `ws:<id>`, триггеры «звонка».

Все миграции: `create … if not exists`, `create or replace function`, `drop policy if exists` + `create policy` —
повторное применение безопасно; ни одна не меняет и не удаляет существующие объекты.

### 3.1 Workspace и права

```sql
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  personal boolean not null default false,          -- личный Workspace, созданный при переходе (MIGRATION_PLAN.md)
  created_by uuid not null default auth.uid() references auth.users(id),
  default_currency char(3) not null default 'RUB',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index workspaces_one_personal on public.workspaces(created_by) where personal and deleted_at is null;

create table public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 120),
  avatar_path text check (avatar_path ~ '^avatars/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png)$'),
  updated_at timestamptz not null default now()
);

create table public.permissions (key text primary key check (key ~ '^[a-z]+\.[a-z_]+$'), description text not null);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,  -- null: системная роль-шаблон
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  name text not null,
  rank int not null check (rank between 0 and 100),   -- owner 100, admin 80, manager 60, employee 40, viewer 20
  is_system boolean not null default false,
  unique nulls not distinct (workspace_id, key)
);

create table public.role_permissions (
  role_id uuid references public.roles(id) on delete cascade,
  permission_key text references public.permissions(key),
  primary key (role_id, permission_key)
);

create table public.workspace_members (
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role_id uuid not null references public.roles(id),
  status text not null default 'active' check (status in ('active', 'removed', 'left')),
  invited_by uuid references auth.users(id),
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (workspace_id, user_id)
);
create index workspace_members_user on public.workspace_members(user_id) where status = 'active';

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email_norm text not null check (email_norm = lower(trim(email_norm))),
  role_id uuid not null references public.roles(id),
  token_hash text not null unique,                    -- sha256 токена; сам токен только в письме/ссылке
  invited_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  sent_count int not null default 1, last_sent_at timestamptz not null default now(),
  accepted_at timestamptz, accepted_by uuid references auth.users(id),
  revoked_at timestamptz
);
create unique index invitations_one_open on public.workspace_invitations(workspace_id, email_norm)
  where accepted_at is null and revoked_at is null;
```

### 3.2 Общие столбцы CRM-таблиц

```sql
  id uuid primary key,                                   -- создаёт устройство
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid not null, created_at timestamptz not null default now(),
  updated_by uuid,          updated_at timestamptz not null default now(),
  owner_id uuid,                                         -- ответственный (участник Workspace)
  archived_at timestamptz, deleted_at timestamptz,
  version bigint not null default 1,
  field_ts jsonb not null default '{}' check (jsonb_typeof(field_ts) = 'object'),
  server_seq bigint not null default nextval('public.sync_seq')
-- индексы: (workspace_id, server_seq) для курсоров; (workspace_id, updated_at desc) where deleted_at is null
```

Триггер `private.crm_stamp()` на каждой CRM-таблице: запрет смены `id`, `workspace_id`, `created_by`, `created_at`;
`created_by/updated_by = auth.uid()`; `server_seq` под `pg_advisory_xact_lock('crm:'||workspace_id)`;
`version = old.version + 1`; время в `field_ts` и `deleted_at/archived_at` не позже `now()`; `owner_id` — активный участник.

### 3.3 Сущности (сверх общих столбцов)

| Таблица | Столбцы | Ограничения и индексы |
|---|---|---|
| `companies` | `name text not null`, `legal_name`, `inn text`, `domain text`, `website`, `phones text[]`, `emails text[]`, `address`, `industry`, `size_range`, `source text`, `source_lead_id text`, `source_payload jsonb`, `dedupe_keys text[]` | unique `(workspace_id, source_lead_id)` where not null; GIN `(dedupe_keys)`; trgm `(workspace_id, lower(name))` |
| `contacts` | `company_id uuid` → companies, `first_name`, `last_name`, `full_name text generated`, `position`, `phones text[]`, `emails text[]`, `messengers jsonb`, `source`, `source_lead_id`, `source_payload`, `dedupe_keys` | FK + триггер «тот же workspace»; GIN `(dedupe_keys)` |
| `crm_leads` | `title`, `person_name`, `company_name`, `phones`, `emails`, `status` (`new`…`converted`), `source`, `source_lead_id`, `converted_company_id`, `converted_contact_id` | unique `(workspace_id, source_lead_id)` |
| `pipelines` | `name`, `position numeric`, `is_default bool` | один default на workspace (partial unique) |
| `pipeline_stages` | `pipeline_id`, `name`, `position numeric`, `color text check (~'^#[0-9a-f]{6}$')`, `probability smallint 0..100`, `kind` (`open`,`won`,`lost`) | unique `(pipeline_id, position)` deferrable |
| `deals` | `pipeline_id`, `stage_id`, `title`, `amount numeric(18,2) check (amount >= 0)`, `currency char(3)`, `expected_close_date date`, `company_id`, `status`, `lost_reason`, `closed_at` | `(workspace_id, pipeline_id, stage_id) where deleted_at is null`; этап принадлежит воронке (триггер) |
| `deal_contacts` | `deal_id`, `contact_id`, `role text` + общие столбцы | unique `(deal_id, contact_id)`; удаление — надгробие |
| `deal_stage_history` | `deal_id`, `from_stage_id`, `to_stage_id`, `changed_by`, `changed_at` | только insert (триггер на deals) |
| `tasks` | `title`, `description`, `assignee_id`, `due_at`, `remind_at`, `priority`, `status`, `completed_at`, `entity_type`, `entity_id` | `(workspace_id, assignee_id, status, due_at)` |
| `activities` | `type`, `occurred_at`, `author_id`, `summary`, `payload jsonb`, `entity_type`, `entity_id` | `(workspace_id, entity_type, entity_id, occurred_at desc)` |
| `notes` / `comments` | `body text check (≤ 20000)`, `entity_type`, `entity_id`, (`comments.parent_id`) | |
| `attachments` | `storage_path`, `file_name`, `mime`, `size_bytes check (≤ 10 485 760)`, `sha256`, `entity_type`, `entity_id` | путь `attachments/<workspace_id>/<uuid>` |
| `custom_fields` | `entity_type`, `key`, `label`, `type`, `options jsonb`, `validation jsonb`, `position`, `required` | unique `(workspace_id, entity_type, key)` |
| `custom_field_values` | `field_id`, `entity_type`, `entity_id`, `value_text`, `value_number numeric`, `value_date`, `value_ts`, `value_bool`, `value_json jsonb` | unique `(field_id, entity_id)`; частичные индексы по каждому типу |
| `collections` | `owner_id`, `visibility`, `entity_type`, `name`, `icon`, `emoji`, `config jsonb`, `position` | |
| `collection_user_prefs` | `collection_id`, `user_id`, `position`, `hidden` | PK `(collection_id, user_id)` |
| `audit_log` | `id bigserial`, `workspace_id`, `actor_id`, `action`, `entity_type`, `entity_id`, `at`, `details jsonb` | только insert через definer-функции; select — `audit.view` |
| `sync_ops` | `op_id uuid pk`, `workspace_id`, `user_id`, `device`, `applied_at`, `result jsonb` | очистка через 30 дней |
| `sync_conflicts` | `id`, `workspace_id`, `entity_type`, `entity_id`, `field`, `kept jsonb`, `lost jsonb`, `lost_by`, `at`, `resolved_at` | |

## 4. Целевая локальная схема CRM

Отдельный файл на Workspace: `<папка учётной записи>/workspaces/<workspace_id>.db` (SQLCipher, тот же ключ
учётной записи). Таблицы повторяют серверные (те же имена и столбцы; массивы и jsonb — JSON-текстом) плюс:

| Таблица | Назначение |
|---|---|
| `sync_outbox(op_id text pk, entity, entity_id, op_json, created_at, attempts, next_attempt_at, state, last_error)` | очередь операций, пишется в одной транзакции с изменением |
| `sync_cursor(table_name pk, server_seq)` | курсоры загрузки |
| `local_meta(key pk, value)` | `schema_version`, `workspace_id`, `channel` (метка канала), `member_role`, время последней синхронизации |

База генератора лидов (`leads.db`) **не меняет схему**: отметка о преобразовании хранится в JSON-поле лида
`data.crm = {workspace_id, company_id, contact_id, converted_at}` — это поле уже синхронизируется между устройствами
(CRM_ARCHITECTURE.md §4).

## 5. Отличия реализации (этапы 3–7)

* `workspaces.created_by` и `sync_conflicts.lost_by` допускают `null` (удалённый пользователь, неизвестный автор поля).
* У всех CRM-таблиц, кроме общих столбцов §3.2, есть `field_ver jsonb` — версия записи, в которой менялось поле
  (для определения конфликтов, см. SYNC_ARCHITECTURE.md §5).
* `workspace_invitations.token_hash` клиентам не выдаётся (нет права `select` на столбец).
* `attachments` и `custom_fields` / `custom_field_values` не созданы: на стенде CI нет Storage, а поля — этап 8.
* Локальная база Workspace: `workspaces/<id>.db` (SQLCipher, ключ учётной записи) с теми же таблицами и столбцами,
  плюс `sync_outbox`, `sync_cursors`, `members`, `local_meta`, `collection_user_prefs`; список Workspace и активный —
  `workspaces/catalog.json`.
