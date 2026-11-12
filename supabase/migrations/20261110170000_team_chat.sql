-- Корпоративные учётные записи и общение внутри Workspace:
--   * карточки сотрудников (должность, отдел, руководитель, дата прихода в компанию) и фото профиля для коллег;
--   * две системные роли: «Руководитель» и «Глава отдела продаж»;
--   * встроенный чат: личные сообщения и групповые обсуждения, куда участники добавляют друг друга;
--   * уведомления: @упоминания (по имени или адресу почты) в обсуждениях, заметках и комментариях,
--     добавление в обсуждение.
--
-- Миграция только добавляет объекты, повторное применение безопасно. Новых ключей разрешений нет: права
-- выводятся из уже существующих (docs/WORKSPACE_AND_PERMISSIONS.md):
--   личные сообщения и участие в обсуждениях — любой участник Workspace (members.view);
--   создать групповое обсуждение — records.create (все, кроме «Наблюдателя»);
--   добавить участников — владелец/админ обсуждения или любой его участник, если обсуждение это разрешает;
--   менять и удалять участников, название, настройки любого обсуждения — members.manage;
--   менять карточки сотрудников — members.manage, либо invitations.manage для сотрудников ниже по рангу.
-- Supabase Realtime не используется: клиент раз в ~15 с вызывает chat_poll (как touch_presence),
-- поэтому всё работает и на бесплатном тарифе, и на локальном стенде без Realtime.
-- Все таблицы закрыты для прямого доступа: только функции ниже.

-- ------------------------------------------------------------------ роли

insert into public.roles (workspace_id, key, name, rank, is_system) values
    (null, 'head_of_sales', 'Глава отдела продаж', 75, true),
    (null, 'team_lead', 'Руководитель', 70, true)
on conflict (workspace_id, key) do update set name = excluded.name, rank = excluded.rank, is_system = true;

with grants (role_key, perms) as (values
    ('head_of_sales', array['records.view', 'records.create', 'records.edit_own', 'records.edit', 'records.delete',
                            'records.export', 'members.view', 'members.manage', 'invitations.manage',
                            'pipelines.manage', 'fields.manage', 'collections.manage', 'analytics.view',
                            'audit.view']),
    ('team_lead', array['records.view', 'records.create', 'records.edit_own', 'records.edit', 'records.delete',
                        'records.export', 'members.view', 'invitations.manage', 'pipelines.manage',
                        'fields.manage', 'collections.manage', 'analytics.view'])
)
insert into public.role_permissions (role_id, permission_key)
select r.id, p from grants g join public.roles r on r.workspace_id is null and r.key = g.role_key, unnest(g.perms) p
on conflict do nothing;

-- ------------------------------------------------------------------ профиль и карточка сотрудника

