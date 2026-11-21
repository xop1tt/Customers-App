-- Модерация коннекторов (ADR-095). Дополняет 20261111100000_marketplace.sql тем, что ADR-083 (7) оставил на потом:
--
-- 1. Модераторы платформы. Первого модератора владелец проекта добавляет сам в SQL Editor (инструкция в docs/MARKETPLACE.md),
--    дальше модераторы добавляют и убирают друг друга из приложения: market_moderators, market_moderator_add,
--    market_moderator_remove. Последнего модератора убрать нельзя.
-- 2. Проверка компаний-разработчиков: private.market_companies и market_company, market_company_save,
--    market_company_queue, market_company_review. Отправить коннектор может только проверенная компания.
-- 3. Автопроверка на сервере: private.market_checks повторяет правила lib/connectors.ts, которые нельзя обойти прямым
--    вызовом RPC. Отказ не создаёт версию; отчёт хранится в market_versions.checks. Одобрить можно только версию без
--    замечаний уровня fail и только у проверенной компании.
-- 4. Журнал решений private.market_audit: одобрения, отказы, снятие и возврат в каталог, решения по компаниям,
--    изменения списка модераторов. Пишут только функции ниже; изменить или удалить запись пользователю нельзя.
--    Читают модераторы: market_audit_log.
-- 5. Уведомления разработчику private.market_notices: решение по версии, компании, снятие с каталога.
--    market_notices — список и число непрочитанных, market_notices_read — отметить прочитанными.
--
-- Каталог и установка по-прежнему видят только status = 'listed' с одобренной live-версией (20261111100000).
-- Схема совместима с прежним клиентом: новые столбцы с значениями по умолчанию, прежние функции с теми же аргументами.
-- Повторное применение безопасно.

-- ------------------------------------------------------------------ таблицы

alter table private.platform_admins add column if not exists added_by uuid references auth.users (id) on delete set null;

create table if not exists private.market_companies (
    user_id uuid primary key references auth.users (id) on delete cascade,
    legal_name text not null check (char_length(btrim(legal_name)) between 3 and 160),
    country text not null check (char_length(btrim(country)) between 2 and 60),
    reg_number text not null check (reg_number ~ '^[0-9A-Za-z -]{8,20}$'),
    website text not null check (char_length(website) <= 300),
    privacy_url text not null check (char_length(privacy_url) <= 500),
    contact_name text not null check (char_length(btrim(contact_name)) between 3 and 80),
    contact_email text not null check (char_length(contact_email) <= 254),
    status text not null default 'submitted' check (status in ('submitted', 'verified', 'rejected')),
    note text check (char_length(note) <= 1000),
    submitted_at timestamptz not null default now(),
    reviewed_by uuid references auth.users (id) on delete set null,
    reviewed_at timestamptz
);
create index if not exists market_companies_submitted on private.market_companies (submitted_at) where status = 'submitted';
revoke all on private.market_companies from public, anon, authenticated;

-- Отчёт серверной автопроверки на момент подачи: [{id, label, level, detail}] без пунктов «в порядке».
alter table public.market_versions add column if not exists checks jsonb not null default '[]'::jsonb;

create table if not exists private.market_audit (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    actor_id uuid references auth.users (id) on delete set null,
    action text not null check (action in ('version_approved', 'version_rejected', 'app_suspended', 'app_restored',
                                            'company_verified', 'company_rejected', 'moderator_added', 'moderator_removed')),
    app_id uuid references public.market_apps (id) on delete set null,
    version_id uuid references public.market_versions (id) on delete set null,
    subject_id uuid references auth.users (id) on delete set null,
    note text check (char_length(note) <= 1000),
    -- Снимок на момент решения (название, версия, права, адреса, замечания автопроверки, почта автора):
    -- запись читается и после удаления коннектора или учётной записи.
    details jsonb not null default '{}'::jsonb
);
create index if not exists market_audit_time on private.market_audit (id desc);
create index if not exists market_audit_app on private.market_audit (app_id, id desc);
revoke all on private.market_audit from public, anon, authenticated;

