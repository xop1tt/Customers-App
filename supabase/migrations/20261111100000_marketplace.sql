-- Маркетплейс интеграций.
--
-- Интеграция описывается манифестом (без чужого кода в приложении):
--   actions  — кнопки в карточках CRM, открывающие страницу разработчика со ссылкой на запись;
--   webhooks — события CRM, которые сервер отправляет на HTTPS-адрес разработчика с подписью HMAC-SHA256;
--   scopes   — что интеграция получает: без «crm.read» в событиях только идентификаторы, с ним — поля записи;
--   window   — зарезервировано для будущих веб-плагинов (окно в песочнице), сейчас не используется.
--
-- Публикация: разработчик подаёт интеграцию из приложения, каждая версия ждёт проверки. В каталоге видна
-- только одобренная модератором версия. Модераторы — private.platform_admins (добавляет владелец проекта
-- Supabase вручную). Установка в Workspace — право workspace.manage; установленная версия не меняется сама:
-- новые права интеграции владелец Workspace подтверждает обновлением.
--
-- Отправка событий — через pg_net (на Supabase включается в Database → Extensions), подпись — pgcrypto.
-- Без них (локальный стенд, CI) каталог и установка работают, события просто не отправляются.

do $$
begin
    create extension if not exists pg_net with schema extensions;
exception when others then
    null; -- нет pg_net на этом сервере: события не отправляются, остальное работает
end;
$$;

-- ------------------------------------------------------------------ таблицы

create table if not exists private.platform_admins (
    user_id uuid primary key references auth.users (id) on delete cascade,
    added_at timestamptz not null default now()
);
revoke all on private.platform_admins from public, anon, authenticated;

create table if not exists public.market_apps (
    id uuid primary key default gen_random_uuid(),
    slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
    developer_id uuid not null references auth.users (id) on delete cascade,
    developer_name text not null check (char_length(btrim(developer_name)) between 1 and 120),
    name text not null check (char_length(btrim(name)) between 1 and 60),
    tagline text not null default '' check (char_length(tagline) <= 140),
    description text not null default '' check (char_length(description) <= 5000),
    category text not null default 'other'
        check (category in ('crm', 'telephony', 'messaging', 'email', 'documents', 'analytics', 'marketing', 'other')),
    -- Только эмодзи: никаких картинок с чужих адресов в приложении.
    icon text not null default '🧩' check (char_length(icon) between 1 and 8 and icon !~ '[<>"''/\\:]'),
    website text check (website is null or (website ~ '^https://[^\s<>"]{3,}$' and char_length(website) <= 300)),
    support_email text check (support_email is null or support_email ~ '^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$'),
    status text not null default 'draft' check (status in ('draft', 'listed', 'suspended')),
    status_note text check (char_length(status_note) <= 1000),
    live_version_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.market_versions (
    id uuid primary key default gen_random_uuid(),
    app_id uuid not null references public.market_apps (id) on delete cascade,
    version text not null check (version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$'),
    manifest jsonb not null,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'superseded')),
    review_note text check (char_length(review_note) <= 1000),
    reviewed_by uuid references auth.users (id) on delete set null,
    reviewed_at timestamptz,
    created_at timestamptz not null default now(),
    unique (app_id, version)
);
create index if not exists market_versions_pending on public.market_versions (created_at) where status = 'pending';

do $$
begin
    alter table public.market_apps add constraint market_apps_live_version
        foreign key (live_version_id) references public.market_versions (id) on delete set null;
exception when duplicate_object then
    null;
end;
$$;

create table if not exists public.market_installs (
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    app_id uuid not null references public.market_apps (id) on delete cascade,
    version_id uuid not null references public.market_versions (id),
    installed_by uuid references auth.users (id) on delete set null,
    installed_at timestamptz not null default now(),
    enabled boolean not null default true,
    -- Секрет подписи событий: разработчик получает его в событии app.installed.
    secret text not null,
    primary key (workspace_id, app_id)
);

create table if not exists private.market_deliveries (
    id bigserial primary key,
    workspace_id uuid not null,
    app_id uuid not null,
    event text not null,
    request_id bigint,
    created_at timestamptz not null default now()
);
create index if not exists market_deliveries_app_time on private.market_deliveries (app_id, created_at);
revoke all on private.market_deliveries from public, anon, authenticated;

