-- Отделы как сущность (2026-11-21, ADR-095, решение Maksim: «сделай отделы не просто текстом», видимость —
-- «настраивается в роли»). Только добавления: новая таблица, новые столбцы с значениями по умолчанию, новые функции,
-- политики и триггеры. Повторное применение безопасно. Старые версии приложения продолжают работать: текстовое
-- поле member_profiles.department сохраняется и заполняется названием отдела.
--
--  * public.departments — дерево отделов Workspace (parent_id), руководитель отдела (head_id), мягкое удаление.
--  * member_profiles.department_id — отдел сотрудника.
--  * department_id у компаний, контактов, лидов, сделок и задач. Новая запись по умолчанию получает отдел
--    ответственного (или автора). Передать запись в другой отдел — сменить department_id.
--  * public.role_scopes — какие записи видит роль в этом Workspace (системные роли общие для всех Workspace, поэтому
--    настройка хранится отдельно): all (все, по умолчанию), department (свой отдел с подотделами, записи без отдела
--    и свои), own (только свои). Владелец видит всё всегда.
--  * Заметки, комментарии, звонки, вложения, свои поля и контакты сделки видны вместе со своей карточкой.
--  * public.crm_scope_events — журнал изменений видимости (только id, без данных): по нему устройства убирают
--    записи, которые сотруднику больше не видны.

-- ------------------------------------------------------------------ таблицы и столбцы

create table if not exists public.departments (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    name text not null check (char_length(btrim(name)) between 1 and 120),
    parent_id uuid references public.departments (id),
    head_id uuid references auth.users (id) on delete set null,
    position numeric not null default 0,
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    check (parent_id is null or parent_id <> id)
);
create unique index if not exists departments_name on public.departments (workspace_id, lower(btrim(name))) where deleted_at is null;
create index if not exists departments_parent on public.departments (workspace_id, parent_id);
alter table public.departments enable row level security;
alter table public.departments force row level security;
revoke all on public.departments from anon, public, authenticated;
grant select on public.departments to authenticated;
drop policy if exists departments_select on public.departments;
create policy departments_select on public.departments for select to authenticated
    using (private.is_member(workspace_id));

alter table public.member_profiles add column if not exists department_id uuid references public.departments (id);
create table if not exists public.role_scopes (
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    role_id uuid not null references public.roles (id) on delete cascade,
    scope text not null check (scope in ('all', 'department', 'own')),
    primary key (workspace_id, role_id)
);
alter table public.role_scopes enable row level security;
alter table public.role_scopes force row level security;
revoke all on public.role_scopes from anon, public, authenticated;
grant select on public.role_scopes to authenticated;
drop policy if exists role_scopes_select on public.role_scopes;
create policy role_scopes_select on public.role_scopes for select to authenticated
    using (private.is_member(workspace_id));

alter table public.companies add column if not exists department_id uuid references public.departments (id);
alter table public.contacts add column if not exists department_id uuid references public.departments (id);
alter table public.crm_leads add column if not exists department_id uuid references public.departments (id);
alter table public.deals add column if not exists department_id uuid references public.departments (id);
alter table public.tasks add column if not exists department_id uuid references public.departments (id);
create index if not exists companies_department on public.companies (workspace_id, department_id);
create index if not exists contacts_department on public.contacts (workspace_id, department_id);
create index if not exists crm_leads_department on public.crm_leads (workspace_id, department_id);
create index if not exists deals_department on public.deals (workspace_id, department_id);
create index if not exists tasks_department on public.tasks (workspace_id, department_id);

create table if not exists public.crm_scope_events (
    id bigserial primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    entity text,          -- null: изменились права или структура — устройству нужно перепроверить всё
    entity_id uuid,
    user_id uuid,         -- полная перепроверка только для этого сотрудника (его роль или отдел); null — для всех
    at timestamptz not null default now()
);
create index if not exists crm_scope_events_ws on public.crm_scope_events (workspace_id, id);
alter table public.crm_scope_events enable row level security;
alter table public.crm_scope_events force row level security;
revoke all on public.crm_scope_events from anon, public, authenticated;
grant select on public.crm_scope_events to authenticated;
drop policy if exists crm_scope_events_select on public.crm_scope_events;
create policy crm_scope_events_select on public.crm_scope_events for select to authenticated
    using (private.is_member(workspace_id) and (user_id is null or user_id = (select auth.uid())));