create table if not exists private.market_notices (
    id bigserial primary key,
    user_id uuid not null references auth.users (id) on delete cascade,
    kind text not null check (kind in ('version_approved', 'version_rejected', 'app_suspended', 'app_restored',
                                       'company_verified', 'company_rejected')),
    app_id uuid references public.market_apps (id) on delete cascade,
    title text not null check (char_length(title) <= 200),
    note text check (char_length(note) <= 1000),
    created_at timestamptz not null default now(),
    read_at timestamptz
);
create index if not exists market_notices_user on private.market_notices (user_id, id desc);
revoke all on private.market_notices from public, anon, authenticated;

-- ------------------------------------------------------------------ служебные функции

create or replace function private.market_host(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$
    select nullif(regexp_replace(lower(substring(coalesce(p_url, '') from '^https://([^/:?#]+)')), '^www\.', ''), '');
$$;

create or replace function private.market_same_site(p_a text, p_b text)
returns boolean
language sql
immutable
set search_path = ''
as $$
    select p_a is not null and p_b is not null
       and (p_a = p_b or p_a like '%.' || p_b or p_b like '%.' || p_a);
$$;

create or replace function private.market_check_item(p_id text, p_label text, p_ok boolean, p_detail text, p_level text default 'fail')
returns jsonb
language sql
immutable
set search_path = ''
as $$
    select case when coalesce(p_ok, false) then null
                else jsonb_build_object('id', p_id, 'label', p_label, 'level', p_level, 'detail', p_detail) end;
$$;

-- Автопроверка версии: те же правила, что lib/connectors.ts (структуру манифеста уже проверила private.market_manifest).
-- Возвращает только замечания: level = 'fail' не даёт подать и одобрить версию, 'warn' — для модератора.
create or replace function private.market_checks(a public.market_apps, p_manifest jsonb, p_version text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
    site text := private.market_host(a.website);
    out jsonb := '[]'::jsonb;
    x jsonb;
    hosts text[];
begin
    foreach x in array array[
        private.market_check_item('name', 'Название', char_length(btrim(a.name)) between 2 and 60, 'Название — от 2 до 60 символов.'),
        private.market_check_item('version', 'Версия', coalesce(p_version, '') ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$', 'Версия — в виде 1.0.0.'),
        private.market_check_item('tagline', 'Краткое описание', char_length(btrim(a.tagline)) between 10 and 140,
                                  'Кратко — от 10 до 140 символов: что делает коннектор.'),
        private.market_check_item('description', 'Полное описание', char_length(btrim(a.description)) >= 40,
                                  'Опишите коннектор подробнее: не короче 40 символов.', 'warn'),
        private.market_check_item('website', 'Сайт', a.website is not null and private.market_url_ok(lower(a.website)), 'Сайт — публичный адрес https.'),
        private.market_check_item('support', 'Почта поддержки', coalesce(a.support_email, '') ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$',
                                  'Укажите рабочую почту поддержки.'),
        private.market_check_item('empty', 'Что делает коннектор',
                                  p_manifest ? 'webhooks' or jsonb_array_length(coalesce(p_manifest -> 'actions', '[]')) > 0 or p_manifest ? 'window',
                                  'Нужны кнопки в карточках или события: пустой манифест ничего не делает.')
    ] loop
        if x is not null then
            out := out || jsonb_build_array(x);
        end if;
    end loop;
    if p_manifest ? 'webhooks' and jsonb_array_length(coalesce(p_manifest -> 'scopes', '[]')) = 0 then
        out := out || jsonb_build_array(private.market_check_item('webhook-scope', 'Права и события', false,
            'События придут без полей записей: только идентификаторы. Добавьте crm.read, если поля нужны.', 'warn'));
    end if;
    -- Адреса манифеста не на домене сайта разработчика: частая ошибка и признак чужого сервиса.
    select array_agg(private.market_host(u)) into hosts from (
        select p_manifest -> 'webhooks' ->> 'url' as u
        union all select e ->> 'url' from jsonb_array_elements(coalesce(p_manifest -> 'actions', '[]')) e
        union all select p_manifest -> 'window' ->> 'url') s where u is not null;
    if site is not null and exists (select 1 from unnest(coalesce(hosts, '{}')) h where not private.market_same_site(h, site)) then
        out := out || jsonb_build_array(private.market_check_item('hosts', 'Адреса и сайт', false,
            'Часть адресов ведёт не на домен сайта разработчика: модератор уточнит, чей это сервис.', 'warn'));
    end if;
    return out;
end;
$$;

create or replace function private.market_failures(p_checks jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
    select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(coalesce(p_checks, '[]')) c where c ->> 'level' = 'fail';
$$;

-- Проверка заявки компании: те же правила, что checkCompany в lib/connectors.ts. Возвращает первое замечание или null.
create or replace function private.market_company_problem(p jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
    free_mail text[] := array['gmail.com', 'mail.ru', 'yandex.ru', 'ya.ru', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
                              'bk.ru', 'inbox.ru', 'list.ru', 'proton.me', 'protonmail.com', 'rambler.ru'];
    site text := private.market_host(lower(btrim(coalesce(p ->> 'website', ''))));
    email text := lower(btrim(coalesce(p ->> 'contact_email', '')));
    dom text := split_part(email, '@', 2);
begin
    if char_length(btrim(coalesce(p ->> 'legal_name', ''))) not between 3 and 160 then
        return 'Укажите полное название компании или ИП.';
    elsif char_length(btrim(coalesce(p ->> 'country', ''))) not between 2 and 60 then
        return 'Укажите страну регистрации.';
    elsif btrim(coalesce(p ->> 'reg_number', '')) !~ '^[0-9A-Za-z -]{8,20}$' then
        return 'ИНН, ОГРН или номер из реестра вашей страны: 8–20 знаков.';
    elsif not private.market_url_ok(lower(btrim(coalesce(p ->> 'website', '')))) then
        return 'Сайт — публичный адрес https.';
    elsif char_length(btrim(coalesce(p ->> 'contact_name', ''))) not between 3 and 80 then
        return 'Укажите имя ответственного за коннекторы.';
    elsif email !~ '^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$' or char_length(email) > 254 or dom = any (free_mail) then
        return 'Нужна рабочая почта на домене компании, не личная (gmail, mail.ru и подобные).';
    elsif not private.market_same_site(site, dom) then
        return 'Домен почты должен совпадать с доменом сайта: так подтверждается, что вы представляете компанию.';
    elsif not private.market_url_ok(lower(btrim(coalesce(p ->> 'privacy_url', ''))))
          or not private.market_same_site(private.market_host(lower(btrim(coalesce(p ->> 'privacy_url', '')))), site) then
        return 'Адрес политики конфиденциальности на сайте компании (https).';
    end if;
    return null;
end;
$$;

create or replace function private.market_company_json(c private.market_companies)
returns jsonb
language sql
stable
set search_path = ''
as $$
    select jsonb_build_object('legal_name', c.legal_name, 'country', c.country, 'reg_number', c.reg_number, 'website', c.website,
                              'contact_name', c.contact_name, 'contact_email', c.contact_email, 'privacy_url', c.privacy_url,
                              'status', c.status, 'note', c.note, 'submitted_at', c.submitted_at, 'reviewed_at', c.reviewed_at);
$$;

create or replace function private.market_log(p_action text, p_app uuid, p_version uuid, p_subject uuid, p_note text, p_details jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
    insert into private.market_audit (actor_id, action, app_id, version_id, subject_id, note, details)
    values (auth.uid(), p_action, p_app, p_version, p_subject, nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_details, '{}'::jsonb));
$$;

create or replace function private.market_notify(p_user uuid, p_kind text, p_app uuid, p_title text, p_note text)
returns void
language sql
security definer
set search_path = ''
as $$
    insert into private.market_notices (user_id, kind, app_id, title, note)
    select p_user, p_kind, p_app, left(p_title, 200), nullif(btrim(coalesce(p_note, '')), '') where p_user is not null;
$$;

-- ------------------------------------------------------------------ компания разработчика

create or replace function public.market_company()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    c private.market_companies;
begin
    select * into c from private.market_companies where user_id = private.uid();
    if c.user_id is null then
        return jsonb_build_object('legal_name', '', 'country', '', 'reg_number', '', 'website', '', 'contact_name', '',
                                  'contact_email', '', 'privacy_url', '', 'status', 'none', 'note', null, 'submitted_at', null);
    end if;
    return private.market_company_json(c);
end;
$$;

create or replace function public.market_company_save(p_company jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    problem text := private.market_company_problem(p_company);
    c private.market_companies;
begin
    if (select status from private.market_companies where user_id = u) = 'verified' then
        raise exception 'Компания уже проверена. Чтобы изменить данные, напишите в поддержку.' using errcode = '42501';
    end if;
    if problem is not null then
        raise exception '%', problem using errcode = '22023';
    end if;
    insert into private.market_companies (user_id, legal_name, country, reg_number, website, privacy_url, contact_name, contact_email)
    values (u, btrim(p_company ->> 'legal_name'), btrim(p_company ->> 'country'), btrim(p_company ->> 'reg_number'),
            btrim(p_company ->> 'website'), btrim(p_company ->> 'privacy_url'), btrim(p_company ->> 'contact_name'),
            lower(btrim(p_company ->> 'contact_email')))
    on conflict (user_id) do update set
        legal_name = excluded.legal_name, country = excluded.country, reg_number = excluded.reg_number, website = excluded.website,
        privacy_url = excluded.privacy_url, contact_name = excluded.contact_name, contact_email = excluded.contact_email,
        status = 'submitted', note = null, submitted_at = now(), reviewed_by = null, reviewed_at = null
    returning * into c;
    return private.market_company_json(c);
end;
$$;

create or replace function public.market_company_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    perform private.require_moderator();
    return (select coalesce(jsonb_agg(jsonb_build_object('user_id', c.user_id, 'account_email', u.email,
                                                         'company', private.market_company_json(c)) order by c.submitted_at), '[]'::jsonb)
            from private.market_companies c left join auth.users u on u.id = c.user_id
            where c.status = 'submitted');
end;
$$;

create or replace function public.market_company_review(p_user uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    c private.market_companies;
    ok boolean := coalesce(p_approve, false);
begin
    perform private.require_moderator();
    select * into c from private.market_companies where user_id = p_user and status = 'submitted' for update;
    if c.user_id is null then
        raise exception 'Заявка уже рассмотрена.' using errcode = 'P0002';
    end if;
    if not ok and char_length(btrim(coalesce(p_note, ''))) = 0 then
        raise exception 'Напишите, почему компания не прошла проверку.' using errcode = '22023';
    end if;
    update private.market_companies set status = case when ok then 'verified' else 'rejected' end,
        note = nullif(btrim(coalesce(p_note, '')), ''), reviewed_by = private.uid(), reviewed_at = now()
    where user_id = c.user_id returning * into c;
    perform private.market_log(case when ok then 'company_verified' else 'company_rejected' end, null, null, c.user_id, p_note,
                               private.market_company_json(c));
    perform private.market_notify(c.user_id, case when ok then 'company_verified' else 'company_rejected' end, null,
        case when ok then 'Компания «' || c.legal_name || '» проверена: можно отправлять коннекторы'
             else 'Компания «' || c.legal_name || '» не прошла проверку' end, p_note);
end;
$$;

-- ------------------------------------------------------------------ подача: только проверенная компания и автопроверка

create or replace function public.market_submit(p_app jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    a public.market_apps;
    co private.market_companies;
    v_manifest jsonb := private.market_manifest(p_app -> 'manifest');
    v_version text := btrim(coalesce(p_app ->> 'version', ''));
    v_checks jsonb;
    v_fail jsonb;
begin
    select * into co from private.market_companies where user_id = u;
    if co.status is distinct from 'verified' then
        raise exception 'Отправлять коннекторы могут только проверенные компании: сначала пройдите проверку компании.' using errcode = '42501';
    end if;
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
            developer_name = co.legal_name,
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
        values (lower(btrim(coalesce(p_app ->> 'slug', ''))), u, co.legal_name,
                btrim(coalesce(p_app ->> 'name', '')), btrim(coalesce(p_app ->> 'tagline', '')),
                btrim(coalesce(p_app ->> 'description', '')), coalesce(p_app ->> 'category', 'other'),
                coalesce(nullif(btrim(p_app ->> 'icon'), ''), '🧩'), nullif(btrim(p_app ->> 'website'), ''),
                nullif(btrim(p_app ->> 'support_email'), ''))
        returning * into a;
    end if;
    -- Отказ автопроверки откатывает и изменения описания выше: исключение отменяет всю функцию.
    v_checks := private.market_checks(a, v_manifest, v_version);
    v_fail := private.market_failures(v_checks);
    if jsonb_array_length(v_fail) > 0 then
        raise exception 'Автопроверка: %', v_fail -> 0 ->> 'detail' using errcode = '22023';
    end if;
    -- Ждущая проверки версия заменяется новой подачей.
    update public.market_versions set status = 'superseded' where app_id = a.id and status = 'pending';
    insert into public.market_versions (app_id, version, manifest, checks) values (a.id, v_version, v_manifest, v_checks);
    return private.market_app_json(a, null);
end;
$$;

-- Отчёт автопроверки виден разработчику вместе с версиями.
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
                                                                         'reviewed_at', v.reviewed_at, 'manifest', v.manifest,
                                                                         'checks', v.checks)
                                                       order by v.created_at desc), '[]'::jsonb)
                             from public.market_versions v where v.app_id = a.id),
                'status_note', a.status_note) order by a.created_at desc), '[]'::jsonb)
            from public.market_apps a where a.developer_id = u);
