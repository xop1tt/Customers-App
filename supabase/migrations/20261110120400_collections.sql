-- Customers 2.0, этап 7: коллекции (сохранённые представления) и порядок коллекций у каждого пользователя.
-- Документы: docs/CRM_ARCHITECTURE.md §7–8. Только добавление объектов.
--
-- config: {"filters": [{"field", "op", "value"}], "sort": [{"field", "dir"}], "columns": [...], "widths": {...}}.
-- Фильтр исполняется запросом к таблице (на устройстве — к базе Workspace), данные не копируются.

create table if not exists public.collections (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    visibility text not null default 'private' check (visibility in ('private', 'workspace')),
    entity_type text not null check (entity_type in ('company', 'contact', 'crm_lead', 'deal', 'task')),
    name text not null check (char_length(btrim(name)) between 1 and 80),
    icon text check (icon ~ '^[a-z][a-z0-9-]{0,40}$'),
    emoji text check (char_length(emoji) <= 16),
    config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 16384),
    position numeric not null default 0,
    builtin text check (builtin ~ '^[a-z_]{1,40}$')
);
create unique index if not exists collections_builtin on public.collections (workspace_id, builtin) where builtin is not null;

select private.crm_attach('collections', 'collections', array['deleted_at', 'visibility', 'entity_type', 'name', 'icon',
    'emoji', 'config', 'position']);

create table if not exists public.collection_user_prefs (
    collection_id uuid not null references public.collections (id) on delete cascade,
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    position numeric not null default 0,
    hidden boolean not null default false,
    updated_at timestamptz not null default now(),
    server_seq bigint not null default nextval('public.sync_seq'),
    primary key (collection_id, user_id)
);
create index if not exists collection_user_prefs_user on public.collection_user_prefs (user_id, workspace_id, server_seq);

create or replace function private.collection_prefs_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if tg_op = 'UPDATE' and (new.user_id is distinct from old.user_id or new.collection_id is distinct from old.collection_id) then
        raise exception 'collection_id and user_id cannot be changed' using errcode = '42501';
    end if;
    perform private.check_ref('collections', new.collection_id, new.workspace_id);
    new.updated_at := now();
    new.server_seq := nextval('public.sync_seq');
    return new;
end;
$$;
revoke all on function private.collection_prefs_stamp() from public, anon, authenticated;
drop trigger if exists collection_user_prefs_stamp on public.collection_user_prefs;
create trigger collection_user_prefs_stamp before insert or update on public.collection_user_prefs
    for each row execute function private.collection_prefs_stamp();

alter table public.collection_user_prefs enable row level security;
alter table public.collection_user_prefs force row level security;
drop policy if exists collection_user_prefs_select on public.collection_user_prefs;
create policy collection_user_prefs_select on public.collection_user_prefs for select to authenticated
    using (user_id = (select auth.uid()) and private.is_member(workspace_id));
drop policy if exists collection_user_prefs_insert on public.collection_user_prefs;
create policy collection_user_prefs_insert on public.collection_user_prefs for insert to authenticated
    with check (user_id = (select auth.uid()) and private.has_perm(workspace_id, 'records.view'));
drop policy if exists collection_user_prefs_update on public.collection_user_prefs;
create policy collection_user_prefs_update on public.collection_user_prefs for update to authenticated
    using (user_id = (select auth.uid()) and private.is_member(workspace_id))
    with check (user_id = (select auth.uid()) and private.is_member(workspace_id));
revoke all on public.collection_user_prefs from anon, public, authenticated;
grant select, insert, update on public.collection_user_prefs to authenticated;

-- Встроенные коллекции — обычные строки шаблона (их можно переименовать, скрыть или удалить).
create or replace function private.seed_collections(p_workspace uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.collections (id, workspace_id, created_by, visibility, entity_type, name, emoji, config, position, builtin)
    select gen_random_uuid(), p_workspace, auth.uid(), 'workspace', c.entity, c.name, c.emoji, c.config::jsonb, c.pos, c.builtin
    from (values
        ('all_clients', 'company', 'Все клиенты', '🤝', '{"filters": [], "sort": [{"field": "updated_at", "dir": "desc"}]}', 1),
        ('my_clients', 'company', 'Мои клиенты', '⭐', '{"filters": [{"field": "owner_id", "op": "eq", "value": "$me"}], "sort": [{"field": "updated_at", "dir": "desc"}]}', 2),
        ('new_leads', 'crm_lead', 'Новые лиды', '🌱', '{"filters": [{"field": "status", "op": "eq", "value": "new"}], "sort": [{"field": "created_at", "dir": "desc"}]}', 3),
        ('deals_this_week', 'deal', 'Сделки на этой неделе', '📅', '{"filters": [{"field": "expected_close_date", "op": "this_week"}, {"field": "status", "op": "eq", "value": "open"}], "sort": [{"field": "expected_close_date", "dir": "asc"}]}', 4),
        ('overdue_tasks', 'task', 'Просроченные задачи', '⏰', '{"filters": [{"field": "due_at", "op": "overdue"}], "sort": [{"field": "due_at", "dir": "asc"}]}', 5),
        ('won_deals', 'deal', 'Успешные сделки', '🏆', '{"filters": [{"field": "status", "op": "eq", "value": "won"}], "sort": [{"field": "closed_at", "dir": "desc"}]}', 6),
        ('lost_deals', 'deal', 'Потерянные сделки', '🥀', '{"filters": [{"field": "status", "op": "eq", "value": "lost"}], "sort": [{"field": "closed_at", "dir": "desc"}]}', 7)
    ) as c(builtin, entity, name, emoji, config, pos)
    on conflict do nothing;
end;
$$;
revoke all on function private.seed_collections(uuid) from public, anon, authenticated;

create or replace function private.seed_workspace(p_workspace uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.seed_pipeline(p_workspace);
    perform private.seed_collections(p_workspace);
end;
$$;