-- crm_push принимает новое поле (crm_attach пересоздаёт и политики; политики чтения задаются ниже).
select private.crm_attach('companies', 'records', array['owner_id', 'archived_at', 'deleted_at', 'name', 'legal_name', 'inn',
    'domain', 'website', 'phones', 'emails', 'address', 'industry', 'size_range', 'source', 'source_lead_id', 'source_payload',
    'dedupe_keys', 'department_id']);
select private.crm_attach('contacts', 'records', array['owner_id', 'archived_at', 'deleted_at', 'company_id', 'first_name',
    'last_name', 'position', 'phones', 'emails', 'messengers', 'source', 'source_lead_id', 'source_payload', 'dedupe_keys',
    'department_id']);
select private.crm_attach('crm_leads', 'records', array['owner_id', 'archived_at', 'deleted_at', 'title', 'person_name',
    'company_name', 'phones', 'emails', 'status', 'source', 'source_lead_id', 'converted_company_id', 'converted_contact_id',
    'department_id']);
select private.crm_attach('deals', 'records', array['owner_id', 'archived_at', 'deleted_at', 'pipeline_id', 'stage_id', 'title',
    'amount', 'currency', 'expected_close_date', 'company_id', 'lost_reason', 'department_id']);
select private.crm_attach('tasks', 'records', array['archived_at', 'deleted_at', 'title', 'description', 'assignee_id', 'due_at',
    'remind_at', 'priority', 'status', 'entity_type', 'entity_id', 'department_id']);

-- ------------------------------------------------------------------ видимость