end;
$$;

-- ------------------------------------------------------------------ модерация коннекторов

-- Очередь: всё, что нужно для аудита, — описание, манифест (права, адреса событий и кнопок), что опубликовано сейчас,
-- автопроверка при подаче и сейчас, компания и прошлые решения по этому коннектору.
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
                'live_manifest', lv.manifest, 'live_version', lv.version, 'developer_email', du.email,
                'checks', v.checks, 'server_checks', private.market_checks(a, v.manifest, v.version),
                'company', case when co.user_id is null then null else private.market_company_json(co) end,
                'history', (select coalesce(jsonb_agg(jsonb_build_object('action', h.action, 'note', h.note, 'created_at', h.created_at,
                                                                         'version', h.details ->> 'version') order by h.id desc), '[]'::jsonb)
                            from (select * from private.market_audit h where h.app_id = a.id order by h.id desc limit 10) h),
                'app', private.market_app_json(a, null) || jsonb_build_object('status_note', a.status_note))
            order by v.created_at), '[]'::jsonb)
            from public.market_versions v
            join public.market_apps a on a.id = v.app_id
            left join public.market_versions lv on lv.id = a.live_version_id
            left join auth.users du on du.id = a.developer_id
            left join private.market_companies co on co.user_id = a.developer_id
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
    a public.market_apps;
    ok boolean := coalesce(p_approve, false);
    v_checks jsonb;
    v_fail jsonb;
