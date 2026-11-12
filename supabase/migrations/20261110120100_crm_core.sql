-- Customers 2.0, этапы 3–4: общая основа CRM (журнал действий, очередь операций, конфликты, выгрузка
-- crm_push) и клиенты: компании, контакты, лиды CRM. Документы: docs/CRM_ARCHITECTURE.md,
-- docs/DATABASE_SCHEMA.md §3.2–3.3, docs/SYNC_ARCHITECTURE.md §2.
--
-- Только добавление объектов, повторное применение безопасно. Таблица public.leads генератора не меняется.
--
-- Устройство:
-- * У каждой CRM-таблицы одинаковые служебные столбцы (id с устройства, workspace_id, автор, время, версия,
--   field_ts — время изменения каждого поля, field_ver — версия строки, в которой поле менялось последний раз,
--   server_seq — курсор загрузки) и один триггер private.crm_stamp() — его не обойти ни через crm_push, ни прямым
--   запросом PostgREST.
-- * Права — политики RLS (private.has_perm). crm_push работает как security invoker, поэтому любая операция,
--   которую не пропускает RLS или триггер, получает статус rejected, а не применяется.
-- * Реестр private.crm_entities перечисляет таблицы и поля, которые принимает crm_push; следующие миграции
--   (сделки, задачи, коллекции) добавляют в него свои таблицы.

-- ------------------------------------------------------------------ реестр сущностей

create table if not exists private.crm_entities (
    entity text primary key,
    kind text not null check (kind in ('records', 'settings', 'collections')),
    fields text[] not null
);
revoke all on private.crm_entities from public, anon;
grant select on private.crm_entities to authenticated;
alter table private.crm_entities enable row level security;
drop policy if exists crm_entities_read on private.crm_entities;
create policy crm_entities_read on private.crm_entities for select to authenticated using (true);

-- Тип сущности в полиморфных ссылках (entity_type) → таблица.
create or replace function private.entity_table(p_type text)
returns text
language sql
immutable
set search_path = ''
as $$
    select case p_type when 'company' then 'companies' when 'contact' then 'contacts'
                       when 'crm_lead' then 'crm_leads' when 'deal' then 'deals' end;
$$;

-- ------------------------------------------------------------------ журнал действий, операции, конфликты

create table if not exists public.audit_log (
    id bigserial primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    actor_id uuid,
    action text not null check (char_length(action) between 1 and 60),
    entity_type text,
    entity_id uuid,
    at timestamptz not null default now(),
    details jsonb not null default '{}'::jsonb
);
create index if not exists audit_log_ws_at on public.audit_log (workspace_id, at desc);

create table if not exists public.sync_ops (
    op_id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    user_id uuid not null default auth.uid(),
    device text check (char_length(device) <= 100),
    applied_at timestamptz not null default now(),
    result jsonb not null
);
create index if not exists sync_ops_applied on public.sync_ops (applied_at);

create table if not exists public.sync_conflicts (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    entity_type text not null,
    entity_id uuid not null,
    field text not null,
    kept jsonb,
    lost jsonb,
    lost_by uuid default auth.uid(),          -- null: автор затёртого значения неизвестен
    kept_by uuid,
    at timestamptz not null default now(),
    resolved_at timestamptz,
    server_seq bigint not null default nextval('public.sync_seq')
);
create index if not exists sync_conflicts_ws_seq on public.sync_conflicts (workspace_id, server_seq);

alter table public.audit_log enable row level security;
alter table public.sync_ops enable row level security;
alter table public.sync_conflicts enable row level security;
alter table public.audit_log force row level security;
alter table public.sync_ops force row level security;
alter table public.sync_conflicts force row level security;

drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
    using (private.has_perm(workspace_id, 'audit.view'));

drop policy if exists sync_ops_select on public.sync_ops;
create policy sync_ops_select on public.sync_ops for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists sync_ops_insert on public.sync_ops;
create policy sync_ops_insert on public.sync_ops for insert to authenticated
    with check (user_id = (select auth.uid()) and private.is_member(workspace_id));

