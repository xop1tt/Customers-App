-- Customers 2.0, этап 3: Workspace, профили, участники, приглашения, роли и разрешения.
-- Документы: docs/WORKSPACE_AND_PERMISSIONS.md, docs/DATABASE_SCHEMA.md §3.1, docs/SECURITY_MODEL.md.
--
-- Миграция только добавляет объекты (create … if not exists / create or replace / drop policy if exists +
-- create policy), повторное применение безопасно. Таблицы генератора лидов (leads, exclusions, user_settings)
-- и их функции не меняются.
--
-- Права проверяются только по разрешению (private.has_perm), не по названию роли. Запись в таблицы прав
-- для authenticated закрыта: нет политик и грантов на insert/update/delete — только функции ниже.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ------------------------------------------------------------------ таблицы

create table if not exists public.workspaces (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(btrim(name)) between 1 and 120),
    personal boolean not null default false,
    -- Создатель; при удалении его учётной записи Workspace остаётся у других участников.
    created_by uuid default auth.uid() references auth.users (id) on delete set null,
    default_currency char(3) not null default 'RUB' check (default_currency ~ '^[A-Z]{3}$'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
);
create unique index if not exists workspaces_one_personal on public.workspaces (created_by)
    where personal and deleted_at is null;

create table if not exists public.user_profiles (
    user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
    display_name text not null default '' check (char_length(display_name) <= 120),
    avatar_path text check (avatar_path ~ '^avatars/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png)$'),
    updated_at timestamptz not null default now()
);

create table if not exists public.permissions (
    key text primary key check (key ~ '^[a-z]+\.[a-z_]+$'),
    description text not null
);

create table if not exists public.roles (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid references public.workspaces (id) on delete cascade,  -- null: системная роль-шаблон
    key text not null check (key ~ '^[a-z][a-z0-9_]{0,40}$'),
    name text not null check (char_length(btrim(name)) between 1 and 60),
    rank int not null check (rank between 0 and 100),
    is_system boolean not null default false,
    unique nulls not distinct (workspace_id, key)
);

create table if not exists public.role_permissions (
    role_id uuid not null references public.roles (id) on delete cascade,
    permission_key text not null references public.permissions (key),
    primary key (role_id, permission_key)
);