begin
    perform private.require_moderator();
    select * into v from public.market_versions where id = p_version and status = 'pending' for update;
    if v.id is null then
        raise exception 'version is not waiting for review' using errcode = 'P0002';
    end if;
    select * into a from public.market_apps where id = v.app_id for update;
    if not ok and char_length(btrim(coalesce(p_note, ''))) = 0 then
        raise exception 'say why the version is rejected' using errcode = '22023';
    end if;
    v_checks := private.market_checks(a, v.manifest, v.version);
    if ok then
        v_fail := private.market_failures(v_checks);
        if jsonb_array_length(v_fail) > 0 then
            raise exception 'Автопроверка не пройдена: %. Отклоните версию с причиной.', v_fail -> 0 ->> 'detail' using errcode = '22023';
        end if;
        if not exists (select 1 from private.market_companies where user_id = a.developer_id and status = 'verified') then
            raise exception 'Компания разработчика не проверена: сначала подтвердите компанию или отклоните версию.' using errcode = '42501';
        end if;
    end if;
    update public.market_versions set status = case when ok then 'approved' else 'rejected' end,
        review_note = nullif(btrim(coalesce(p_note, '')), ''), reviewed_by = private.uid(), reviewed_at = now()
    where id = v.id;
    if ok then
        update public.market_versions set status = 'superseded' where app_id = v.app_id and status = 'approved' and id <> v.id;
        update public.market_apps set live_version_id = v.id, status = case when status = 'suspended' then status else 'listed' end,
            updated_at = now() where id = v.app_id;
    end if;
    perform private.market_log(case when ok then 'version_approved' else 'version_rejected' end, a.id, v.id, a.developer_id, p_note,
        jsonb_build_object('app_name', a.name, 'slug', a.slug, 'version', v.version, 'developer_name', a.developer_name,
                           'developer_email', (select email from auth.users where id = a.developer_id),
                           'scopes', v.manifest -> 'scopes', 'manifest', v.manifest, 'checks', v_checks));
    perform private.market_notify(a.developer_id, case when ok then 'version_approved' else 'version_rejected' end, a.id,
        case when ok then '«' || a.name || '» ' || v.version || ' одобрен' || case when a.status = 'suspended' then ' (коннектор снят с каталога)' else ' и опубликован в каталоге' end
             else '«' || a.name || '» ' || v.version || ' отклонён модератором' end, p_note);
