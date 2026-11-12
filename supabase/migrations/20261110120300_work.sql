-- Customers 2.0, этап 6: задачи, активности, заметки, комментарии.
-- Документы: docs/CRM_ARCHITECTURE.md §6. Только добавление объектов.
-- Вложения (Storage) — следующей миграцией: на стенде CI нет Storage, проверить их там нельзя.

create table if not exists public.tasks (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    title text not null check (char_length(btrim(title)) between 1 and 300),
    description text not null default '' check (char_length(description) <= 20000),
    assignee_id uuid,
    due_at timestamptz,
    remind_at timestamptz,
    priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
    status text not null default 'todo' check (status in ('todo', 'in_progress', 'done', 'cancelled')),
    completed_at timestamptz,
    entity_type text check (entity_type in ('company', 'contact', 'crm_lead', 'deal')),
    entity_id uuid,
    check ((entity_type is null) = (entity_id is null))
);
create index if not exists tasks_assignee on public.tasks (workspace_id, assignee_id, status, due_at) where deleted_at is null;

create table if not exists public.activities (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    type text not null check (type in ('call', 'email', 'meeting', 'follow_up', 'reminder', 'agreement', 'payment',
                                       'custom', 'system')),
    occurred_at timestamptz not null default now(),
    summary text not null default '' check (char_length(summary) <= 2000),
    payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 16384),
    entity_type text not null check (entity_type in ('company', 'contact', 'crm_lead', 'deal')),
    entity_id uuid not null
);
create index if not exists activities_feed on public.activities (workspace_id, entity_type, entity_id, occurred_at desc);

create table if not exists public.notes (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    body text not null check (char_length(body) between 1 and 20000),
    entity_type text not null check (entity_type in ('company', 'contact', 'crm_lead', 'deal')),
    entity_id uuid not null
);
create index if not exists notes_entity on public.notes (workspace_id, entity_type, entity_id);

create table if not exists public.comments (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    body text not null check (char_length(body) between 1 and 20000),
    entity_type text not null check (entity_type in ('company', 'contact', 'crm_lead', 'deal')),
    entity_id uuid not null,
    parent_id uuid references public.comments (id)
);
create index if not exists comments_entity on public.comments (workspace_id, entity_type, entity_id);

select private.crm_attach('tasks', 'records', array['archived_at', 'deleted_at', 'title', 'description', 'assignee_id',
    'due_at', 'remind_at', 'priority', 'status', 'entity_type', 'entity_id']);
select private.crm_attach('activities', 'records', array['deleted_at', 'type', 'occurred_at', 'summary', 'payload',
    'entity_type', 'entity_id']);
select private.crm_attach('notes', 'records', array['deleted_at', 'body', 'entity_type', 'entity_id']);
select private.crm_attach('comments', 'records', array['deleted_at', 'body', 'entity_type', 'entity_id', 'parent_id']);

-- Дата выполнения задачи ставится сервером.
create or replace function private.task_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.status = 'done' then
        new.completed_at := coalesce(case when tg_op = 'UPDATE' and old.status = 'done' then old.completed_at end, now());
    else
        new.completed_at := null;
    end if;
    return new;
end;
$$;
revoke all on function private.task_rules() from public, anon, authenticated;
drop trigger if exists tasks_rules on public.tasks;
create trigger tasks_rules before insert or update on public.tasks
    for each row execute function private.task_rules();

-- Время активности не может быть в будущем дальше, чем на сутки (запланированные звонки — задачи).
create or replace function private.activity_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.occurred_at := least(new.occurred_at, now() + interval '1 day');
    return new;
end;
$$;
revoke all on function private.activity_rules() from public, anon, authenticated;
drop trigger if exists activities_rules on public.activities;
create trigger activities_rules before insert or update on public.activities
    for each row execute function private.activity_rules();