create table if not exists public.workspace_members (
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    role_id uuid not null references public.roles (id),
    status text not null default 'active' check (status in ('active', 'removed', 'left')),
    invited_by uuid references auth.users (id) on delete set null,
    joined_at timestamptz not null default now(),
    removed_at timestamptz,
    primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user on public.workspace_members (user_id) where status = 'active';

create table if not exists public.workspace_invitations (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    email_norm text not null check (email_norm = lower(btrim(email_norm)) and email_norm ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    role_id uuid not null references public.roles (id),
    token_hash text not null unique,
    invited_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '7 days',
    sent_count int not null default 1,
    last_sent_at timestamptz not null default now(),
    accepted_at timestamptz,
    accepted_by uuid references auth.users (id) on delete set null,
    revoked_at timestamptz
);
create unique index if not exists invitations_one_open on public.workspace_invitations (workspace_id, email_norm)
    where accepted_at is null and revoked_at is null;

-- ------------------------------------------------------------------ каталог разрешений и системные роли

insert into public.permissions (key, description) values
    ('records.view', 'Читать записи CRM'),
    ('records.create', 'Создавать записи'),
    ('records.edit_own', 'Менять свои записи'),
    ('records.edit', 'Менять любые записи'),
    ('records.delete', 'Удалять и восстанавливать записи'),
    ('records.export', 'Экспорт и массовая выгрузка'),
    ('members.view', 'Видеть участников'),
    ('members.manage', 'Менять роли и удалять участников'),
    ('invitations.manage', 'Приглашать участников'),
    ('roles.manage', 'Создавать и менять свои роли'),
    ('workspace.manage', 'Название, валюта и настройки Workspace'),
    ('workspace.delete', 'Удалить Workspace'),
    ('ownership.transfer', 'Передать владение'),
    ('pipelines.manage', 'Воронки и этапы'),
    ('fields.manage', 'Пользовательские поля'),
    ('collections.manage', 'Общие коллекции'),
    ('analytics.view', 'Аналитика и отчёты'),
    ('audit.view', 'Журнал действий')
on conflict (key) do update set description = excluded.description;

insert into public.roles (workspace_id, key, name, rank, is_system) values
    (null, 'owner', 'Владелец', 100, true),
    (null, 'admin', 'Администратор', 80, true),
    (null, 'manager', 'Менеджер', 60, true),
    (null, 'employee', 'Сотрудник', 40, true),
    (null, 'viewer', 'Наблюдатель', 20, true)
on conflict (workspace_id, key) do update set name = excluded.name, rank = excluded.rank, is_system = true;

with grants (role_key, perms) as (values
    ('owner', array['records.view', 'records.create', 'records.edit_own', 'records.edit', 'records.delete',
                    'records.export', 'members.view', 'members.manage', 'invitations.manage', 'roles.manage',
                    'workspace.manage', 'workspace.delete', 'ownership.transfer', 'pipelines.manage',
                    'fields.manage', 'collections.manage', 'analytics.view', 'audit.view']),
    ('admin', array['records.view', 'records.create', 'records.edit_own', 'records.edit', 'records.delete',
                    'records.export', 'members.view', 'members.manage', 'invitations.manage', 'roles.manage',
                    'workspace.manage', 'pipelines.manage', 'fields.manage', 'collections.manage',
                    'analytics.view', 'audit.view']),
    ('manager', array['records.view', 'records.create', 'records.edit_own', 'records.edit', 'records.delete',
                      'records.export', 'members.view', 'invitations.manage', 'pipelines.manage',
                      'fields.manage', 'collections.manage', 'analytics.view']),
    ('employee', array['records.view', 'records.create', 'records.edit_own', 'members.view', 'analytics.view']),
    ('viewer', array['records.view', 'members.view', 'analytics.view'])
)
insert into public.role_permissions (role_id, permission_key)
select r.id, p from grants g join public.roles r on r.workspace_id is null and r.key = g.role_key, unnest(g.perms) p
on conflict do nothing;

-- ------------------------------------------------------------------ функции прав (используются в политиках)

-- Активный участник не удалённого Workspace.
create or replace function private.is_member(p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.workspace_members m
        join public.workspaces w on w.id = m.workspace_id and w.deleted_at is null
        where m.workspace_id = p_workspace and m.user_id = (select auth.uid()) and m.status = 'active'
    );
$$;

create or replace function private.has_perm(p_workspace uuid, p_perm text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1 from public.workspace_members m
        join public.workspaces w on w.id = m.workspace_id and w.deleted_at is null
        join public.role_permissions rp on rp.role_id = m.role_id and rp.permission_key = p_perm
        where m.workspace_id = p_workspace and m.user_id = (select auth.uid()) and m.status = 'active'
    );
$$;

-- Ранг роли пользователя в Workspace; null — не участник.
create or replace function private.rank_of(p_workspace uuid, p_user uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
    select r.rank from public.workspace_members m join public.roles r on r.id = m.role_id
    where m.workspace_id = p_workspace and m.user_id = p_user and m.status = 'active';
$$;

create or replace function private.require_perm(p_workspace uuid, p_perm text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if (select auth.uid()) is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    if not private.has_perm(p_workspace, p_perm) then
        raise exception 'permission denied: %', p_perm using errcode = '42501';
    end if;
end;
$$;

-- Роль для назначения: своя роль Workspace по ключу, иначе системная.
create or replace function private.role_for(p_workspace uuid, p_key text)
returns public.roles
language sql
stable
security definer
set search_path = ''
as $$
    select r.* from public.roles r
    where r.key = p_key and (r.workspace_id = p_workspace or r.workspace_id is null)
    order by r.workspace_id nulls last
    limit 1;
$$;

create or replace function private.owner_role_id()
returns uuid
language sql
stable
set search_path = ''
as $$
    select id from public.roles where workspace_id is null and key = 'owner';
$$;

-- Начальные данные нового Workspace (воронка-шаблон, встроенные коллекции). Следующие миграции
-- заменяют эту функцию, дополняя её; здесь — пусто.
create or replace function private.seed_workspace(p_workspace uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform p_workspace;
end;
$$;

-- ------------------------------------------------------------------ инвариант: в Workspace есть владелец

create or replace function private.workspace_has_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    ws uuid := coalesce(new.workspace_id, old.workspace_id);
begin
    if exists (select 1 from public.workspaces where id = ws and deleted_at is null)
       and not exists (select 1 from public.workspace_members
                       where workspace_id = ws and status = 'active' and role_id = private.owner_role_id()) then
        if exists (select 1 from public.workspace_members where workspace_id = ws and status = 'active') then
            raise exception 'workspace % must keep an active owner', ws using errcode = '23514';
        end if;
        -- Последний участник ушёл (например, удалил учётную запись): Workspace удаляется мягко.
        update public.workspaces set deleted_at = now(), updated_at = now() where id = ws;
    end if;
    return null;
end;
$$;

drop trigger if exists workspace_members_owner on public.workspace_members;
create constraint trigger workspace_members_owner
    after insert or update or delete on public.workspace_members
    deferrable initially deferred
    for each row execute function private.workspace_has_owner();

-- ------------------------------------------------------------------ RLS

alter table public.workspaces enable row level security;
alter table public.user_profiles enable row level security;
alter table public.permissions enable row level security;
alter table public.roles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.workspaces force row level security;
alter table public.user_profiles force row level security;
alter table public.permissions force row level security;
alter table public.roles force row level security;
alter table public.role_permissions force row level security;
alter table public.workspace_members force row level security;
alter table public.workspace_invitations force row level security;

drop policy if exists workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces for select to authenticated
    using (private.is_member(id));

-- Профиль видит сам пользователь и участники его Workspace.
drop policy if exists user_profiles_select on public.user_profiles;
create policy user_profiles_select on public.user_profiles for select to authenticated
    using (user_id = (select auth.uid()) or exists (
        select 1 from public.workspace_members mine
        join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id and theirs.status = 'active'
        where mine.user_id = (select auth.uid()) and mine.status = 'active' and theirs.user_id = user_profiles.user_id
    ));
drop policy if exists user_profiles_insert on public.user_profiles;
create policy user_profiles_insert on public.user_profiles for insert to authenticated
    with check (user_id = (select auth.uid()));
drop policy if exists user_profiles_update on public.user_profiles;
create policy user_profiles_update on public.user_profiles for update to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists permissions_select on public.permissions;
create policy permissions_select on public.permissions for select to authenticated using (true);

drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles for select to authenticated
    using (workspace_id is null or private.is_member(workspace_id));

drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions for select to authenticated
    using (exists (select 1 from public.roles r where r.id = role_id
                   and (r.workspace_id is null or private.is_member(r.workspace_id))));

drop policy if exists workspace_members_select on public.workspace_members;
create policy workspace_members_select on public.workspace_members for select to authenticated
    using (user_id = (select auth.uid()) or private.has_perm(workspace_id, 'members.view'));

drop policy if exists workspace_invitations_select on public.workspace_invitations;
create policy workspace_invitations_select on public.workspace_invitations for select to authenticated
    using (private.has_perm(workspace_id, 'invitations.manage'));

revoke all on public.workspaces, public.user_profiles, public.permissions, public.roles, public.role_permissions,
    public.workspace_members, public.workspace_invitations from anon, public;
revoke all on public.workspaces, public.user_profiles, public.permissions, public.roles, public.role_permissions,
    public.workspace_members, public.workspace_invitations from authenticated;
grant select on public.workspaces, public.permissions, public.roles, public.role_permissions,
    public.workspace_members to authenticated;
grant select, insert, update on public.user_profiles to authenticated;
-- Хеш токена приглашения не нужен никому, кроме функций: столбец закрыт.
grant select (id, workspace_id, email_norm, role_id, invited_by, created_at, expires_at, sent_count, last_sent_at,
              accepted_at, accepted_by, revoked_at) on public.workspace_invitations to authenticated;

revoke all on function private.is_member(uuid), private.has_perm(uuid, text), private.rank_of(uuid, uuid),
    private.require_perm(uuid, text), private.role_for(uuid, text), private.owner_role_id(),
    private.seed_workspace(uuid), private.workspace_has_owner() from public, anon;
grant execute on function private.is_member(uuid), private.has_perm(uuid, text) to authenticated;

-- ------------------------------------------------------------------ функции сценариев (RPC)

create or replace function private.uid()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
    u uuid := auth.uid();
begin
    if u is null then
        raise exception 'not authenticated' using errcode = '42501';
    end if;
    return u;
end;
$$;
revoke all on function private.uid() from public, anon;

create or replace function private.new_workspace(p_name text, p_personal boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    ws uuid;
begin
    insert into public.workspaces (name, personal, created_by) values (btrim(p_name), p_personal, u) returning id into ws;
    insert into public.workspace_members (workspace_id, user_id, role_id) values (ws, u, private.owner_role_id());
    insert into public.user_profiles (user_id) values (u) on conflict do nothing;
    perform private.seed_workspace(ws);
    return ws;
end;
$$;
revoke all on function private.new_workspace(text, boolean) from public, anon, authenticated;

create or replace function public.create_workspace(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
begin
    if p_name is null or char_length(btrim(p_name)) not between 1 and 120 then
        raise exception 'name must be 1..120 characters' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('ws-create:' || u::text, 0));
    if (select count(*) from public.workspaces where created_by = u and deleted_at is null) >= 20 then
        raise exception 'too many workspaces (max 20)' using errcode = '54000';
    end if;
    return private.new_workspace(p_name, false);
end;
$$;

-- Личный Workspace при первом входе 2.0. Идемпотентно: уникальный индекс workspaces_one_personal и блокировка.
create or replace function public.ensure_personal_workspace(p_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    ws uuid;
    title text;
begin
    perform pg_advisory_xact_lock(hashtextextended('ws-create:' || u::text, 0));
    select id into ws from public.workspaces where created_by = u and personal and deleted_at is null;
    if ws is not null then
        return ws;
    end if;
    title := nullif(btrim(coalesce(p_name, '')), '');
    if title is null then
        select nullif(btrim(value #>> '{}'), '') into title from public.user_settings
        where user_id = u and key = 'profile.name';
    end if;
    title := left(coalesce(title, 'Личное пространство'), 120);
    return private.new_workspace(title, true);
end;
$$;

create or replace function public.update_workspace(p_workspace uuid, p_name text default null, p_currency text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.require_perm(p_workspace, 'workspace.manage');
    if p_name is not null and char_length(btrim(p_name)) not between 1 and 120 then
        raise exception 'name must be 1..120 characters' using errcode = '22023';
    end if;
    if p_currency is not null and p_currency !~ '^[A-Z]{3}$' then
        raise exception 'currency must be an ISO 4217 code' using errcode = '22023';
    end if;
    update public.workspaces set name = coalesce(btrim(p_name), name),
        default_currency = coalesce(p_currency, default_currency), updated_at = now()
    where id = p_workspace;
end;
$$;

-- Список своих Workspace с ролью и разрешениями — для переключателя на устройстве.
create or replace function public.my_workspaces()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', w.id, 'name', w.name, 'personal', w.personal, 'default_currency', w.default_currency,
        'role', r.key, 'role_name', r.name, 'rank', r.rank,
        'members', (select count(*) from public.workspace_members x where x.workspace_id = w.id and x.status = 'active'),
        'permissions', (select coalesce(jsonb_agg(rp.permission_key order by rp.permission_key), '[]'::jsonb)
                        from public.role_permissions rp where rp.role_id = r.id)
    ) order by w.personal desc, w.created_at), '[]'::jsonb)
    from public.workspace_members m
    join public.workspaces w on w.id = m.workspace_id and w.deleted_at is null
    join public.roles r on r.id = m.role_id
    where m.user_id = private.uid() and m.status = 'active';
$$;

-- Участники с профилями (members.view). Почту видят только те, кто может приглашать или управлять участниками.
create or replace function public.workspace_members_list(p_workspace uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    show_email boolean;
begin
    perform private.require_perm(p_workspace, 'members.view');
    show_email := private.has_perm(p_workspace, 'members.manage') or private.has_perm(p_workspace, 'invitations.manage');
    return (
        select coalesce(jsonb_agg(jsonb_build_object(
            'user_id', m.user_id, 'role', r.key, 'role_name', r.name, 'rank', r.rank, 'joined_at', m.joined_at,
            'display_name', coalesce(nullif(p.display_name, ''), split_part(u.email, '@', 1)),
            'avatar_path', p.avatar_path,
            'email', case when show_email or m.user_id = (select auth.uid()) then u.email end
        ) order by r.rank desc, m.joined_at), '[]'::jsonb)
        from public.workspace_members m
        join public.roles r on r.id = m.role_id
        join auth.users u on u.id = m.user_id
        left join public.user_profiles p on p.user_id = m.user_id
        where m.workspace_id = p_workspace and m.status = 'active'
    );
end;
$$;

create or replace function private.new_token()
returns text
language sql
volatile
set search_path = ''
as $$
    select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;

create or replace function private.token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
    select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
$$;
revoke all on function private.new_token(), private.token_hash(text) from public, anon;

-- Приглашение. Токен возвращается один раз; в базе — только его sha256.
create or replace function public.invite_member(p_workspace uuid, p_email text, p_role text default 'employee')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    v_email text := lower(btrim(coalesce(p_email, '')));
    v_role public.roles;
    v_token text := private.new_token();
    v_inv uuid;
begin
    perform private.require_perm(p_workspace, 'invitations.manage');
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
        raise exception 'invalid email' using errcode = '22023';
    end if;
    v_role := private.role_for(p_workspace, p_role);
    if v_role.id is null then
        raise exception 'unknown role %', p_role using errcode = '22023';
    end if;
    if v_role.id = private.owner_role_id() then
        raise exception 'owner role is given only by ownership transfer' using errcode = '42501';
    end if;
    if v_role.rank > private.rank_of(p_workspace, u) then
        raise exception 'cannot invite with a role above your own' using errcode = '42501';
    end if;
    if exists (select 1 from public.workspace_members m join auth.users au on au.id = m.user_id
               where m.workspace_id = p_workspace and m.status = 'active' and lower(au.email) = v_email) then
        raise exception 'already a member' using errcode = '23505';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('ws-invite:' || p_workspace::text, 0));
    if (select count(*) from public.workspace_invitations
        where workspace_id = p_workspace and accepted_at is null and revoked_at is null and expires_at > now()) >= 50 then
        raise exception 'too many open invitations (max 50)' using errcode = '54000';
    end if;
    -- Просроченное открытое приглашение на тот же адрес закрывается, чтобы не мешать новому.
    update public.workspace_invitations set revoked_at = now()
    where workspace_id = p_workspace and email_norm = v_email and accepted_at is null and revoked_at is null
      and expires_at <= now();
    if exists (select 1 from public.workspace_invitations where workspace_id = p_workspace and email_norm = v_email
               and accepted_at is null and revoked_at is null) then
        raise exception 'invitation already sent; resend it instead' using errcode = '23505';
    end if;
    insert into public.workspace_invitations (workspace_id, email_norm, role_id, token_hash, invited_by)
    values (p_workspace, v_email, v_role.id, private.token_hash(v_token), u) returning id into v_inv;
    return jsonb_build_object('id', v_inv, 'token', v_token, 'email', v_email, 'role', v_role.key,
                              'expires_at', now() + interval '7 days');
end;
$$;

-- Повторная отправка: новый токен (старый перестаёт действовать), срок продлевается.
create or replace function public.resend_invitation(p_invitation uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    inv public.workspace_invitations;
    v_token text := private.new_token();
begin
    select * into inv from public.workspace_invitations where id = p_invitation for update;
    if inv.id is null then
        raise exception 'invitation not found' using errcode = 'P0002';
    end if;
    perform private.require_perm(inv.workspace_id, 'invitations.manage');
    if inv.accepted_at is not null or inv.revoked_at is not null then
        raise exception 'invitation is closed' using errcode = '22023';
    end if;
    if inv.sent_count >= 5 then
        raise exception 'invitation was sent too many times (max 5)' using errcode = '54000';
    end if;
    if inv.last_sent_at > now() - interval '10 minutes' then
        raise exception 'invitation was sent less than 10 minutes ago' using errcode = '54000';
    end if;
    update public.workspace_invitations set token_hash = private.token_hash(v_token), sent_count = sent_count + 1,
        last_sent_at = now(), expires_at = now() + interval '7 days'
    where id = inv.id;
    return jsonb_build_object('id', inv.id, 'token', v_token, 'email', inv.email_norm, 'expires_at', now() + interval '7 days');
end;
$$;

create or replace function public.revoke_invitation(p_invitation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    ws uuid;
begin
    select workspace_id into ws from public.workspace_invitations where id = p_invitation;
    if ws is null then
        raise exception 'invitation not found' using errcode = 'P0002';
    end if;
    perform private.require_perm(ws, 'invitations.manage');
    update public.workspace_invitations set revoked_at = now()
    where id = p_invitation and accepted_at is null and revoked_at is null;
end;
$$;

create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    inv public.workspace_invitations;
    me auth.users;
begin
    select * into inv from public.workspace_invitations where token_hash = private.token_hash(p_token) for update;
    if inv.id is null or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at <= now() then
        raise exception 'invitation is invalid or expired' using errcode = '22023';
    end if;
    if not exists (select 1 from public.workspaces where id = inv.workspace_id and deleted_at is null) then
        raise exception 'invitation is invalid or expired' using errcode = '22023';
    end if;
    select * into me from auth.users where id = u;
    if lower(me.email) is distinct from inv.email_norm then
        raise exception 'invitation was sent to another email' using errcode = '42501';
    end if;
    if me.email_confirmed_at is null then
        raise exception 'email is not confirmed' using errcode = '42501';
    end if;
    if exists (select 1 from public.workspace_members where workspace_id = inv.workspace_id and user_id = u and status = 'active') then
        raise exception 'already a member' using errcode = '23505';
    end if;
    insert into public.workspace_members (workspace_id, user_id, role_id, invited_by)
    values (inv.workspace_id, u, inv.role_id, inv.invited_by)
    on conflict (workspace_id, user_id) do update set role_id = excluded.role_id, status = 'active',
        invited_by = excluded.invited_by, joined_at = now(), removed_at = null;
    insert into public.user_profiles (user_id) values (u) on conflict do nothing;
    update public.workspace_invitations set accepted_at = now(), accepted_by = u where id = inv.id;
    return inv.workspace_id;
end;
$$;

create or replace function public.set_member_role(p_workspace uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    mine int;
    theirs int;
    v_role public.roles;
begin
    perform private.require_perm(p_workspace, 'members.manage');
    if p_user = u then
        raise exception 'cannot change your own role' using errcode = '42501';
    end if;
    mine := private.rank_of(p_workspace, u);
    theirs := private.rank_of(p_workspace, p_user);
    if theirs is null then
        raise exception 'not a member' using errcode = 'P0002';
    end if;
    v_role := private.role_for(p_workspace, p_role);
    if v_role.id is null then
        raise exception 'unknown role %', p_role using errcode = '22023';
    end if;
    if v_role.id = private.owner_role_id() then
        raise exception 'owner role is given only by ownership transfer' using errcode = '42501';
    end if;
    if mine < 100 and (theirs >= mine or v_role.rank >= mine) then
        raise exception 'cannot manage a member or assign a role at or above your own' using errcode = '42501';
    end if;
    if theirs = 100 and mine = 100 then
        raise exception 'an owner changes role only by ownership transfer' using errcode = '42501';
    end if;
    update public.workspace_members set role_id = v_role.id where workspace_id = p_workspace and user_id = p_user;
end;
$$;

create or replace function public.remove_member(p_workspace uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    theirs int;
begin
    perform private.require_perm(p_workspace, 'members.manage');
    if p_user = u then
        raise exception 'use leave_workspace to leave' using errcode = '22023';
    end if;
    theirs := private.rank_of(p_workspace, p_user);
    if theirs is null then
        raise exception 'not a member' using errcode = 'P0002';
    end if;
    if theirs >= private.rank_of(p_workspace, u) then
        raise exception 'cannot remove a member at or above your own role' using errcode = '42501';
    end if;
    update public.workspace_members set status = 'removed', removed_at = now()
    where workspace_id = p_workspace and user_id = p_user;
end;
$$;

create or replace function public.transfer_ownership(p_workspace uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
begin
    perform private.require_perm(p_workspace, 'ownership.transfer');
    if (select role_id from public.workspace_members where workspace_id = p_workspace and user_id = u and status = 'active')
       is distinct from private.owner_role_id() then
        raise exception 'only the owner can transfer ownership' using errcode = '42501';
    end if;
    if p_user = u or private.rank_of(p_workspace, p_user) is null then
        raise exception 'target must be another active member' using errcode = '22023';
    end if;
    update public.workspace_members set role_id = private.owner_role_id() where workspace_id = p_workspace and user_id = p_user;
    update public.workspace_members set role_id = (private.role_for(p_workspace, 'admin')).id
    where workspace_id = p_workspace and user_id = u;
end;
$$;

create or replace function public.leave_workspace(p_workspace uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
begin
    if private.rank_of(p_workspace, u) is null then
        raise exception 'not a member' using errcode = 'P0002';
    end if;
    -- Последнего владельца при других участниках не отпускает отложенный триггер workspace_members_owner.
    update public.workspace_members set status = 'left', removed_at = now() where workspace_id = p_workspace and user_id = u;
end;
$$;

create or replace function public.delete_workspace(p_workspace uuid, p_confirm_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.require_perm(p_workspace, 'workspace.delete');
    if (select name from public.workspaces where id = p_workspace) is distinct from btrim(coalesce(p_confirm_name, '')) then
        raise exception 'workspace name does not match' using errcode = '22023';
    end if;
    update public.workspaces set deleted_at = now(), updated_at = now() where id = p_workspace;
end;
$$;

-- Своя роль Workspace: только из разрешений, которые есть у самого, и с рангом ниже своего.
create or replace function public.save_role(p_workspace uuid, p_key text, p_name text, p_rank int, p_permissions text[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    rid uuid;
    p text;
begin
    perform private.require_perm(p_workspace, 'roles.manage');
    if p_key in ('owner', 'admin', 'manager', 'employee', 'viewer') then
        raise exception 'system role keys are reserved' using errcode = '22023';
    end if;
    if p_rank is null or p_rank < 0 or p_rank >= private.rank_of(p_workspace, u) then
        raise exception 'role rank must be below your own' using errcode = '42501';
    end if;
    foreach p in array coalesce(p_permissions, '{}') loop
        if not private.has_perm(p_workspace, p) then
            raise exception 'cannot grant a permission you do not have: %', p using errcode = '42501';
        end if;
    end loop;
    insert into public.roles (workspace_id, key, name, rank) values (p_workspace, p_key, btrim(p_name), p_rank)
    on conflict (workspace_id, key) do update set name = excluded.name, rank = excluded.rank
    returning id into rid;
    delete from public.role_permissions where role_id = rid;
    insert into public.role_permissions (role_id, permission_key) select rid, unnest(coalesce(p_permissions, '{}'));
    return rid;
end;
$$;

revoke all on function public.create_workspace(text), public.ensure_personal_workspace(text),
    public.update_workspace(uuid, text, text), public.my_workspaces(), public.workspace_members_list(uuid),
    public.invite_member(uuid, text, text), public.resend_invitation(uuid), public.revoke_invitation(uuid),
    public.accept_invitation(text), public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid),
    public.transfer_ownership(uuid, uuid), public.leave_workspace(uuid), public.delete_workspace(uuid, text),
    public.save_role(uuid, text, text, int, text[]) from public, anon;
grant execute on function public.create_workspace(text), public.ensure_personal_workspace(text),
    public.update_workspace(uuid, text, text), public.my_workspaces(), public.workspace_members_list(uuid),
    public.invite_member(uuid, text, text), public.resend_invitation(uuid), public.revoke_invitation(uuid),
    public.accept_invitation(text), public.set_member_role(uuid, uuid, text), public.remove_member(uuid, uuid),
    public.transfer_ownership(uuid, uuid), public.leave_workspace(uuid), public.delete_workspace(uuid, text),
    public.save_role(uuid, text, text, int, text[]) to authenticated;