drop policy if exists sync_conflicts_select on public.sync_conflicts;
create policy sync_conflicts_select on public.sync_conflicts for select to authenticated
    using (private.has_perm(workspace_id, 'records.view'));
drop policy if exists sync_conflicts_insert on public.sync_conflicts;
create policy sync_conflicts_insert on public.sync_conflicts for insert to authenticated
    with check (private.is_member(workspace_id) and (lost_by = (select auth.uid()) or kept_by = (select auth.uid())));
drop policy if exists sync_conflicts_update on public.sync_conflicts;
create policy sync_conflicts_update on public.sync_conflicts for update to authenticated
    using (private.has_perm(workspace_id, 'records.view') and (lost_by = (select auth.uid()) or kept_by = (select auth.uid())))
    with check (private.is_member(workspace_id));

revoke all on public.audit_log, public.sync_ops, public.sync_conflicts from anon, public, authenticated;
grant select on public.audit_log to authenticated;
grant select, insert on public.sync_ops to authenticated;
grant select, insert on public.sync_conflicts to authenticated;
grant update (resolved_at) on public.sync_conflicts to authenticated;

-- ------------------------------------------------------------------ права на запись

create or replace function private.can_edit(p_workspace uuid, p_created_by uuid, p_owner uuid, p_assignee uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select private.has_perm(p_workspace, 'records.edit')
        or (private.has_perm(p_workspace, 'records.edit_own')
            and (select auth.uid()) in (p_created_by, p_owner, p_assignee));
$$;
revoke all on function private.can_edit(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function private.can_edit(uuid, uuid, uuid, uuid) to authenticated;

-- Ссылка на запись того же Workspace (иначе через ссылку можно было бы узнать о чужих данных).
create or replace function private.check_ref(p_table text, p_id uuid, p_workspace uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    ws uuid;
begin
    if p_table is null then
        raise exception 'unknown entity type' using errcode = '22023';
    end if;
    execute format('select workspace_id from public.%I where id = $1', p_table) into ws using p_id;
    if ws is distinct from p_workspace then
        raise exception '% % not found in this workspace', p_table, p_id using errcode = '23503';
    end if;
end;
$$;
revoke all on function private.check_ref(text, uuid, uuid) from public, anon, authenticated;

create or replace function private.check_member(p_workspace uuid, p_user uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if p_user is not null and not exists (select 1 from public.workspace_members
                                          where workspace_id = p_workspace and user_id = p_user and status = 'active') then
        raise exception 'user % is not an active member of this workspace', p_user using errcode = '23503';
    end if;
end;
$$;
revoke all on function private.check_member(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------ общий триггер CRM-таблиц

create or replace function private.crm_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    uid uuid := auth.uid();
    n jsonb := to_jsonb(new);
    o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
    ref record;
    kind text;
    deleting boolean;
begin
    select e.kind into kind from private.crm_entities e where e.entity = tg_table_name;
    if tg_op = 'UPDATE' then
        if new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
           or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
            raise exception 'id, workspace_id, created_by and created_at cannot be changed' using errcode = '42501';
        end if;
        new.version := old.version + 1;
    else
        new.created_by := coalesce(uid, new.created_by);
        new.created_at := now();
        new.version := 1;
    end if;
    if new.created_by is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    new.updated_by := coalesce(uid, new.updated_by);
    new.updated_at := now();
    perform pg_advisory_xact_lock(hashtextextended('crm:' || new.workspace_id::text, 0));
    new.server_seq := nextval('public.sync_seq');
    new.field_ts := coalesce((
        select jsonb_object_agg(k, to_jsonb(least((v #>> '{}')::timestamptz, now())))
        from jsonb_each(coalesce(new.field_ts, '{}'::jsonb)) as e(k, v)
        where jsonb_typeof(v) = 'string'
    ), '{}'::jsonb);
    if new.deleted_at is not null then
        new.deleted_at := least(new.deleted_at, now());  -- least() без проверки превратил бы null в now()
    end if;

    -- Мягкое удаление и восстановление — отдельное право (свои коллекции, заметки и комментарии — автору).
    deleting := (n ->> 'deleted_at') is distinct from (o ->> 'deleted_at') and (tg_op = 'UPDATE' or new.deleted_at is not null);
    if deleting and uid is not null then
        if kind = 'settings' then
            if not private.has_perm(new.workspace_id, 'pipelines.manage') then
                raise exception 'permission denied: pipelines.manage' using errcode = '42501';
            end if;
        elsif not private.has_perm(new.workspace_id, 'records.delete')
              and not (tg_table_name in ('collections', 'notes', 'comments', 'activities') and new.created_by = uid) then
            raise exception 'permission denied: records.delete' using errcode = '42501';
        end if;
    end if;

    -- Ответственный и исполнитель — активные участники этого Workspace.
    if (n ->> 'owner_id') is not null and (n ->> 'owner_id') is distinct from (o ->> 'owner_id') then
        perform private.check_member(new.workspace_id, (n ->> 'owner_id')::uuid);
    end if;
    if (n ->> 'assignee_id') is not null and (n ->> 'assignee_id') is distinct from (o ->> 'assignee_id') then
        perform private.check_member(new.workspace_id, (n ->> 'assignee_id')::uuid);
    end if;

    -- Ссылки на другие записи — только в пределах Workspace.
    for ref in select * from (values ('company_id', 'companies'), ('contact_id', 'contacts'),
                                     ('converted_company_id', 'companies'), ('converted_contact_id', 'contacts'),
                                     ('pipeline_id', 'pipelines'), ('stage_id', 'pipeline_stages'),
                                     ('deal_id', 'deals'), ('parent_id', 'comments')) as r(col, tbl) loop
        if (n ->> ref.col) is not null and (n ->> ref.col) is distinct from (o ->> ref.col) then
            perform private.check_ref(ref.tbl, (n ->> ref.col)::uuid, new.workspace_id);
        end if;
    end loop;
    if (n ->> 'entity_id') is not null and ((n ->> 'entity_id') is distinct from (o ->> 'entity_id')
                              or (n ->> 'entity_type') is distinct from (o ->> 'entity_type')) then
        perform private.check_ref(private.entity_table(n ->> 'entity_type'), (n ->> 'entity_id')::uuid, new.workspace_id);
    end if;
    return new;
end;
$$;
revoke all on function private.crm_stamp() from public, anon, authenticated;

-- Журнал важных изменений: удаление, восстановление, смена ответственного.
create or replace function private.crm_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    n jsonb := to_jsonb(new);
    o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
begin
    if tg_op = 'UPDATE' and (n ->> 'deleted_at') is distinct from (o ->> 'deleted_at') then
        insert into public.audit_log (workspace_id, actor_id, action, entity_type, entity_id)
        values (new.workspace_id, auth.uid(), case when new.deleted_at is null then 'restore' else 'delete' end,
                tg_table_name, new.id);
    end if;
    if tg_op = 'UPDATE' and (n ->> 'owner_id') is distinct from (o ->> 'owner_id') then
        insert into public.audit_log (workspace_id, actor_id, action, entity_type, entity_id, details)
        values (new.workspace_id, auth.uid(), 'owner_change', tg_table_name, new.id,
                jsonb_build_object('from', o -> 'owner_id', 'to', n -> 'owner_id'));
    end if;
    return null;
end;
$$;
revoke all on function private.crm_audit() from public, anon, authenticated;

-- Участники: каждое изменение роли и состава — в журнал.
create or replace function private.members_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.audit_log (workspace_id, actor_id, action, entity_type, entity_id, details)
    values (new.workspace_id, auth.uid(),
            case when tg_op = 'INSERT' then 'member_join'
                 when new.status <> old.status then 'member_' || new.status
                 else 'member_role' end,
            'member', new.user_id,
            jsonb_build_object('role', (select key from public.roles where id = new.role_id)));
    return null;
end;
$$;
revoke all on function private.members_audit() from public, anon, authenticated;
drop trigger if exists workspace_members_audit on public.workspace_members;
create trigger workspace_members_audit after insert or update on public.workspace_members
    for each row execute function private.members_audit();

-- Подключение CRM-таблицы: триггеры, RLS, политики по виду сущности, права, индексы курсора.
create or replace function private.crm_attach(p_table text, p_kind text, p_fields text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
    has_owner boolean;
    has_assignee boolean;
    edit text;
begin
    insert into private.crm_entities (entity, kind, fields) values (p_table, p_kind, p_fields)
    on conflict (entity) do update set kind = excluded.kind, fields = excluded.fields;
    select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table
                   and column_name = 'owner_id') into has_owner;
    select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table
                   and column_name = 'assignee_id') into has_assignee;

    execute format('drop trigger if exists %I on public.%I', p_table || '_crm_stamp', p_table);
    execute format('create trigger %I before insert or update on public.%I for each row execute function private.crm_stamp()',
                   p_table || '_crm_stamp', p_table);
    execute format('drop trigger if exists %I on public.%I', p_table || '_crm_audit', p_table);
    execute format('create trigger %I after update on public.%I for each row execute function private.crm_audit()',
                   p_table || '_crm_audit', p_table);
    execute format('create index if not exists %I on public.%I (workspace_id, server_seq)', p_table || '_ws_seq', p_table);
    execute format('create index if not exists %I on public.%I (workspace_id, updated_at desc) where deleted_at is null',
                   p_table || '_ws_updated', p_table);

    execute format('alter table public.%I enable row level security', p_table);
    execute format('alter table public.%I force row level security', p_table);
    execute format('drop policy if exists %I on public.%I', p_table || '_select', p_table);
    execute format('drop policy if exists %I on public.%I', p_table || '_insert', p_table);
    execute format('drop policy if exists %I on public.%I', p_table || '_update', p_table);

    if p_kind = 'records' then
        edit := format('private.can_edit(workspace_id, created_by, %s, %s)',
                       case when has_owner then 'owner_id' else 'null' end,
                       case when has_assignee then 'assignee_id' else 'null' end);
        execute format('create policy %I on public.%I for select to authenticated using (private.has_perm(workspace_id, %L))',
                       p_table || '_select', p_table, 'records.view');
        execute format('create policy %I on public.%I for insert to authenticated with check (private.has_perm(workspace_id, %L))',
                       p_table || '_insert', p_table, 'records.create');
        execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)',
                       p_table || '_update', p_table, edit, edit);
    elsif p_kind = 'settings' then
        execute format('create policy %I on public.%I for select to authenticated using (private.has_perm(workspace_id, %L))',
                       p_table || '_select', p_table, 'records.view');
        execute format('create policy %I on public.%I for insert to authenticated with check (private.has_perm(workspace_id, %L))',
                       p_table || '_insert', p_table, 'pipelines.manage');
        execute format('create policy %I on public.%I for update to authenticated using (private.has_perm(workspace_id, %L)) with check (private.has_perm(workspace_id, %L))',
                       p_table || '_update', p_table, 'pipelines.manage', 'pipelines.manage');
    else  -- collections: личные видит и меняет автор, общие видят все, меняет автор или collections.manage
        execute format($p$create policy %I on public.%I for select to authenticated
            using (private.has_perm(workspace_id, 'records.view') and (visibility = 'workspace' or created_by = (select auth.uid())))$p$,
            p_table || '_select', p_table);
        execute format($p$create policy %I on public.%I for insert to authenticated
            with check (private.has_perm(workspace_id, 'records.view')
                        and (visibility = 'private' or private.has_perm(workspace_id, 'collections.manage')))$p$,
            p_table || '_insert', p_table);
        execute format($p$create policy %I on public.%I for update to authenticated
            using (private.has_perm(workspace_id, 'records.view')
                   and (created_by = (select auth.uid()) or (visibility = 'workspace' and private.has_perm(workspace_id, 'collections.manage'))))
            with check ((visibility = 'private' and created_by = (select auth.uid())) or private.has_perm(workspace_id, 'collections.manage'))$p$,
            p_table || '_update', p_table);
    end if;

    execute format('revoke all on public.%I from anon, public, authenticated', p_table);
    execute format('grant select, insert, update on public.%I to authenticated', p_table);
end;
$$;
revoke all on function private.crm_attach(text, text, text[]) from public, anon, authenticated;

-- ------------------------------------------------------------------ клиенты: компании, контакты, лиды CRM

create table if not exists public.companies (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    owner_id uuid,
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    name text not null check (char_length(btrim(name)) between 1 and 300),
    legal_name text check (char_length(legal_name) <= 300),
    inn text check (inn ~ '^[0-9A-Za-z-]{1,20}$'),
    domain text check (char_length(domain) <= 253),
    website text check (char_length(website) <= 500),
    phones text[] not null default '{}' check (cardinality(phones) <= 20),
    emails text[] not null default '{}' check (cardinality(emails) <= 20),
    address text check (char_length(address) <= 500),
    industry text check (char_length(industry) <= 200),
    size_range text check (char_length(size_range) <= 40),
    source text check (char_length(source) <= 100),
    source_lead_id text check (char_length(source_lead_id) <= 300),
    source_payload jsonb check (source_payload is null or pg_column_size(source_payload) <= 65536),
    dedupe_keys text[] not null default '{}' check (cardinality(dedupe_keys) <= 50)
);
create unique index if not exists companies_source_lead on public.companies (workspace_id, source_lead_id)
    where source_lead_id is not null;
create index if not exists companies_dedupe on public.companies using gin (dedupe_keys);

create table if not exists public.contacts (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    owner_id uuid,
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    company_id uuid references public.companies (id),
    first_name text not null default '' check (char_length(first_name) <= 120),
    last_name text not null default '' check (char_length(last_name) <= 120),
    full_name text generated always as (btrim(first_name || ' ' || last_name)) stored,
    position text check (char_length(position) <= 200),
    phones text[] not null default '{}' check (cardinality(phones) <= 20),
    emails text[] not null default '{}' check (cardinality(emails) <= 20),
    messengers jsonb not null default '{}'::jsonb check (jsonb_typeof(messengers) = 'object'),
    source text check (char_length(source) <= 100),
    source_lead_id text check (char_length(source_lead_id) <= 300),
    source_payload jsonb check (source_payload is null or pg_column_size(source_payload) <= 65536),
    dedupe_keys text[] not null default '{}' check (cardinality(dedupe_keys) <= 50),
    check (char_length(btrim(first_name || last_name)) > 0)
);
create unique index if not exists contacts_source_lead on public.contacts (workspace_id, source_lead_id)
    where source_lead_id is not null;
create index if not exists contacts_dedupe on public.contacts using gin (dedupe_keys);
create index if not exists contacts_company on public.contacts (company_id) where deleted_at is null;

create table if not exists public.crm_leads (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    owner_id uuid,
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    title text not null check (char_length(btrim(title)) between 1 and 500),
    person_name text check (char_length(person_name) <= 240),
    company_name text check (char_length(company_name) <= 300),
    phones text[] not null default '{}' check (cardinality(phones) <= 20),
    emails text[] not null default '{}' check (cardinality(emails) <= 20),
    status text not null default 'new' check (status in ('new', 'in_progress', 'qualified', 'disqualified', 'converted')),
    source text check (char_length(source) <= 100),
    source_lead_id text check (char_length(source_lead_id) <= 300),
    converted_company_id uuid references public.companies (id),
    converted_contact_id uuid references public.contacts (id)
);
create unique index if not exists crm_leads_source_lead on public.crm_leads (workspace_id, source_lead_id)
    where source_lead_id is not null;

select private.crm_attach('companies', 'records', array['owner_id', 'archived_at', 'deleted_at', 'name', 'legal_name',
    'inn', 'domain', 'website', 'phones', 'emails', 'address', 'industry', 'size_range', 'source', 'source_lead_id',
    'source_payload', 'dedupe_keys']);
select private.crm_attach('contacts', 'records', array['owner_id', 'archived_at', 'deleted_at', 'company_id',
    'first_name', 'last_name', 'position', 'phones', 'emails', 'messengers', 'source', 'source_lead_id',
    'source_payload', 'dedupe_keys']);
select private.crm_attach('crm_leads', 'records', array['owner_id', 'archived_at', 'deleted_at', 'title',
    'person_name', 'company_name', 'phones', 'emails', 'status', 'source', 'source_lead_id',
    'converted_company_id', 'converted_contact_id']);

-- ------------------------------------------------------------------ выгрузка операций: crm_push

-- Автор текущего значения поля известен, если последнее изменение строки затронуло это поле.
create or replace function private.field_author(p_row jsonb, p_field text)
returns uuid
language sql
immutable
set search_path = ''
as $$
    select case when (p_row -> 'field_ver' ->> p_field)::bigint = (p_row ->> 'version')::bigint
                then (p_row ->> 'updated_by')::uuid end;
$$;
revoke all on function private.field_author(jsonb, text) from public, anon;
grant execute on function private.field_author(jsonb, text) to authenticated;

-- Одна операция: {op_id, entity, id, kind: upsert|delete|restore, fields, ts: {поле: время}, base_version}.
create or replace function private.crm_apply(p_workspace uuid, p_op jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    uid uuid := auth.uid();
    server_now timestamptz := now();
    entity text := p_op ->> 'entity';
    op_kind text := coalesce(p_op ->> 'kind', 'upsert');
    rid uuid := (p_op ->> 'id')::uuid;
    base bigint := coalesce((p_op ->> 'base_version')::bigint, 0);
    allowed text[];
    fields jsonb := '{}'::jsonb;
    norm jsonb;
    cur jsonb;
    f text;
    ts timestamptz;
    cur_ts timestamptz;
    applied jsonb := '{}'::jsonb;
    applied_ts jsonb := '{}'::jsonb;
    conflicts int := 0;
    cols text;
    sets text;
    n int;
    ver bigint;
begin
    select e.fields into allowed from private.crm_entities e where e.entity = p_op ->> 'entity';
    if allowed is null then
        return jsonb_build_object('status', 'rejected', 'error', 'unknown entity');
    end if;
    if rid is null then
        return jsonb_build_object('status', 'rejected', 'error', 'id is required');
    end if;
    if op_kind = 'delete' then
        fields := jsonb_build_object('deleted_at', coalesce(p_op -> 'ts' ->> 'deleted_at', server_now::text));
        p_op := jsonb_set(p_op, '{ts}', coalesce(p_op -> 'ts', '{}') || jsonb_build_object('deleted_at', fields ->> 'deleted_at'));
    elsif op_kind = 'restore' then
        fields := jsonb_build_object('deleted_at', null);
    elsif op_kind = 'upsert' then
        select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into fields
        from jsonb_each(coalesce(p_op -> 'fields', '{}'::jsonb)) as e(k, v) where k = any(allowed);
    else
        return jsonb_build_object('status', 'rejected', 'error', 'unknown kind');
    end if;
    -- Значения в виде, в котором их хранит таблица (время, массивы) — для честного сравнения.
    execute format('select to_jsonb(jsonb_populate_record(null::public.%I, $1))', entity) into norm using fields;

    execute format('select to_jsonb(t) from public.%I t where id = $1', entity) into cur using rid;
    if cur is null then
        if op_kind <> 'upsert' then
            return jsonb_build_object('status', 'rejected', 'error', 'not found');
        end if;
        select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(fields) as k;
        select coalesce(jsonb_object_agg(k, to_jsonb(least(coalesce((p_op -> 'ts' ->> k)::timestamptz, server_now), server_now))), '{}'::jsonb),
               coalesce(jsonb_object_agg(k, 1), '{}'::jsonb)
          into applied_ts, applied from jsonb_object_keys(fields) as k;
        execute format('insert into public.%I (id, workspace_id, created_by, field_ts, field_ver%s) '
                       'select $1, $2, $3, $4, $5%s from jsonb_populate_record(null::public.%I, $6) r',
                       entity, case when cols is null then '' else ', ' || cols end,
                       case when cols is null then '' else ', ' || (select string_agg('r.' || quote_ident(k), ', ')
                                                                     from jsonb_object_keys(fields) as k) end, entity)
            using rid, p_workspace, uid, applied_ts, applied, fields;
        return jsonb_build_object('status', 'applied', 'version', 1);
    end if;
    if (cur ->> 'workspace_id')::uuid is distinct from p_workspace then
        return jsonb_build_object('status', 'rejected', 'error', 'not found');
    end if;
    ver := (cur ->> 'version')::bigint;

    -- Правка удалённой записи её не воскрешает: изменение уходит в журнал конфликтов.
    if (cur ->> 'deleted_at') is not null and op_kind = 'upsert' and not (fields ? 'deleted_at') then
        insert into public.sync_conflicts (workspace_id, entity_type, entity_id, field, kept, lost, kept_by)
        values (p_workspace, entity, rid, '*deleted', cur -> 'deleted_at', fields, (cur ->> 'updated_by')::uuid);
        return jsonb_build_object('status', 'conflict', 'version', ver, 'error', 'record is deleted');
    end if;

    applied := '{}'::jsonb;
    for f in select jsonb_object_keys(fields) loop
        ts := least(coalesce((p_op -> 'ts' ->> f)::timestamptz, server_now), server_now);
        cur_ts := coalesce((cur -> 'field_ts' ->> f)::timestamptz, '-infinity'::timestamptz);
        if (norm -> f) is not distinct from (cur -> f) then
            continue;  -- то же значение: ничего не меняется
        end if;
        if ts > cur_ts then
            applied := applied || jsonb_build_object(f, norm -> f);
            applied_ts := applied_ts || jsonb_build_object(f, ts);
            -- Поле менялось после версии, на которой основана операция: проигравшее значение сохраняется.
            if base > 0 and coalesce((cur -> 'field_ver' ->> f)::bigint, 0) > base then
                insert into public.sync_conflicts (workspace_id, entity_type, entity_id, field, kept, lost, lost_by, kept_by)
                values (p_workspace, entity, rid, f, norm -> f, cur -> f, private.field_author(cur, f), uid);
                conflicts := conflicts + 1;
            end if;
        else
            insert into public.sync_conflicts (workspace_id, entity_type, entity_id, field, kept, lost, kept_by)
            values (p_workspace, entity, rid, f, cur -> f, norm -> f, private.field_author(cur, f));
            conflicts := conflicts + 1;
        end if;
    end loop;

    if applied = '{}'::jsonb then
        return jsonb_build_object('status', case when conflicts > 0 then 'conflict' else 'merged' end, 'version', ver);
    end if;
    select string_agg(format('%I = r.%I', k, k), ', ') into sets from jsonb_object_keys(applied) as k;
    execute format('update public.%I t set %s, field_ts = t.field_ts || $2, field_ver = t.field_ver || $3 '
                   'from jsonb_populate_record(null::public.%I, $1) r where t.id = $4', entity, sets, entity)
        using applied, applied_ts,
              (select jsonb_object_agg(k, ver + 1) from jsonb_object_keys(applied) as k), rid;
    get diagnostics n = row_count;
    if n = 0 then
        return jsonb_build_object('status', 'rejected', 'error', 'permission denied', 'code', '42501');
    end if;
    return jsonb_build_object('status', case when conflicts > 0 then 'conflict' else 'applied' end, 'version', ver + 1);
end;
$$;
revoke all on function private.crm_apply(uuid, jsonb) from public, anon;
grant execute on function private.crm_apply(uuid, jsonb) to authenticated;

create or replace function public.crm_push(p_workspace uuid, p_device text, p_ops jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    uid uuid := auth.uid();
    op jsonb;
    res jsonb;
    prev jsonb;
    v_op uuid;
    results jsonb := '[]'::jsonb;
begin
    if uid is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    if not private.is_member(p_workspace) then
        raise exception 'not a member' using errcode = '42501';
    end if;
    if jsonb_typeof(p_ops) is distinct from 'array' then
        raise exception 'p_ops must be an array' using errcode = '22023';
    end if;
    if jsonb_array_length(p_ops) > 500 then
        raise exception 'too many operations in one request (max 500)' using errcode = '54000';
    end if;
    p_device := left(p_device, 100);
    for op in select * from jsonb_array_elements(p_ops) loop
        begin
            v_op := (op ->> 'op_id')::uuid;
        exception when others then
            v_op := null;
        end;
        if v_op is null then
            results := results || jsonb_build_array(jsonb_build_object('op_id', op ->> 'op_id', 'status', 'rejected',
                                                                       'error', 'op_id is required'));
            continue;
        end if;
        select s.result into prev from public.sync_ops s where s.op_id = v_op;
        if prev is not null then
            results := results || jsonb_build_array(prev);  -- повтор после обрыва связи: тот же ответ
            continue;
        end if;
        -- Применение и запись op_id — одно целое: если op_id уже занят (чужой операцией), изменение откатывается.
        begin
            begin
                res := private.crm_apply(p_workspace, op);
            exception when others then
                res := jsonb_build_object('status', 'rejected', 'error', sqlerrm, 'code', sqlstate);
            end;
            res := jsonb_build_object('op_id', v_op, 'entity', op ->> 'entity', 'id', op ->> 'id') || res;
            insert into public.sync_ops (op_id, workspace_id, user_id, device, result) values (v_op, p_workspace, uid, p_device, res);
        exception when unique_violation then
            res := jsonb_build_object('op_id', v_op, 'status', 'rejected', 'error', 'op_id already used');
        end;
        results := results || jsonb_build_array(res);
    end loop;
    return jsonb_build_object('server_time', now(), 'results', results);
end;
$$;
revoke all on function public.crm_push(uuid, text, jsonb) from public, anon;
grant execute on function public.crm_push(uuid, text, jsonb) to authenticated;

-- Очистка: операции старше 30 дней, надгробия старше 90 дней. Повтор безопасен.
create or replace function private.crm_maintenance(p_workspace uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    e record;
    n int;
    total int := 0;
    ops int;
begin
    delete from public.sync_ops where applied_at < now() - interval '30 days'
        and (p_workspace is null or workspace_id = p_workspace);
    get diagnostics ops = row_count;
    for e in select entity from private.crm_entities order by entity desc loop
        begin
            execute format('delete from public.%I where deleted_at < now() - interval ''90 days'' and ($1 is null or workspace_id = $1)',
                           e.entity) using p_workspace;
            get diagnostics n = row_count;
            total := total + n;
        exception when foreign_key_violation then
            null;  -- на надгробие ещё ссылаются другие записи: удалится при следующей очистке
        end;
    end loop;
    return jsonb_build_object('sync_ops', ops, 'tombstones', total);
end;
$$;
revoke all on function private.crm_maintenance(uuid) from public, anon, authenticated;

create or replace function public.crm_maintenance(p_workspace uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.require_perm(p_workspace, 'workspace.manage');
    return private.crm_maintenance(p_workspace);
end;
$$;
revoke all on function public.crm_maintenance(uuid) from public, anon;
grant execute on function public.crm_maintenance(uuid) to authenticated;