end;
$$;

-- Снять коннектор с каталога (его кнопки и события останавливаются во всех Workspace) или вернуть.
create or replace function public.market_suspend(p_app uuid, p_suspend boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    a public.market_apps;
    off boolean := coalesce(p_suspend, false);
begin
    perform private.require_moderator();
    if off and char_length(btrim(coalesce(p_note, ''))) = 0 then
        raise exception 'Напишите, почему коннектор снимается с каталога.' using errcode = '22023';
    end if;
    update public.market_apps set
        status = case when off then 'suspended' when live_version_id is not null then 'listed' else 'draft' end,
        status_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
    where id = p_app returning * into a;
    if a.id is null then
        raise exception 'app not found' using errcode = 'P0002';
    end if;
    perform private.market_log(case when off then 'app_suspended' else 'app_restored' end, a.id, a.live_version_id, a.developer_id, p_note,
        jsonb_build_object('app_name', a.name, 'slug', a.slug, 'developer_name', a.developer_name,
                           'version', (select version from public.market_versions where id = a.live_version_id)));
    perform private.market_notify(a.developer_id, case when off then 'app_suspended' else 'app_restored' end, a.id,
        case when off then '«' || a.name || '» снят с каталога модератором' else '«' || a.name || '» снова в каталоге' end, p_note);
end;
$$;

-- Снятые с каталога: модератор видит их, чтобы вернуть.
create or replace function public.market_suspended()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    perform private.require_moderator();
    return (select coalesce(jsonb_agg(private.market_app_json(a, null) || jsonb_build_object('status_note', a.status_note)
                                      order by a.updated_at desc), '[]'::jsonb)
            from public.market_apps a where a.status = 'suspended');
end;
$$;

-- ------------------------------------------------------------------ журнал и модераторы

create or replace function public.market_audit_log(p_limit integer default 100, p_before bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    perform private.require_moderator();
    return (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'created_at', l.created_at, 'action', l.action,
                                                         'actor_email', au.email, 'subject_email', su.email, 'app_id', l.app_id,
                                                         'version_id', l.version_id, 'note', l.note, 'details', l.details)
                                      order by l.id desc), '[]'::jsonb)
            from (select * from private.market_audit
                  where p_before is null or id < p_before
                  order by id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) l
            left join auth.users au on au.id = l.actor_id
            left join auth.users su on su.id = l.subject_id);
