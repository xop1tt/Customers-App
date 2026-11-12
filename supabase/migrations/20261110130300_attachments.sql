-- Вложения к карточкам. Метаданные (attachments) синхронизируются как остальные записи CRM; содержимое
-- (attachment_blobs, base64) загружается отдельным запросом и скачивается по требованию. Предел — 5 МБ на файл:
-- до перехода на Supabase Storage (бинарные запросы) файлы лежат в базе.

create table if not exists public.attachments (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    entity_type text not null check (entity_type in ('company', 'contact', 'crm_lead', 'deal')),
    entity_id uuid not null,
    name text not null check (char_length(btrim(name)) between 1 and 255),
    mime text check (char_length(mime) <= 100),
    size numeric check (size is null or size between 0 and 5242880)
);
create index if not exists attachments_entity on public.attachments (workspace_id, entity_type, entity_id);

select private.crm_attach('attachments', 'records', array['deleted_at', 'entity_type', 'entity_id', 'name', 'mime', 'size']);

create table if not exists public.attachment_blobs (
    attachment_id uuid primary key references public.attachments (id) on delete cascade,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    data text not null check (char_length(data) <= 7200000)
);
alter table public.attachment_blobs enable row level security;
alter table public.attachment_blobs force row level security;

drop policy if exists attachment_blobs_select on public.attachment_blobs;
create policy attachment_blobs_select on public.attachment_blobs for select to authenticated
    using (private.has_perm(workspace_id, 'records.view'));
-- Загрузить файл может автор вложения (без перезаписи: строка создаётся один раз).
drop policy if exists attachment_blobs_insert on public.attachment_blobs;
create policy attachment_blobs_insert on public.attachment_blobs for insert to authenticated
    with check (private.has_perm(workspace_id, 'records.create')
                and exists (select 1 from public.attachments a where a.id = attachment_id and a.workspace_id = workspace_id
                            and a.created_by = (select auth.uid())));
revoke all on public.attachment_blobs from anon, public, authenticated;
grant select, insert on public.attachment_blobs to authenticated;