alter table public.market_apps enable row level security;
alter table public.market_versions enable row level security;
alter table public.market_installs enable row level security;
alter table public.market_apps force row level security;
alter table public.market_versions force row level security;
alter table public.market_installs force row level security;
revoke all on public.market_apps, public.market_versions, public.market_installs from anon, public, authenticated;

-- ------------------------------------------------------------------ проверки

create or replace function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from private.platform_admins where user_id = (select auth.uid()));
$$;

create or replace function private.market_url_ok(p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $$
    -- Только https и публичные адреса: не localhost, не IP-адреса (защита от запросов во внутреннюю сеть).
    select p_url ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{2,5})?(/[^\s<>"]*)?$'
       and p_url !~* '^https://(localhost|[0-9.]+|[^/]*\.local|[^/]*\.internal)([:/]|$)'
       and char_length(p_url) <= 500;
$$;

-- Манифест → проверенный и приведённый к одному виду. Ошибки — понятным текстом для разработчика.
create or replace function private.market_manifest(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
    known_scopes text[] := array['crm.read'];
    known_events text[] := array['record.created', 'record.updated', 'record.deleted', 'deal.stage_changed'];
    known_entities text[] := array['company', 'contact', 'crm_lead', 'deal'];
    scopes text[];
    events text[];
    hook_url text;
    actions jsonb := '[]'::jsonb;
    a jsonb;
    w jsonb;
begin
    if p is null or jsonb_typeof(p) <> 'object' then
        raise exception 'manifest: must be a JSON object' using errcode = '22023';
    end if;
    if pg_column_size(p) > 20000 then
        raise exception 'manifest: too large (20 KB max)' using errcode = '22023';
    end if;
    if coalesce(p ->> 'schema', '1') <> '1' then
        raise exception 'manifest: unsupported schema version' using errcode = '22023';
    end if;
    select coalesce(array_agg(distinct x order by x), '{}') into scopes from jsonb_array_elements_text(coalesce(p -> 'scopes', '[]')) x;
    if not scopes <@ known_scopes then
        raise exception 'manifest: unknown scope (allowed: %)', array_to_string(known_scopes, ', ') using errcode = '22023';
    end if;

    if p ? 'webhooks' then
        hook_url := p -> 'webhooks' ->> 'url';
        if hook_url is null or not private.market_url_ok(hook_url) then
            raise exception 'manifest: webhooks.url must be a public https address' using errcode = '22023';
        end if;
        select coalesce(array_agg(distinct x order by x), '{}') into events from jsonb_array_elements_text(coalesce(p -> 'webhooks' -> 'events', '[]')) x;
        if cardinality(events) = 0 or not events <@ known_events then
            raise exception 'manifest: webhooks.events must list known events (%)', array_to_string(known_events, ', ') using errcode = '22023';
        end if;
    end if;

    if jsonb_typeof(coalesce(p -> 'actions', '[]')) <> 'array' or jsonb_array_length(coalesce(p -> 'actions', '[]')) > 10 then
        raise exception 'manifest: actions must be an array of up to 10 items' using errcode = '22023';
    end if;
    for a in select * from jsonb_array_elements(coalesce(p -> 'actions', '[]')) loop
        if coalesce(a ->> 'id', '') !~ '^[a-z0-9_-]{1,40}$' or char_length(btrim(coalesce(a ->> 'label', ''))) not between 1 and 40
           or not (a ->> 'entity') = any (known_entities) or not private.market_url_ok(coalesce(a ->> 'url', '')) then
            raise exception 'manifest: action needs id, label (1–40), entity (%) and a public https url', array_to_string(known_entities, ', ')
                using errcode = '22023';
        end if;
        -- Поля записи в ссылке — только с правом crm.read; {id}, {type} и {workspace_id} можно всегда.
        if (a ->> 'url') ~ '\{title\}' and not 'crm.read' = any (scopes) then
            raise exception 'manifest: {title} in an action url needs the crm.read scope' using errcode = '22023';
        end if;
        if (regexp_replace(a ->> 'url', '\{(id|type|workspace_id|title)\}', '', 'g')) ~ '[{}]' then
            raise exception 'manifest: action url may use only {id}, {type}, {workspace_id} and {title}' using errcode = '22023';
        end if;
        actions := actions || jsonb_build_array(jsonb_build_object('id', a ->> 'id', 'label', btrim(a ->> 'label'),
                                                                   'entity', a ->> 'entity', 'url', a ->> 'url'));
    end loop;

    w := p -> 'window';
    if w is not null and (jsonb_typeof(w) <> 'object' or not private.market_url_ok(coalesce(w ->> 'url', ''))) then
        raise exception 'manifest: window.url must be a public https address' using errcode = '22023';
    end if;

    return jsonb_strip_nulls(jsonb_build_object(
        'schema', 1,
        'scopes', to_jsonb(scopes),
        'webhooks', case when hook_url is null then null else jsonb_build_object('url', hook_url, 'events', to_jsonb(events)) end,
        'actions', actions,
        'window', case when w is null then null else jsonb_build_object('url', w ->> 'url') end));
end;
$$;

-- ------------------------------------------------------------------ представления для приложения

create or replace function private.market_app_json(a public.market_apps, p_workspace uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    select jsonb_build_object(
        'id', a.id, 'slug', a.slug, 'name', a.name, 'tagline', a.tagline, 'description', a.description,
        'category', a.category, 'icon', a.icon, 'website', a.website, 'support_email', a.support_email,
        'developer_name', a.developer_name, 'status', a.status,
        'version', v.version, 'manifest', v.manifest, 'updated_at', coalesce(v.reviewed_at, a.updated_at),
        'installs', (select count(*) from public.market_installs i where i.app_id = a.id),
        'installed', case when i.app_id is null then null else jsonb_build_object(
            'version', iv.version, 'manifest', iv.manifest, 'enabled', i.enabled, 'installed_at', i.installed_at,
            'update_available', i.version_id is distinct from a.live_version_id and a.live_version_id is not null) end)
    from (select 1) one
    left join public.market_versions v on v.id = a.live_version_id
    left join public.market_installs i on i.app_id = a.id and i.workspace_id = p_workspace
    left join public.market_versions iv on iv.id = i.version_id;
$$;

-- Каталог: опубликованные интеграции; для участника Workspace — ещё и что установлено.
create or replace function public.market_catalog(p_workspace uuid default null, p_query text default null, p_category text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    ws uuid := case when p_workspace is not null and private.is_member(p_workspace) then p_workspace end;
    q text := nullif(btrim(coalesce(p_query, '')), '');
begin
    perform private.uid();
    return (select coalesce(jsonb_agg(private.market_app_json(a, ws) order by a.name), '[]'::jsonb)
            from public.market_apps a
            where a.status = 'listed' and a.live_version_id is not null
              and (p_category is null or a.category = p_category)
              and (q is null or a.name ilike '%' || q || '%' or a.tagline ilike '%' || q || '%' or a.developer_name ilike '%' || q || '%'));
end;
$$;

-- Установленные и включённые интеграции Workspace: кнопки для карточек CRM.
create or replace function public.market_installed(p_workspace uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    perform private.require_perm(p_workspace, 'records.view');
    return (select coalesce(jsonb_agg(jsonb_build_object('app_id', a.id, 'name', a.name, 'icon', a.icon,
                                                         'actions', coalesce(v.manifest -> 'actions', '[]'::jsonb),
                                                         'scopes', coalesce(v.manifest -> 'scopes', '[]'::jsonb))
                                      order by a.name), '[]'::jsonb)
            from public.market_installs i
            join public.market_apps a on a.id = i.app_id and a.status = 'listed'
            join public.market_versions v on v.id = i.version_id
            where i.workspace_id = p_workspace and i.enabled);
end;
$$;

-- ------------------------------------------------------------------ события для интеграций

-- Отправить событие одной установке: POST с подписью X-Customers-Signature = hex(HMAC-SHA256(тело, секрет)).
create or replace function private.market_deliver(p_workspace uuid, p_app uuid, p_url text, p_secret text, p_event text, p_body jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    body jsonb := p_body || jsonb_build_object('event', p_event, 'workspace_id', p_workspace, 'app_id', p_app, 'sent_at', now());
    sig text;
    req bigint;
begin
    if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
       or to_regprocedure('extensions.hmac(bytea,bytea,text)') is null then
        return;
    end if;
    -- Не чаще 600 событий в минуту на интеграцию в одном Workspace: защита от лавины при массовых правках.
    if (select count(*) from private.market_deliveries
        where app_id = p_app and workspace_id = p_workspace and created_at > now() - interval '1 minute') >= 600 then
        return;
    end if;
    begin
        execute 'select encode(extensions.hmac(convert_to($1, ''utf8''), convert_to($2, ''utf8''), ''sha256''), ''hex'')'
            into sig using body::text, p_secret;
        execute 'select net.http_post(url => $1, body => $2, headers => $3, timeout_milliseconds => 5000)'
            into req using p_url, body,
                 jsonb_build_object('Content-Type', 'application/json', 'X-Customers-Event', p_event,
                                    'X-Customers-Signature', 'sha256=' || sig);
        insert into private.market_deliveries (workspace_id, app_id, event, request_id) values (p_workspace, p_app, p_event, req);
    exception when others then
        null; -- сбой отправки не мешает работе с CRM
    end;
end;
$$;

-- Событие записи CRM всем включённым установкам Workspace, подписанным на него.
create or replace function private.market_emit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    rec jsonb := to_jsonb(new);
    v_type text := case tg_table_name when 'companies' then 'company' when 'contacts' then 'contact'
                                      when 'crm_leads' then 'crm_lead' when 'deals' then 'deal' end;
    events text[] := '{}';
    e text;
    x record;
begin
    if not exists (select 1 from public.market_installs where workspace_id = new.workspace_id and enabled) then
        return null;
    end if;
    if tg_op = 'INSERT' then
        events := array['record.created'];
    elsif new.deleted_at is not null and old.deleted_at is null then
        events := array['record.deleted'];
    else
        events := array['record.updated'];
        if tg_table_name = 'deals' and (rec ->> 'stage_id') is distinct from (to_jsonb(old) ->> 'stage_id') then
            events := events || 'deal.stage_changed';
        end if;
    end if;
    for x in
        select i.app_id, i.secret, v.manifest
        from public.market_installs i
        join public.market_apps a on a.id = i.app_id and a.status = 'listed'
        join public.market_versions v on v.id = i.version_id
        where i.workspace_id = new.workspace_id and i.enabled and v.manifest ? 'webhooks'
    loop
        foreach e in array events loop
            if (x.manifest -> 'webhooks' -> 'events') ? e then
                perform private.market_deliver(new.workspace_id, x.app_id, x.manifest -> 'webhooks' ->> 'url', x.secret, e,
                    jsonb_build_object('entity_type', v_type, 'entity_id', new.id)
                    || case when (x.manifest -> 'scopes') ? 'crm.read' then jsonb_build_object('record', rec) else '{}'::jsonb end);
            end if;
        end loop;
    end loop;
    return null;
end;
$$;

do $$
declare
    t text;
begin
    foreach t in array array['companies', 'contacts', 'crm_leads', 'deals'] loop
        execute format('create or replace trigger %I after insert or update on public.%I for each row execute function private.market_emit()',
                       t || '_market', t);
    end loop;
end;
$$;

-- ------------------------------------------------------------------ установка

create or replace function public.market_install(p_workspace uuid, p_app uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    a public.market_apps;
    v public.market_versions;
    secret text;
begin
    perform private.require_perm(p_workspace, 'workspace.manage');
    select * into a from public.market_apps where id = p_app and status = 'listed' and live_version_id is not null;
    if a.id is null then
        raise exception 'app not found' using errcode = 'P0002';
    end if;
    select * into v from public.market_versions where id = a.live_version_id;
    select i.secret into secret from public.market_installs i where i.workspace_id = p_workspace and i.app_id = a.id;
    if secret is null then
        -- 244 случайных бита из двух uuid v4: без зависимости от pgcrypto.
        secret := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
        insert into public.market_installs (workspace_id, app_id, version_id, installed_by, secret)
        values (p_workspace, a.id, v.id, u, secret);
        if v.manifest ? 'webhooks' then
            perform private.market_deliver(p_workspace, a.id, v.manifest -> 'webhooks' ->> 'url', secret, 'app.installed',
                                           jsonb_build_object('secret', secret, 'scopes', v.manifest -> 'scopes'));
        end if;
    else
        -- Обновление до опубликованной версии: владелец Workspace подтвердил её права.
        update public.market_installs set version_id = v.id, enabled = true where workspace_id = p_workspace and app_id = a.id;
    end if;
    insert into public.audit_log (workspace_id, actor_id, action, entity_type, entity_id, details)
    values (p_workspace, u, 'market.installed', 'market_app', a.id, jsonb_build_object('version', v.version, 'scopes', v.manifest -> 'scopes'));
    return private.market_app_json(a, p_workspace);
end;
$$;

create or replace function public.market_uninstall(p_workspace uuid, p_app uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    i public.market_installs;
    v public.market_versions;
begin
    perform private.require_perm(p_workspace, 'workspace.manage');
    delete from public.market_installs where workspace_id = p_workspace and app_id = p_app returning * into i;
    if i.app_id is null then
        return;
    end if;
    select * into v from public.market_versions where id = i.version_id;
    if v.manifest ? 'webhooks' then
        perform private.market_deliver(p_workspace, p_app, v.manifest -> 'webhooks' ->> 'url', i.secret, 'app.uninstalled', '{}'::jsonb);
    end if;
    insert into public.audit_log (workspace_id, actor_id, action, entity_type, entity_id)
    values (p_workspace, private.uid(), 'market.uninstalled', 'market_app', p_app);
end;
$$;

create or replace function public.market_set_enabled(p_workspace uuid, p_app uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.require_perm(p_workspace, 'workspace.manage');
    update public.market_installs set enabled = coalesce(p_enabled, false) where workspace_id = p_workspace and app_id = p_app;
    if not found then
        raise exception 'app is not installed' using errcode = 'P0002';
    end if;
end;
$$;

-- ------------------------------------------------------------------ разработчик

create or replace function public.market_my_apps()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
begin
    return (select coalesce(jsonb_agg(private.market_app_json(a, null) || jsonb_build_object(
                'versions', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'version', v.version, 'status', v.status,
                                                                         'review_note', v.review_note, 'created_at', v.created_at,
                                                                         'manifest', v.manifest)
                                                       order by v.created_at desc), '[]'::jsonb)
                             from public.market_versions v where v.app_id = a.id),
                'status_note', a.status_note) order by a.created_at desc), '[]'::jsonb)
            from public.market_apps a where a.developer_id = u);
end;
$$;

-- Подать интеграцию или новую версию на проверку. Описание меняется сразу, манифест — после одобрения.
create or replace function public.market_submit(p_app jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    a public.market_apps;
    v_manifest jsonb := private.market_manifest(p_app -> 'manifest');
    v_version text := btrim(coalesce(p_app ->> 'version', ''));
begin
    if (select count(*) from public.market_versions v join public.market_apps x on x.id = v.app_id
        where x.developer_id = u and v.created_at > now() - interval '1 day') >= 10 then
        raise exception 'too many submissions today' using errcode = '54000';
    end if;
    if p_app ? 'id' and nullif(p_app ->> 'id', '') is not null then
        select * into a from public.market_apps where id = (p_app ->> 'id')::uuid;
        if a.id is null or a.developer_id <> u then
            raise exception 'app not found' using errcode = 'P0002';
        end if;
        if a.status = 'suspended' then
            raise exception 'app is suspended by moderators' using errcode = '42501';
        end if;
        update public.market_apps set
            developer_name = coalesce(nullif(btrim(p_app ->> 'developer_name'), ''), developer_name),
            name = coalesce(nullif(btrim(p_app ->> 'name'), ''), name),
            tagline = coalesce(btrim(p_app ->> 'tagline'), tagline),
            description = coalesce(btrim(p_app ->> 'description'), description),
            category = coalesce(p_app ->> 'category', category),
            icon = coalesce(nullif(btrim(p_app ->> 'icon'), ''), icon),
            website = case when p_app ? 'website' then nullif(btrim(p_app ->> 'website'), '') else website end,
            support_email = case when p_app ? 'support_email' then nullif(btrim(p_app ->> 'support_email'), '') else support_email end,
            updated_at = now()
        where id = a.id returning * into a;
    else
        insert into public.market_apps (slug, developer_id, developer_name, name, tagline, description, category, icon, website, support_email)
        values (lower(btrim(coalesce(p_app ->> 'slug', ''))), u, btrim(coalesce(p_app ->> 'developer_name', '')),
                btrim(coalesce(p_app ->> 'name', '')), btrim(coalesce(p_app ->> 'tagline', '')),
                btrim(coalesce(p_app ->> 'description', '')), coalesce(p_app ->> 'category', 'other'),
                coalesce(nullif(btrim(p_app ->> 'icon'), ''), '🧩'), nullif(btrim(p_app ->> 'website'), ''),
                nullif(btrim(p_app ->> 'support_email'), ''))
        returning * into a;
    end if;
    -- Ждущая проверки версия заменяется новой подачей.
    update public.market_versions set status = 'superseded' where app_id = a.id and status = 'pending';
    insert into public.market_versions (app_id, version, manifest) values (a.id, v_version, v_manifest);
    return private.market_app_json(a, null);
end;
$$;

-- ------------------------------------------------------------------ модерация

create or replace function public.market_is_moderator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select private.is_platform_admin();
$$;

create or replace function private.require_moderator()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not private.is_platform_admin() then
        raise exception 'permission denied: marketplace moderation' using errcode = '42501';
    end if;
end;
$$;

create or replace function public.market_review_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    perform private.require_moderator();
    return (select coalesce(jsonb_agg(jsonb_build_object(
                'version_id', v.id, 'version', v.version, 'manifest', v.manifest, 'created_at', v.created_at,
                'live_manifest', lv.manifest, 'developer_email', du.email,
                'app', private.market_app_json(a, null) || jsonb_build_object('status_note', a.status_note))
            order by v.created_at), '[]'::jsonb)
            from public.market_versions v
            join public.market_apps a on a.id = v.app_id
            left join public.market_versions lv on lv.id = a.live_version_id
            left join auth.users du on du.id = a.developer_id
            where v.status = 'pending');
end;
$$;

create or replace function public.market_review(p_version uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v public.market_versions;
begin
    perform private.require_moderator();
    select * into v from public.market_versions where id = p_version and status = 'pending';
    if v.id is null then
        raise exception 'version is not waiting for review' using errcode = 'P0002';
    end if;
    if not coalesce(p_approve, false) and char_length(btrim(coalesce(p_note, ''))) = 0 then
        raise exception 'say why the version is rejected' using errcode = '22023';
    end if;
    update public.market_versions set status = case when p_approve then 'approved' else 'rejected' end,
        review_note = nullif(btrim(coalesce(p_note, '')), ''), reviewed_by = private.uid(), reviewed_at = now()
    where id = v.id;
    if p_approve then
        update public.market_versions set status = 'superseded' where app_id = v.app_id and status = 'approved' and id <> v.id;
        update public.market_apps set live_version_id = v.id, status = case when status = 'suspended' then status else 'listed' end,
            updated_at = now() where id = v.app_id;
    end if;
end;
$$;

-- Снять интеграцию с каталога (и остановить её события во всех Workspace) или вернуть.
create or replace function public.market_suspend(p_app uuid, p_suspend boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.require_moderator();
    update public.market_apps set
        status = case when p_suspend then 'suspended' when live_version_id is not null then 'listed' else 'draft' end,
        status_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
    where id = p_app;
    if not found then
        raise exception 'app not found' using errcode = 'P0002';
    end if;
end;
$$;

-- ------------------------------------------------------------------ права на функции

revoke all on function private.is_platform_admin(), private.market_url_ok(text), private.market_manifest(jsonb),
    private.market_app_json(public.market_apps, uuid), private.market_deliver(uuid, uuid, text, text, text, jsonb),
    private.market_emit(), private.require_moderator() from public, anon, authenticated;
revoke all on function public.market_catalog(uuid, text, text), public.market_installed(uuid),
    public.market_install(uuid, uuid), public.market_uninstall(uuid, uuid), public.market_set_enabled(uuid, uuid, boolean),
    public.market_my_apps(), public.market_submit(jsonb), public.market_is_moderator(), public.market_review_queue(),
    public.market_review(uuid, boolean, text), public.market_suspend(uuid, boolean, text) from public, anon;
grant execute on function public.market_catalog(uuid, text, text), public.market_installed(uuid),
    public.market_install(uuid, uuid), public.market_uninstall(uuid, uuid), public.market_set_enabled(uuid, uuid, boolean),
    public.market_my_apps(), public.market_submit(jsonb), public.market_is_moderator(), public.market_review_queue(),
    public.market_review(uuid, boolean, text), public.market_suspend(uuid, boolean, text) to authenticated;