end;
$$;

create or replace function public.market_moderators()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    perform private.require_moderator();
    return (select coalesce(jsonb_agg(jsonb_build_object('user_id', p.user_id, 'email', u.email, 'added_at', p.added_at,
                                                         'added_by_email', b.email, 'me', p.user_id = auth.uid())
                                      order by p.added_at), '[]'::jsonb)
            from private.platform_admins p
            left join auth.users u on u.id = p.user_id
            left join auth.users b on b.id = p.added_by);
end;
$$;

create or replace function public.market_moderator_add(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    target uuid;
begin
    perform private.require_moderator();
    select id into target from auth.users
    where lower(email) = lower(btrim(coalesce(p_email, ''))) and email_confirmed_at is not null and deleted_at is null;
    if target is null then
        raise exception 'Нет подтверждённой учётной записи с такой почтой.' using errcode = 'P0002';
    end if;
    insert into private.platform_admins (user_id, added_by) values (target, private.uid()) on conflict (user_id) do nothing;
    if found then
        perform private.market_log('moderator_added', null, null, target, null, jsonb_build_object('email', lower(btrim(p_email))));
    end if;
end;
$$;

create or replace function public.market_moderator_remove(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    gone text;
begin
    perform private.require_moderator();
    -- Блокировка списка: два модератора не уберут друг друга одновременно и не оставят платформу без модерации.
    lock table private.platform_admins in share row exclusive mode;
    if (select count(*) from private.platform_admins) <= 1 and exists (select 1 from private.platform_admins where user_id = p_user) then
        raise exception 'Нельзя убрать последнего модератора.' using errcode = '42501';
    end if;
    select u.email into gone from private.platform_admins p left join auth.users u on u.id = p.user_id where p.user_id = p_user;
    delete from private.platform_admins where user_id = p_user;
    if found then
        perform private.market_log('moderator_removed', null, null, p_user, null, jsonb_build_object('email', gone));
    end if;
end;
$$;

-- ------------------------------------------------------------------ уведомления разработчику

create or replace function public.market_notices()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
begin
    return jsonb_build_object(
        'unread', (select count(*) from private.market_notices where user_id = u and read_at is null),
        'items', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'app_id', n.app_id, 'title', n.title,
                                                               'note', n.note, 'created_at', n.created_at, 'read', n.read_at is not null)
                                            order by n.id desc), '[]'::jsonb)
                  from (select * from private.market_notices where user_id = u order by id desc limit 50) n));