-- Какие записи видит текущий пользователь в Workspace.
create or replace function private.record_scope(p_workspace uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
    select case when r.rank >= 100 then 'all' else coalesce(rs.scope, 'all') end
    from public.workspace_members m join public.roles r on r.id = m.role_id
    left join public.role_scopes rs on rs.workspace_id = m.workspace_id and rs.role_id = m.role_id
    where m.workspace_id = p_workspace and m.user_id = (select auth.uid()) and m.status = 'active';
$$;
revoke all on function private.record_scope(uuid) from public, anon;
grant execute on function private.record_scope(uuid) to authenticated;

-- Отделы пользователя с подотделами: свой отдел и отделы, которыми он руководит.
create or replace function private.my_departments(p_workspace uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
    with recursive tree(id, depth) as (
        select d.id, 0 from public.departments d
        where d.workspace_id = p_workspace and d.deleted_at is null
          and (d.head_id = (select auth.uid())
               or d.id = (select mp.department_id from public.member_profiles mp
                          where mp.workspace_id = p_workspace and mp.user_id = (select auth.uid())))
        union
        select d.id, t.depth + 1 from public.departments d join tree t on d.parent_id = t.id
        where d.deleted_at is null and t.depth < 50
    )
    select coalesce(array_agg(distinct id), '{}') from tree;
$$;
revoke all on function private.my_departments(uuid) from public, anon;
grant execute on function private.my_departments(uuid) to authenticated;

create or replace function private.can_see(p_workspace uuid, p_department uuid, p_created_by uuid, p_owner uuid, p_assignee uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select private.has_perm(p_workspace, 'records.view') and (
        case private.record_scope(p_workspace)
            when 'all' then true
            when 'department' then p_department is null
                or p_department = any(private.my_departments(p_workspace))
                or (select auth.uid()) in (p_owner, p_assignee)
                or (p_owner is null and (select auth.uid()) = p_created_by)
            when 'own' then (select auth.uid()) in (p_owner, p_assignee)
                or (p_owner is null and (select auth.uid()) = p_created_by)
            else false
        end);
$$;
revoke all on function private.can_see(uuid, uuid, uuid, uuid, uuid) from public, anon;
grant execute on function private.can_see(uuid, uuid, uuid, uuid, uuid) to authenticated;

-- Видна ли карточка (компания, контакт, лид, сделка), к которой относится дочерняя запись.
create or replace function private.can_see_entity(p_workspace uuid, p_type text, p_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    t text := private.entity_table(p_type);
    r jsonb;
begin
    if not private.has_perm(p_workspace, 'records.view') then
        return false;
    end if;
    if private.record_scope(p_workspace) = 'all' then
        return true;
    end if;
    if t is null or p_id is null then
        return false;
    end if;
    execute format('select to_jsonb(x) from public.%I x where x.id = $1 and x.workspace_id = $2', t)
        into r using p_id, p_workspace;
    if r is null then
        return false;
    end if;
    return private.can_see(p_workspace, (r ->> 'department_id')::uuid, (r ->> 'created_by')::uuid,
                           (r ->> 'owner_id')::uuid, (r ->> 'assignee_id')::uuid);
end;
$$;
revoke all on function private.can_see_entity(uuid, text, uuid) from public, anon;
grant execute on function private.can_see_entity(uuid, text, uuid) to authenticated;

-- Политики чтения записей. Остальные политики (вставка, правка) не меняются.
drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies for select to authenticated
    using (private.can_see(workspace_id, department_id, created_by, owner_id, null));
drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts for select to authenticated
    using (private.can_see(workspace_id, department_id, created_by, owner_id, null));
drop policy if exists crm_leads_select on public.crm_leads;
create policy crm_leads_select on public.crm_leads for select to authenticated
    using (private.can_see(workspace_id, department_id, created_by, owner_id, null));
drop policy if exists deals_select on public.deals;
create policy deals_select on public.deals for select to authenticated
    using (private.can_see(workspace_id, department_id, created_by, owner_id, null));
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
    using (private.can_see(workspace_id, department_id, created_by, null, assignee_id)
           and (entity_id is null or assignee_id = (select auth.uid())
                or private.can_see_entity(workspace_id, entity_type, entity_id)));

drop policy if exists notes_select on public.notes;
create policy notes_select on public.notes for select to authenticated
    using (private.can_see_entity(workspace_id, entity_type, entity_id));
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select to authenticated
    using (private.can_see_entity(workspace_id, entity_type, entity_id));
drop policy if exists activities_select on public.activities;
create policy activities_select on public.activities for select to authenticated
    using (private.can_see_entity(workspace_id, entity_type, entity_id));
drop policy if exists attachments_select on public.attachments;
create policy attachments_select on public.attachments for select to authenticated
    using (private.can_see_entity(workspace_id, entity_type, entity_id));
drop policy if exists custom_field_values_select on public.custom_field_values;
create policy custom_field_values_select on public.custom_field_values for select to authenticated
    using (private.can_see_entity(workspace_id, entity_type, entity_id));
drop policy if exists deal_contacts_select on public.deal_contacts;
create policy deal_contacts_select on public.deal_contacts for select to authenticated
    using (private.can_see_entity(workspace_id, 'deal', deal_id));
drop policy if exists deal_stage_history_select on public.deal_stage_history;
create policy deal_stage_history_select on public.deal_stage_history for select to authenticated
    using (private.can_see_entity(workspace_id, 'deal', deal_id));

-- ------------------------------------------------------------------ отдел записи по умолчанию и журнал видимости

create or replace function private.record_department()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    n jsonb := to_jsonb(new);
    o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
    who uuid;
begin
    if tg_op = 'INSERT' and new.department_id is null then
        who := coalesce((n ->> 'owner_id')::uuid, (n ->> 'assignee_id')::uuid, new.created_by);
        select mp.department_id into new.department_id from public.member_profiles mp
        join public.departments d on d.id = mp.department_id and d.deleted_at is null
        where mp.workspace_id = new.workspace_id and mp.user_id = who;
    end if;
    if new.department_id is not null and (tg_op = 'INSERT' or new.department_id is distinct from old.department_id)
       and not exists (select 1 from public.departments d where d.id = new.department_id
                       and d.workspace_id = new.workspace_id and d.deleted_at is null) then
        raise exception 'department not found in this workspace' using errcode = '23503';
    end if;
    if tg_op = 'UPDATE' and (new.department_id is distinct from old.department_id
                             or (n ->> 'owner_id') is distinct from (o ->> 'owner_id')
                             or (n ->> 'assignee_id') is distinct from (o ->> 'assignee_id')) then
        insert into public.crm_scope_events (workspace_id, entity, entity_id) values (new.workspace_id, tg_table_name, new.id);
    end if;
    return new;
end;
$$;
revoke all on function private.record_department() from public, anon, authenticated;

do $$
declare
    t text;
begin
    foreach t in array array['companies', 'contacts', 'crm_leads', 'deals', 'tasks'] loop
        execute format('drop trigger if exists %I on public.%I', t || '_department', t);
        execute format('create trigger %I before insert or update on public.%I for each row execute function private.record_department()',
                       t || '_department', t);
    end loop;
end;
$$;

-- Перепроверить всё: изменились отдел или роль сотрудника, видимость роли или структура отделов.
create or replace function private.scope_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    r jsonb := coalesce(to_jsonb(new), to_jsonb(old));
    ws uuid := (r ->> 'workspace_id')::uuid;
    who uuid := case when tg_table_name in ('member_profiles', 'workspace_members') then (r ->> 'user_id')::uuid end;
begin
    if ws is not null then
        insert into public.crm_scope_events (workspace_id, user_id) values (ws, who);
    end if;
    return null;
end;
$$;
revoke all on function private.scope_changed() from public, anon, authenticated;

create or replace trigger departments_scope after insert or update or delete on public.departments
    for each row execute function private.scope_changed();
create or replace trigger member_profiles_scope after update on public.member_profiles
    for each row when (old.department_id is distinct from new.department_id) execute function private.scope_changed();
create or replace trigger member_profiles_scope_new after insert on public.member_profiles
    for each row when (new.department_id is not null) execute function private.scope_changed();
create or replace trigger workspace_members_scope after update of role_id, status on public.workspace_members
    for each row execute function private.scope_changed();
create or replace trigger role_scopes_scope after insert or update or delete on public.role_scopes
    for each row execute function private.scope_changed();

-- ------------------------------------------------------------------ управление отделами

create or replace function private.department_of_ws(p_workspace uuid, p_id uuid)
returns public.departments
language sql
stable
security definer
set search_path = ''
as $$
    select * from public.departments where id = p_id and workspace_id = p_workspace and deleted_at is null;
$$;
revoke all on function private.department_of_ws(uuid, uuid) from public, anon, authenticated;

-- Создать (p_id null) или изменить отдел: название, вышестоящий отдел, руководитель. Нужно members.manage.
create or replace function public.save_department(p_workspace uuid, p_id uuid, p_name text, p_parent uuid default null,
                                                  p_head uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    rid uuid;
    walker uuid;
    steps int := 0;
begin
    perform private.require_perm(p_workspace, 'members.manage');
    if char_length(btrim(coalesce(p_name, ''))) not between 1 and 120 then
        raise exception 'department name is 1 to 120 characters' using errcode = '22023';
    end if;
    if p_head is not null and private.rank_of(p_workspace, p_head) is null then
        raise exception 'head must be an active member' using errcode = '22023';
    end if;
    if p_parent is not null and (private.department_of_ws(p_workspace, p_parent)).id is null then
        raise exception 'parent department not found' using errcode = 'P0002';
    end if;
    if p_id is not null then
        if (private.department_of_ws(p_workspace, p_id)).id is null then
            raise exception 'department not found' using errcode = 'P0002';
        end if;
        walker := p_parent;
        while walker is not null and steps < 60 loop
            if walker = p_id then
                raise exception 'department tree would form a cycle' using errcode = '22023';
            end if;
            select parent_id into walker from public.departments where id = walker;
            steps := steps + 1;
        end loop;
    end if;
    if exists (select 1 from public.departments where workspace_id = p_workspace and deleted_at is null
               and lower(btrim(name)) = lower(btrim(p_name)) and id is distinct from p_id) then
        raise exception 'department already exists' using errcode = '23505';
    end if;
    if p_id is null then
        insert into public.departments (workspace_id, name, parent_id, head_id, created_by)
        values (p_workspace, btrim(p_name), p_parent, p_head, u) returning id into rid;
    else
        update public.departments set name = btrim(p_name), parent_id = p_parent, head_id = p_head, updated_at = now()
        where id = p_id returning id into rid;
        -- Старые версии приложения показывают отдел по тексту в карточке сотрудника.
        update public.member_profiles set department = btrim(p_name) where workspace_id = p_workspace and department_id = rid;
    end if;
    insert into public.audit_log (workspace_id, actor_id, action, entity_type, entity_id, details)
    values (p_workspace, u, case when p_id is null then 'department_create' else 'department_update' end, 'department', rid,
            jsonb_build_object('name', btrim(p_name), 'parent', p_parent, 'head', p_head));
    return rid;
end;
$$;
revoke all on function public.save_department(uuid, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.save_department(uuid, uuid, text, uuid, uuid) to authenticated;

-- Закрыть отдел: подотделы, сотрудники и записи переходят в вышестоящий отдел (или остаются без отдела).
create or replace function public.delete_department(p_workspace uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    d public.departments;
    parent_name text;
    t text;
begin
    perform private.require_perm(p_workspace, 'members.manage');
    d := private.department_of_ws(p_workspace, p_id);
    if d.id is null then
        raise exception 'department not found' using errcode = 'P0002';
    end if;
    select name into parent_name from public.departments where id = d.parent_id;
    update public.departments set parent_id = d.parent_id, updated_at = now() where parent_id = d.id and deleted_at is null;
    update public.member_profiles set department_id = d.parent_id, department = coalesce(parent_name, ''), updated_at = now()
    where workspace_id = p_workspace and department_id = d.id;
    foreach t in array array['companies', 'contacts', 'crm_leads', 'deals', 'tasks'] loop
        execute format('update public.%I set department_id = $1, field_ts = field_ts || jsonb_build_object(''department_id'', now()) '
                       'where workspace_id = $2 and department_id = $3', t) using d.parent_id, p_workspace, d.id;
    end loop;
    update public.departments set deleted_at = now(), updated_at = now() where id = d.id;
    insert into public.audit_log (workspace_id, actor_id, action, entity_type, entity_id, details)
    values (p_workspace, private.uid(), 'department_delete', 'department', d.id, jsonb_build_object('name', d.name));
end;
$$;
revoke all on function public.delete_department(uuid, uuid) from public, anon;
grant execute on function public.delete_department(uuid, uuid) to authenticated;

-- Назначить сотрудника в отдел (p_department null — без отдела). Права — как на карточку сотрудника.
create or replace function public.set_member_department(p_workspace uuid, p_user uuid, p_department uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    d public.departments;
begin
    perform private.require_perm(p_workspace, 'members.view');
    if private.rank_of(p_workspace, p_user) is null then
        raise exception 'not a member' using errcode = 'P0002';
    end if;
    if not private.can_edit_member(p_workspace, p_user) then
        raise exception 'permission denied: member profile' using errcode = '42501';
    end if;
    if p_department is not null then
        d := private.department_of_ws(p_workspace, p_department);
        if d.id is null then
            raise exception 'department not found' using errcode = 'P0002';
        end if;
    end if;
    insert into public.member_profiles (workspace_id, user_id, department_id, department, updated_by)
    values (p_workspace, p_user, d.id, coalesce(d.name, ''), private.uid())
    on conflict (workspace_id, user_id) do update
        set department_id = excluded.department_id, department = excluded.department,
            updated_by = excluded.updated_by, updated_at = now();
end;
$$;
revoke all on function public.set_member_department(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_member_department(uuid, uuid, uuid) to authenticated;

-- Какие записи видит роль в Workspace. Правила — как у save_role: роль ниже своей и не своя.
create or replace function public.set_role_scope(p_workspace uuid, p_key text, p_scope text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    mine int;
    r public.roles;
begin
    perform private.require_perm(p_workspace, 'roles.manage');
    if p_scope is null or p_scope not in ('all', 'department', 'own') then
        raise exception 'scope is all, department or own' using errcode = '22023';
    end if;
    mine := private.rank_of(p_workspace, u);
    select * into r from public.roles
    where key = p_key and (workspace_id = p_workspace or (workspace_id is null and is_system))
    order by workspace_id nulls last limit 1;
    if r.id is null then
        raise exception 'role not found' using errcode = 'P0002';
    end if;
    if r.rank >= mine then
        raise exception 'cannot change a role at or above your own' using errcode = '42501';
    end if;
    if mine < 100 and exists (select 1 from public.workspace_members m
                              where m.workspace_id = p_workspace and m.user_id = u and m.role_id = r.id) then
        raise exception 'cannot change your own role' using errcode = '42501';
    end if;
    insert into public.role_scopes (workspace_id, role_id, scope) values (p_workspace, r.id, p_scope)
    on conflict (workspace_id, role_id) do update set scope = excluded.scope;
    insert into public.audit_log (workspace_id, actor_id, action, entity_type, entity_id, details)
    values (p_workspace, u, 'role_scope', 'role', r.id, jsonb_build_object('key', p_key, 'scope', p_scope));
end;
$$;
revoke all on function public.set_role_scope(uuid, text, text) from public, anon;
grant execute on function public.set_role_scope(uuid, text, text) to authenticated;

-- ------------------------------------------------------------------ отдел по названию (совместимость)

-- Карточка сотрудника по-прежнему может прислать отдел текстом (update_member_profile, старые версии приложения):
-- отдел находится по названию или создаётся, сотрудник привязывается к нему.
create or replace function private.member_department_by_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    nm text := btrim(coalesce(new.department, ''));
    did uuid;
begin
    if tg_op = 'UPDATE' and (new.department is not distinct from old.department
                             or new.department_id is distinct from old.department_id) then
        return new;
    end if;
    if tg_op = 'INSERT' and new.department_id is not null then
        return new;
    end if;
    if nm = '' then
        new.department_id := null;
        return new;
    end if;
    select id into did from public.departments
    where workspace_id = new.workspace_id and deleted_at is null and lower(btrim(name)) = lower(nm);
    if did is null then
        insert into public.departments (workspace_id, name, created_by) values (new.workspace_id, nm, auth.uid())
        returning id into did;
    end if;
    new.department_id := did;
    return new;
end;
$$;
revoke all on function private.member_department_by_name() from public, anon, authenticated;
create or replace trigger member_profiles_department_name before insert or update on public.member_profiles
    for each row execute function private.member_department_by_name();

-- Отделы, которые до сих пор были только текстом в карточках, становятся настоящими отделами.
insert into public.departments (workspace_id, name)
select distinct on (mp.workspace_id, lower(btrim(mp.department))) mp.workspace_id, btrim(mp.department)
from public.member_profiles mp
where btrim(mp.department) <> '' and mp.department_id is null
  and not exists (select 1 from public.departments d where d.workspace_id = mp.workspace_id and d.deleted_at is null
                  and lower(btrim(d.name)) = lower(btrim(mp.department)))
order by mp.workspace_id, lower(btrim(mp.department)), mp.department;
update public.member_profiles mp set department_id = d.id
from public.departments d
where mp.department_id is null and btrim(mp.department) <> '' and d.workspace_id = mp.workspace_id
  and d.deleted_at is null and lower(btrim(d.name)) = lower(btrim(mp.department));

-- Справочник сотрудников отдаёт и id отдела.
create or replace function public.team_directory(p_workspace uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    perform private.require_perm(p_workspace, 'members.view');
    return (
        select coalesce(jsonb_agg(jsonb_build_object(
            'user_id', m.user_id,
            'display_name', private.display_name(m.user_id),
            'avatar', p.avatar_data,
            'email', u.email,
            'role', r.key, 'role_name', r.name, 'rank', r.rank,
            'joined_at', m.joined_at,
            'title', coalesce(mp.title, ''),
            'department', coalesce(mp.department, ''),
            'department_id', mp.department_id,
            'manager_id', case when private.rank_of(p_workspace, mp.manager_id) is not null then mp.manager_id end,
            'hired_on', coalesce(mp.hired_on, (m.joined_at at time zone 'UTC')::date),
            'last_seen', pr.seen_at,
            'online', coalesce(pr.seen_at > now() - interval '90 seconds', false),
            'can_edit', private.can_edit_member(p_workspace, m.user_id)
        ) order by r.rank desc, private.display_name(m.user_id)), '[]'::jsonb)
        from public.workspace_members m
        join public.roles r on r.id = m.role_id
        join auth.users u on u.id = m.user_id
        left join public.user_profiles p on p.user_id = m.user_id
        left join public.member_profiles mp on mp.workspace_id = m.workspace_id and mp.user_id = m.user_id
        left join public.workspace_presence pr on pr.workspace_id = m.workspace_id and pr.user_id = m.user_id
        where m.workspace_id = p_workspace and m.status = 'active'
    );
end;
$$;
