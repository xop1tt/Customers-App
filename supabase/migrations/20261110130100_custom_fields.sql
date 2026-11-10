-- Customers 2.0: свои поля. Определения (custom_fields, меняет fields.manage) и значения (custom_field_values:
-- одна строка на пару «запись — поле», как остальные записи CRM с версиями и слиянием по полям).
-- Только добавление объектов; crm_stamp пересоздаётся с правом fields.manage для определений и ссылкой field_id.

create table if not exists public.custom_fields (
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
    label text not null check (char_length(btrim(label)) between 1 and 80),
    kind text not null default 'text' check (kind in ('text', 'number', 'date', 'select', 'bool')),
    options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array' and pg_column_size(options) <= 8192),
    position numeric not null default 0
);
create index if not exists custom_fields_type on public.custom_fields (workspace_id, entity_type) where deleted_at is null;

create table if not exists public.custom_field_values (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    field_id uuid not null references public.custom_fields (id),
    entity_type text not null check (entity_type in ('company', 'contact', 'crm_lead', 'deal')),
    entity_id uuid not null,
    value jsonb check (value is null or pg_column_size(value) <= 8192)
);
create index if not exists custom_field_values_entity on public.custom_field_values (workspace_id, entity_type, entity_id);

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
            if not private.has_perm(new.workspace_id, case when tg_table_name = 'custom_fields' then 'fields.manage' else 'pipelines.manage' end) then
                raise exception 'permission denied: %', case when tg_table_name = 'custom_fields' then 'fields.manage' else 'pipelines.manage' end using errcode = '42501';
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
                                     ('deal_id', 'deals'), ('parent_id', 'comments'),
                                     ('field_id', 'custom_fields')) as r(col, tbl) loop
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

select private.crm_attach('custom_fields', 'settings', array['archived_at', 'deleted_at', 'entity_type', 'label', 'kind', 'options', 'position']);
select private.crm_attach('custom_field_values', 'records', array['deleted_at', 'field_id', 'entity_type', 'entity_id', 'value']);

-- Определения полей меняет fields.manage (а не pipelines.manage, как у воронок).
drop policy if exists custom_fields_insert on public.custom_fields;
create policy custom_fields_insert on public.custom_fields for insert to authenticated
    with check (private.has_perm(workspace_id, 'fields.manage'));
drop policy if exists custom_fields_update on public.custom_fields;
create policy custom_fields_update on public.custom_fields for update to authenticated
    using (private.has_perm(workspace_id, 'fields.manage')) with check (private.has_perm(workspace_id, 'fields.manage'));