-- Фото профиля для коллег: маленький data-URL (на устройстве он не больше 60 КБ).
alter table public.user_profiles add column if not exists avatar_data text
    check (avatar_data is null or (char_length(avatar_data) <= 90000
                                   and avatar_data ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'));

create table if not exists public.member_profiles (
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    title text not null default '' check (char_length(title) <= 120),
    department text not null default '' check (char_length(department) <= 120),
    manager_id uuid references auth.users (id) on delete set null,
    hired_on date check (hired_on is null or hired_on between date '1950-01-01' and date '2100-01-01'),
    updated_by uuid references auth.users (id) on delete set null,
    updated_at timestamptz not null default now(),
    primary key (workspace_id, user_id),
    check (manager_id is null or manager_id <> user_id)
);
create index if not exists member_profiles_manager on public.member_profiles (workspace_id, manager_id);
alter table public.member_profiles enable row level security;
alter table public.member_profiles force row level security;
revoke all on public.member_profiles from anon, public, authenticated;

-- Имя для показа: из профиля или начало адреса почты.
create or replace function private.display_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce(nullif(btrim(p.display_name), ''), split_part(u.email, '@', 1), 'Участник')
    from auth.users u left join public.user_profiles p on p.user_id = u.id
    where u.id = p_user;
$$;

-- Может ли текущий пользователь менять карточку сотрудника.
create or replace function private.can_edit_member(p_workspace uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select private.rank_of(p_workspace, p_user) is not null and (
        (private.has_perm(p_workspace, 'members.manage')
            and (p_user = (select auth.uid())
                 or private.rank_of(p_workspace, p_user) < private.rank_of(p_workspace, (select auth.uid()))))
        or (private.has_perm(p_workspace, 'invitations.manage')
            and private.rank_of(p_workspace, p_user) < private.rank_of(p_workspace, (select auth.uid())))
    );
$$;

-- Справочник сотрудников: участники с карточками, фото, почтой и статусом «в сети».
-- Почта видна всем участникам: это корпоративный справочник, по почте коллег упоминают в обсуждениях.
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

-- Карточка сотрудника: пустая строка очищает поле, null оставляет как есть (кроме руководителя и даты:
-- для них очистка — p_clear_manager / p_clear_hired). Руководитель — участник того же Workspace, без циклов.
create or replace function public.update_member_profile(
    p_workspace uuid, p_user uuid, p_title text default null, p_department text default null,
    p_manager uuid default null, p_hired_on date default null,
    p_clear_manager boolean default false, p_clear_hired boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    cur public.member_profiles;
    v_manager uuid;
    walker uuid;
    steps int := 0;
begin
    perform private.require_perm(p_workspace, 'members.view');
    if private.rank_of(p_workspace, p_user) is null then
        raise exception 'not a member' using errcode = 'P0002';
    end if;
    if not private.can_edit_member(p_workspace, p_user) then
        raise exception 'permission denied: member profile' using errcode = '42501';
    end if;
    if char_length(btrim(coalesce(p_title, ''))) > 120 or char_length(btrim(coalesce(p_department, ''))) > 120 then
        raise exception 'title and department are up to 120 characters' using errcode = '22023';
    end if;
    select * into cur from public.member_profiles where workspace_id = p_workspace and user_id = p_user;
    v_manager := case when p_clear_manager then null else coalesce(p_manager, cur.manager_id) end;
    if v_manager is not null then
        if v_manager = p_user then
            raise exception 'a member cannot be their own manager' using errcode = '22023';
        end if;
        if private.rank_of(p_workspace, v_manager) is null then
            raise exception 'manager must be an active member' using errcode = '22023';
        end if;
        -- Цикл: поднимаемся от нового руководителя вверх; встретили сотрудника — цикл.
        walker := v_manager;
        while walker is not null and steps < 200 loop
            if walker = p_user then
                raise exception 'manager chain would form a cycle' using errcode = '22023';
            end if;
            select manager_id into walker from public.member_profiles where workspace_id = p_workspace and user_id = walker;
            steps := steps + 1;
        end loop;
    end if;
    insert into public.member_profiles as mp (workspace_id, user_id, title, department, manager_id, hired_on, updated_by, updated_at)
    values (p_workspace, p_user, btrim(coalesce(p_title, '')), btrim(coalesce(p_department, '')), v_manager,
            case when p_clear_hired then null else p_hired_on end, u, now())
    on conflict (workspace_id, user_id) do update set
        title = coalesce(btrim(p_title), mp.title),
        department = coalesce(btrim(p_department), mp.department),
        manager_id = v_manager,
        hired_on = case when p_clear_hired then null else coalesce(p_hired_on, mp.hired_on) end,
        updated_by = u, updated_at = now();
    return (select x from jsonb_array_elements(public.team_directory(p_workspace)) x where x ->> 'user_id' = p_user::text);
end;
$$;

-- ------------------------------------------------------------------ чат

create table if not exists public.chat_conversations (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    kind text not null check (kind in ('direct', 'group')),
    title text check (title is null or char_length(btrim(title)) between 1 and 120),
    -- Личный диалог: «меньший uuid:больший uuid» — один диалог на пару в Workspace.
    direct_key text,
    members_can_add boolean not null default true,
    created_by uuid references auth.users (id) on delete set null,
    created_at timestamptz not null default now(),
    last_message_at timestamptz,
    check ((kind = 'direct') = (direct_key is not null)),
    check (kind = 'direct' or title is not null)
);
create unique index if not exists chat_direct_once on public.chat_conversations (workspace_id, direct_key)
    where direct_key is not null;
create index if not exists chat_conversations_ws on public.chat_conversations (workspace_id);

create table if not exists public.chat_participants (
    conversation_id uuid not null references public.chat_conversations (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    role text not null default 'member' check (role in ('owner', 'admin', 'member')),
    added_by uuid references auth.users (id) on delete set null,
    joined_at timestamptz not null default now(),
    last_read_seq bigint not null default 0,
    muted boolean not null default false,
    primary key (conversation_id, user_id)
);
create index if not exists chat_participants_user on public.chat_participants (user_id);

create sequence if not exists public.chat_seq;

create table if not exists public.chat_messages (
    id uuid primary key default gen_random_uuid(),
    seq bigint not null default nextval('public.chat_seq') unique,
    conversation_id uuid not null references public.chat_conversations (id) on delete cascade,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    author_id uuid references auth.users (id) on delete set null,
    kind text not null default 'text' check (kind in ('text', 'system')),
    body text not null check (char_length(body) between 1 and 4000),
    mentions uuid[] not null default '{}',
    created_at timestamptz not null default now(),
    edited_at timestamptz,
    deleted_at timestamptz
);
create index if not exists chat_messages_conversation on public.chat_messages (conversation_id, seq);
create index if not exists chat_messages_author_time on public.chat_messages (author_id, created_at);

create table if not exists public.notifications (
    id uuid primary key default gen_random_uuid(),
    seq bigint not null default nextval('public.chat_seq'),
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    kind text not null check (kind in ('mention', 'added_to_group', 'note_mention', 'comment_mention')),
    actor_id uuid references auth.users (id) on delete set null,
    conversation_id uuid references public.chat_conversations (id) on delete cascade,
    message_id uuid references public.chat_messages (id) on delete cascade,
    entity_type text,
    entity_id uuid,
    excerpt text not null default '' check (char_length(excerpt) <= 300),
    created_at timestamptz not null default now(),
    read_at timestamptz
);
create index if not exists notifications_user on public.notifications (user_id, workspace_id, seq);

alter table public.chat_conversations enable row level security;
alter table public.chat_participants enable row level security;
alter table public.chat_messages enable row level security;
alter table public.notifications enable row level security;
alter table public.chat_conversations force row level security;
alter table public.chat_participants force row level security;
alter table public.chat_messages force row level security;
alter table public.notifications force row level security;
revoke all on public.chat_conversations, public.chat_participants, public.chat_messages, public.notifications
    from anon, public, authenticated;
revoke all on sequence public.chat_seq from anon, public, authenticated;

-- Кого упомянули в тексте: «@Имя» (как в профиле) или адрес почты участника. Только активные участники.
create or replace function private.mentioned_users(p_workspace uuid, p_text text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
    with t as (select lower(coalesce(p_text, '')) as body)
    select coalesce(array_agg(distinct m.user_id), '{}')
    from public.workspace_members m
    join auth.users u on u.id = m.user_id
    left join public.user_profiles p on p.user_id = m.user_id
    cross join t
    where m.workspace_id = p_workspace and m.status = 'active' and t.body <> '' and (
        (u.email is not null and t.body ~ ('(^|[^a-z0-9._%+-])'
            || regexp_replace(lower(u.email), '([.+*?^$(){}|\[\]\\-])', '\\\1', 'g') || '($|[^a-z0-9_-])'))
        or (char_length(btrim(coalesce(p.display_name, ''))) >= 2 and t.body ~ ('@'
            || regexp_replace(lower(btrim(p.display_name)), '([.+*?^$(){}|\[\]\\-])', '\\\1', 'g') || '($|[^[:alnum:]_])'))
    );
$$;

-- Обсуждение, в котором участвует текущий пользователь (и он всё ещё участник Workspace).
create or replace function private.chat_require(p_conversation uuid)
returns public.chat_conversations
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    c public.chat_conversations;
begin
    select * into c from public.chat_conversations where id = p_conversation;
    if c.id is null or not exists (select 1 from public.chat_participants
                                   where conversation_id = c.id and user_id = private.uid()) then
        raise exception 'conversation not found' using errcode = 'P0002';
    end if;
    perform private.require_perm(c.workspace_id, 'members.view');
    return c;
end;
$$;

create or replace function private.chat_role(p_conversation uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
    select role from public.chat_participants where conversation_id = p_conversation and user_id = p_user;
$$;

-- Служебное сообщение в ленте обсуждения («добавил(а) …», «переименовал(а) …»).
create or replace function private.chat_system(p_conversation uuid, p_text text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    c public.chat_conversations;
begin
    select * into c from public.chat_conversations where id = p_conversation;
    insert into public.chat_messages (conversation_id, workspace_id, author_id, kind, body)
    values (c.id, c.workspace_id, (select auth.uid()), 'system', left(p_text, 4000));
    update public.chat_conversations set last_message_at = now() where id = c.id;
end;
$$;

-- Описание обсуждения для списка и шапки: участники, моя роль, последнее сообщение, непрочитанные.
create or replace function private.chat_view(p_conversation uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    select jsonb_build_object(
        'id', c.id, 'kind', c.kind, 'title', c.title, 'members_can_add', c.members_can_add,
        'created_by', c.created_by, 'created_at', c.created_at,
        'last_message_at', coalesce(c.last_message_at, c.created_at),
        'my_role', me.role, 'muted', me.muted, 'last_read_seq', me.last_read_seq,
        'participants', (select coalesce(jsonb_agg(jsonb_build_object(
                             'user_id', pp.user_id, 'role', pp.role,
                             'active', private.rank_of(c.workspace_id, pp.user_id) is not null
                         ) order by pp.joined_at), '[]'::jsonb)
                         from public.chat_participants pp where pp.conversation_id = c.id),
        'last', (select jsonb_build_object('seq', x.seq, 'author_id', x.author_id, 'kind', x.kind,
                                           'body', case when x.deleted_at is null then left(x.body, 200) else '' end,
                                           'deleted', x.deleted_at is not null, 'created_at', x.created_at)
                 from public.chat_messages x where x.conversation_id = c.id order by x.seq desc limit 1),
        'unread', (select count(*) from public.chat_messages x
                   where x.conversation_id = c.id and x.seq > me.last_read_seq and x.deleted_at is null
                     and x.author_id is distinct from me.user_id)
    )
    from public.chat_conversations c
    join public.chat_participants me on me.conversation_id = c.id and me.user_id = (select auth.uid())
    where c.id = p_conversation;
$$;

create or replace function public.chat_list(p_workspace uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
begin
    perform private.require_perm(p_workspace, 'members.view');
    return (
        select coalesce(jsonb_agg(private.chat_view(c.id) order by coalesce(c.last_message_at, c.created_at) desc), '[]'::jsonb)
        from public.chat_conversations c
        join public.chat_participants me on me.conversation_id = c.id and me.user_id = u
        where c.workspace_id = p_workspace
    );
end;
$$;

-- Личный диалог с участником: открывает существующий или создаёт новый.
create or replace function public.chat_open_direct(p_workspace uuid, p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    k text;
    cid uuid;
begin
    perform private.require_perm(p_workspace, 'members.view');
    if p_user is null or p_user = u or private.rank_of(p_workspace, p_user) is null then
        raise exception 'recipient must be another active member' using errcode = '22023';
    end if;
    k := least(u::text, p_user::text) || ':' || greatest(u::text, p_user::text);
    insert into public.chat_conversations (workspace_id, kind, direct_key, created_by)
    values (p_workspace, 'direct', k, u) on conflict (workspace_id, direct_key) where direct_key is not null do nothing;
    select id into cid from public.chat_conversations where workspace_id = p_workspace and direct_key = k;
    insert into public.chat_participants (conversation_id, user_id, role, added_by)
    values (cid, u, 'member', u), (cid, p_user, 'member', u) on conflict do nothing;
    return private.chat_view(cid);
end;
$$;

create or replace function public.chat_create_group(p_workspace uuid, p_title text, p_members uuid[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    cid uuid;
    others uuid[];
begin
    perform private.require_perm(p_workspace, 'records.create');
    if char_length(btrim(coalesce(p_title, ''))) not between 1 and 120 then
        raise exception 'title is 1 to 120 characters' using errcode = '22023';
    end if;
    select coalesce(array_agg(distinct x), '{}') into others from unnest(coalesce(p_members, '{}')) x where x <> u;
    if cardinality(others) > 199 then
        raise exception 'too many participants (max 200)' using errcode = '54000';
    end if;
    if exists (select 1 from unnest(others) x where private.rank_of(p_workspace, x) is null) then
        raise exception 'participants must be active members' using errcode = '22023';
    end if;
    if (select count(*) from public.chat_conversations
        where created_by = u and kind = 'group' and created_at > now() - interval '1 hour') >= 30 then
        raise exception 'too many new discussions, try later' using errcode = '54000';
    end if;
    insert into public.chat_conversations (workspace_id, kind, title, created_by)
    values (p_workspace, 'group', btrim(p_title), u) returning id into cid;
    insert into public.chat_participants (conversation_id, user_id, role, added_by) values (cid, u, 'owner', u);
    insert into public.chat_participants (conversation_id, user_id, role, added_by) select cid, x, 'member', u from unnest(others) x;
    perform private.chat_system(cid, private.display_name(u) || ' создаёт обсуждение «' || btrim(p_title) || '»');
    insert into public.notifications (workspace_id, user_id, kind, actor_id, conversation_id, excerpt)
    select p_workspace, x, 'added_to_group', u, cid, left(btrim(p_title), 300) from unnest(others) x;
    return private.chat_view(cid);
end;
$$;

create or replace function public.chat_add_members(p_conversation uuid, p_users uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    c public.chat_conversations := private.chat_require(p_conversation);
    fresh uuid[];
begin
    if c.kind <> 'group' then
        raise exception 'participants are added only to group discussions' using errcode = '22023';
    end if;
    if not (private.chat_role(c.id, u) in ('owner', 'admin') or c.members_can_add
            or private.has_perm(c.workspace_id, 'members.manage')) then
        raise exception 'permission denied: add participants' using errcode = '42501';
    end if;
    select coalesce(array_agg(distinct x), '{}') into fresh from unnest(coalesce(p_users, '{}')) x
    where not exists (select 1 from public.chat_participants where conversation_id = c.id and user_id = x);
    if exists (select 1 from unnest(fresh) x where private.rank_of(c.workspace_id, x) is null) then
        raise exception 'participants must be active members' using errcode = '22023';
    end if;
    if (select count(*) from public.chat_participants where conversation_id = c.id) + cardinality(fresh) > 200 then
        raise exception 'too many participants (max 200)' using errcode = '54000';
    end if;
    if cardinality(fresh) = 0 then
        return private.chat_view(c.id);
    end if;
    insert into public.chat_participants (conversation_id, user_id, role, added_by) select c.id, x, 'member', u from unnest(fresh) x;
    perform private.chat_system(c.id, private.display_name(u) || ' добавляет: '
        || (select string_agg(private.display_name(x), ', ') from unnest(fresh) x));
    insert into public.notifications (workspace_id, user_id, kind, actor_id, conversation_id, excerpt)
    select c.workspace_id, x, 'added_to_group', u, c.id, left(c.title, 300) from unnest(fresh) x;
    return private.chat_view(c.id);
end;
$$;

-- Удалить участника (или выйти самому, p_user = себя). Владелец уходит — владельцем становится самый давний админ
-- или участник; ушёл последний — обсуждение удаляется.
create or replace function public.chat_remove_member(p_conversation uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    c public.chat_conversations := private.chat_require(p_conversation);
    mine text := private.chat_role(c.id, u);
    theirs text := private.chat_role(c.id, p_user);
    heir uuid;
begin
    if c.kind <> 'group' then
        raise exception 'personal conversations have no participants to remove' using errcode = '22023';
    end if;
    if theirs is null then
        raise exception 'not a participant' using errcode = 'P0002';
    end if;
    if p_user <> u and not (
        (mine = 'owner')
        or (mine = 'admin' and theirs = 'member')
        or (private.has_perm(c.workspace_id, 'members.manage') and theirs <> 'owner')
    ) then
        raise exception 'permission denied: remove participant' using errcode = '42501';
    end if;
    delete from public.chat_participants where conversation_id = c.id and user_id = p_user;
    if not exists (select 1 from public.chat_participants where conversation_id = c.id) then
        delete from public.chat_conversations where id = c.id;
        return;
    end if;
    if theirs = 'owner' then
        select user_id into heir from public.chat_participants where conversation_id = c.id
        order by (role = 'admin') desc, joined_at limit 1;
        update public.chat_participants set role = 'owner' where conversation_id = c.id and user_id = heir;
    end if;
    perform private.chat_system(c.id, case when p_user = u then private.display_name(u) || ' выходит из обсуждения'
                                      else private.display_name(u) || ' удаляет из обсуждения: ' || private.display_name(p_user) end);
end;
$$;

create or replace function public.chat_update(p_conversation uuid, p_title text default null, p_members_can_add boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    c public.chat_conversations := private.chat_require(p_conversation);
begin
    if c.kind <> 'group' then
        raise exception 'only group discussions have settings' using errcode = '22023';
    end if;
    if not (private.chat_role(c.id, u) in ('owner', 'admin') or private.has_perm(c.workspace_id, 'members.manage')) then
        raise exception 'permission denied: discussion settings' using errcode = '42501';
    end if;
    if p_title is not null and char_length(btrim(p_title)) not between 1 and 120 then
        raise exception 'title is 1 to 120 characters' using errcode = '22023';
    end if;
    update public.chat_conversations set title = coalesce(btrim(p_title), title),
        members_can_add = coalesce(p_members_can_add, members_can_add) where id = c.id;
    if p_title is not null and btrim(p_title) <> c.title then
        perform private.chat_system(c.id, private.display_name(u) || ' переименовывает обсуждение в «' || btrim(p_title) || '»');
    end if;
    return private.chat_view(c.id);
end;
$$;

-- Роль в обсуждении (admin / member) назначает владелец обсуждения или members.manage.
create or replace function public.chat_set_role(p_conversation uuid, p_user uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    c public.chat_conversations := private.chat_require(p_conversation);
begin
    if p_role not in ('admin', 'member') then
        raise exception 'role is admin or member' using errcode = '22023';
    end if;
    if not (private.chat_role(c.id, u) = 'owner' or private.has_perm(c.workspace_id, 'members.manage')) then
        raise exception 'permission denied: discussion roles' using errcode = '42501';
    end if;
    if private.chat_role(c.id, p_user) is null or private.chat_role(c.id, p_user) = 'owner' then
        raise exception 'target must be a participant who is not the owner' using errcode = '22023';
    end if;
    update public.chat_participants set role = p_role where conversation_id = c.id and user_id = p_user;
    return private.chat_view(c.id);
end;
$$;

create or replace function public.chat_set_muted(p_conversation uuid, p_muted boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    c public.chat_conversations := private.chat_require(p_conversation);
begin
    update public.chat_participants set muted = coalesce(p_muted, false) where conversation_id = c.id and user_id = private.uid();
    return private.chat_view(c.id);
end;
$$;

-- Лента: до p_limit сообщений до p_before (вверх по истории) или после p_after (новые), по возрастанию seq.
-- p_mark_read отмечает прочитанным всё до последнего полученного сообщения.
create or replace function public.chat_messages(p_conversation uuid, p_before bigint default null, p_after bigint default null,
                                                p_limit int default 50, p_mark_read boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    c public.chat_conversations := private.chat_require(p_conversation);
    lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
    v_rows jsonb;
    v_top bigint;
begin
    select coalesce(jsonb_agg(x order by (x ->> 'seq')::bigint), '[]'::jsonb) into v_rows from (
        select jsonb_build_object('id', m.id, 'seq', m.seq, 'author_id', m.author_id, 'kind', m.kind,
                                  'body', case when m.deleted_at is null then m.body else '' end,
                                  'mentions', m.mentions, 'created_at', m.created_at, 'edited_at', m.edited_at,
                                  'deleted', m.deleted_at is not null) as x
        from public.chat_messages m
        where m.conversation_id = c.id
          and (p_before is null or m.seq < p_before)
          and (p_after is null or m.seq > p_after)
        order by case when p_after is null then -m.seq else m.seq end
        limit lim
    ) s;
    if p_mark_read then
        select max(seq) into v_top from public.chat_messages where conversation_id = c.id;
        update public.chat_participants set last_read_seq = greatest(last_read_seq, coalesce(v_top, 0))
        where conversation_id = c.id and user_id = private.uid();
        update public.notifications set read_at = now()
        where user_id = private.uid() and conversation_id = c.id and read_at is null;
    end if;
    return jsonb_build_object('conversation', private.chat_view(c.id), 'messages', v_rows);
end;
$$;

create or replace function public.chat_send(p_conversation uuid, p_body text, p_mentions uuid[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    c public.chat_conversations := private.chat_require(p_conversation);
    v_body text := btrim(coalesce(p_body, ''));
    v_mentions uuid[];
    msg public.chat_messages;
begin
    if char_length(v_body) not between 1 and 4000 then
        raise exception 'message is 1 to 4000 characters' using errcode = '22023';
    end if;
    if c.kind = 'direct' and exists (select 1 from public.chat_participants p where p.conversation_id = c.id
                                     and private.rank_of(c.workspace_id, p.user_id) is null) then
        raise exception 'recipient is no longer a member' using errcode = '42501';
    end if;
    if (select count(*) from public.chat_messages where author_id = u and created_at > now() - interval '1 minute') >= 30 then
        raise exception 'too many messages, wait a minute' using errcode = '54000';
    end if;
    -- Упомянутые: выбранные в подсказке и найденные в тексте, только участники обсуждения, без себя.
    select coalesce(array_agg(distinct x), '{}') into v_mentions
    from unnest(coalesce(p_mentions, '{}') || private.mentioned_users(c.workspace_id, v_body)) x
    where x <> u and exists (select 1 from public.chat_participants where conversation_id = c.id and user_id = x);
    insert into public.chat_messages (conversation_id, workspace_id, author_id, kind, body, mentions)
    values (c.id, c.workspace_id, u, 'text', v_body, v_mentions) returning * into msg;
    update public.chat_conversations set last_message_at = msg.created_at where id = c.id;
    update public.chat_participants set last_read_seq = greatest(last_read_seq, msg.seq) where conversation_id = c.id and user_id = u;
    if c.kind = 'group' then
        insert into public.notifications (workspace_id, user_id, kind, actor_id, conversation_id, message_id, excerpt)
        select c.workspace_id, x, 'mention', u, c.id, msg.id, left(v_body, 300) from unnest(v_mentions) x;
    end if;
    return jsonb_build_object('id', msg.id, 'seq', msg.seq, 'author_id', msg.author_id, 'kind', msg.kind, 'body', msg.body,
                              'mentions', msg.mentions, 'created_at', msg.created_at, 'edited_at', null, 'deleted', false);
end;
$$;

-- Изменить своё сообщение (новых уведомлений не создаёт).
create or replace function public.chat_edit(p_message uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    m public.chat_messages;
    v_body text := btrim(coalesce(p_body, ''));
begin
    select * into m from public.chat_messages where id = p_message;
    if m.id is null then
        raise exception 'message not found' using errcode = 'P0002';
    end if;
    perform private.chat_require(m.conversation_id);
    if m.author_id is distinct from u or m.kind <> 'text' or m.deleted_at is not null then
        raise exception 'only the author edits a message' using errcode = '42501';
    end if;
    if char_length(v_body) not between 1 and 4000 then
        raise exception 'message is 1 to 4000 characters' using errcode = '22023';
    end if;
    update public.chat_messages set body = v_body, edited_at = now() where id = m.id returning * into m;
    return jsonb_build_object('id', m.id, 'seq', m.seq, 'author_id', m.author_id, 'kind', m.kind, 'body', m.body,
                              'mentions', m.mentions, 'created_at', m.created_at, 'edited_at', m.edited_at, 'deleted', false);
end;
$$;

-- Удалить сообщение: автор, владелец/админ обсуждения или members.manage. Текст стирается.
create or replace function public.chat_delete(p_message uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    m public.chat_messages;
    c public.chat_conversations;
begin
    select * into m from public.chat_messages where id = p_message;
    if m.id is null then
        raise exception 'message not found' using errcode = 'P0002';
    end if;
    c := private.chat_require(m.conversation_id);
    if m.kind <> 'text' then
        raise exception 'system messages are not deleted' using errcode = '22023';
    end if;
    if not (m.author_id = u or private.chat_role(c.id, u) in ('owner', 'admin')
            or private.has_perm(c.workspace_id, 'members.manage')) then
        raise exception 'permission denied: delete message' using errcode = '42501';
    end if;
    update public.chat_messages set body = '—', mentions = '{}', deleted_at = coalesce(deleted_at, now()) where id = m.id;
    delete from public.notifications where message_id = m.id;
end;
$$;

-- Опрос раз в ~15 с: «я в сети», непрочитанное по обсуждениям, новые сообщения после курсора (для уведомлений)
-- и непрочитанные уведомления. Первый вызов (p_since = null) только возвращает курсор, без «новых».
create or replace function public.chat_poll(p_workspace uuid, p_since bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    cursor_seq bigint;
begin
    perform private.require_perm(p_workspace, 'members.view');
    insert into public.workspace_presence (workspace_id, user_id, seen_at) values (p_workspace, u, now())
    on conflict (workspace_id, user_id) do update set seen_at = excluded.seen_at;
    delete from public.notifications where user_id = u and workspace_id = p_workspace and created_at < now() - interval '90 days';
    select greatest(
        coalesce((select max(m.seq) from public.chat_messages m
                  join public.chat_participants p on p.conversation_id = m.conversation_id and p.user_id = u
                  where m.workspace_id = p_workspace), 0),
        coalesce((select max(n.seq) from public.notifications n where n.user_id = u and n.workspace_id = p_workspace), 0),
        coalesce(p_since, 0)) into cursor_seq;
    return jsonb_build_object(
        'cursor', cursor_seq,
        'unread', (select coalesce(jsonb_object_agg(v.id, v.n), '{}'::jsonb) from (
            select c.id, count(*) as n from public.chat_conversations c
            join public.chat_participants p on p.conversation_id = c.id and p.user_id = u
            join public.chat_messages m on m.conversation_id = c.id and m.seq > p.last_read_seq
                 and m.deleted_at is null and m.author_id is distinct from u
            where c.workspace_id = p_workspace group by c.id) v),
        'fresh', case when p_since is null then '[]'::jsonb else (
            select coalesce(jsonb_agg(f order by (f ->> 'seq')::bigint), '[]'::jsonb) from (
                select jsonb_build_object('seq', m.seq, 'conversation_id', m.conversation_id, 'kind', c.kind,
                                          'title', c.title, 'author_id', m.author_id,
                                          'author_name', private.display_name(m.author_id),
                                          'body', left(m.body, 200), 'mentioned', u = any(m.mentions)) as f
                from public.chat_messages m
                join public.chat_conversations c on c.id = m.conversation_id
                join public.chat_participants p on p.conversation_id = m.conversation_id and p.user_id = u
                where m.workspace_id = p_workspace and m.seq > p_since and m.kind = 'text' and m.deleted_at is null
                  and m.author_id is distinct from u and (not p.muted or u = any(m.mentions))
                order by m.seq desc limit 20) s) end,
        'notifications', (select coalesce(jsonb_agg(x order by (x ->> 'seq')::bigint desc), '[]'::jsonb) from (
            select jsonb_build_object('id', n.id, 'seq', n.seq, 'kind', n.kind, 'actor_id', n.actor_id,
                                      'actor_name', private.display_name(n.actor_id),
                                      'conversation_id', n.conversation_id, 'message_id', n.message_id,
                                      'entity_type', n.entity_type, 'entity_id', n.entity_id, 'excerpt', n.excerpt,
                                      'created_at', n.created_at, 'read', n.read_at is not null) as x
            from public.notifications n where n.user_id = u and n.workspace_id = p_workspace
            order by n.seq desc limit 50) s)
    );
end;
$$;

-- Отметить уведомления прочитанными: перечисленные или (null) все в Workspace.
create or replace function public.notifications_mark_read(p_workspace uuid, p_ids uuid[] default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
    n int;
begin
    perform private.require_perm(p_workspace, 'members.view');
    update public.notifications set read_at = now()
    where user_id = private.uid() and workspace_id = p_workspace and read_at is null
      and (p_ids is null or id = any(p_ids));
    get diagnostics n = row_count;
    return n;
end;
$$;

-- ------------------------------------------------------------------ упоминания в заметках и комментариях

-- Новые упоминания в тексте заметки или комментария: уведомление каждому упомянутому (кроме автора правки).
-- При правке уведомляются только те, кого в старом тексте не было.
create or replace function private.notify_record_mentions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    actor uuid := coalesce(new.updated_by, new.created_by);
    before uuid[] := '{}';
begin
    if new.deleted_at is not null then
        return null;
    end if;
    if tg_op = 'UPDATE' then
        before := private.mentioned_users(old.workspace_id, old.body);
    end if;
    insert into public.notifications (workspace_id, user_id, kind, actor_id, entity_type, entity_id, excerpt)
    select new.workspace_id, x, case when tg_table_name = 'notes' then 'note_mention' else 'comment_mention' end,
           actor, new.entity_type, new.entity_id, left(new.body, 300)
    from unnest(private.mentioned_users(new.workspace_id, new.body)) x
    where x <> all(before) and x is distinct from actor;
    return null;
end;
$$;

create or replace trigger notes_mentions after insert or update of body on public.notes
    for each row execute function private.notify_record_mentions();
create or replace trigger comments_mentions after insert or update of body on public.comments
    for each row execute function private.notify_record_mentions();

-- ------------------------------------------------------------------ права на функции

revoke all on function private.display_name(uuid), private.can_edit_member(uuid, uuid), private.mentioned_users(uuid, text),
    private.chat_require(uuid), private.chat_role(uuid, uuid), private.chat_system(uuid, text), private.chat_view(uuid),
    private.notify_record_mentions() from public, anon;

revoke all on function public.team_directory(uuid),
    public.update_member_profile(uuid, uuid, text, text, uuid, date, boolean, boolean),
    public.chat_list(uuid), public.chat_open_direct(uuid, uuid), public.chat_create_group(uuid, text, uuid[]),
    public.chat_add_members(uuid, uuid[]), public.chat_remove_member(uuid, uuid), public.chat_update(uuid, text, boolean),
    public.chat_set_role(uuid, uuid, text), public.chat_set_muted(uuid, boolean),
    public.chat_messages(uuid, bigint, bigint, int, boolean), public.chat_send(uuid, text, uuid[]),
    public.chat_edit(uuid, text), public.chat_delete(uuid), public.chat_poll(uuid, bigint),
    public.notifications_mark_read(uuid, uuid[]) from public, anon;
grant execute on function public.team_directory(uuid),
    public.update_member_profile(uuid, uuid, text, text, uuid, date, boolean, boolean),
    public.chat_list(uuid), public.chat_open_direct(uuid, uuid), public.chat_create_group(uuid, text, uuid[]),
    public.chat_add_members(uuid, uuid[]), public.chat_remove_member(uuid, uuid), public.chat_update(uuid, text, boolean),
    public.chat_set_role(uuid, uuid, text), public.chat_set_muted(uuid, boolean),
    public.chat_messages(uuid, bigint, bigint, int, boolean), public.chat_send(uuid, text, uuid[]),
    public.chat_edit(uuid, text), public.chat_delete(uuid), public.chat_poll(uuid, bigint),
    public.notifications_mark_read(uuid, uuid[]) to authenticated;