end;
$$;

create or replace function public.market_notices_read()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    update private.market_notices set read_at = now() where user_id = private.uid() and read_at is null;
end;
$$;

-- ------------------------------------------------------------------ права на функции

revoke all on function private.market_host(text), private.market_same_site(text, text),
    private.market_check_item(text, text, boolean, text, text), private.market_checks(public.market_apps, jsonb, text),
    private.market_failures(jsonb), private.market_company_problem(jsonb), private.market_company_json(private.market_companies),
    private.market_log(text, uuid, uuid, uuid, text, jsonb), private.market_notify(uuid, text, uuid, text, text)
    from public, anon, authenticated;

revoke all on function public.market_company(), public.market_company_save(jsonb), public.market_company_queue(),
    public.market_company_review(uuid, boolean, text), public.market_submit(jsonb), public.market_my_apps(),
    public.market_review_queue(), public.market_review(uuid, boolean, text), public.market_suspend(uuid, boolean, text),
    public.market_suspended(), public.market_audit_log(integer, bigint), public.market_moderators(),
    public.market_moderator_add(text), public.market_moderator_remove(uuid), public.market_notices(), public.market_notices_read()
    from public, anon;
grant execute on function public.market_company(), public.market_company_save(jsonb), public.market_company_queue(),
    public.market_company_review(uuid, boolean, text), public.market_submit(jsonb), public.market_my_apps(),
    public.market_review_queue(), public.market_review(uuid, boolean, text), public.market_suspend(uuid, boolean, text),
    public.market_suspended(), public.market_audit_log(integer, bigint), public.market_moderators(),
    public.market_moderator_add(text), public.market_moderator_remove(uuid), public.market_notices(), public.market_notices_read()
    to authenticated;
