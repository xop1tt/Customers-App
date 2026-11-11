-- A4. Исправления безопасности по аудиту 2026-11-11 (ADR-046). Миграция только добавляет объекты и заменяет
-- тела функций (create or replace); повторное применение безопасно.
--
-- S2 (SSRF): база больше не отправляет webhooks на адрес интеграции сама. private.market_deliver подписывает
--    событие как раньше и передаёт его Edge Function market-relay, которая проверяет, что все адреса имени
--    публичные, и отправляет POST без перенаправлений. Пока адрес функции не задан в private.market_relay,
--    события не отправляются никуда.
-- S6: Workspace, в котором не осталось активных участников (например, все удалили учётные записи), уже
--    помечается удалённым триггером workspace_members_owner; теперь через 30 дней ежедневная очистка удаляет его
--    вместе со всеми данными (решение Maksim 2026-11-11).

-- ------------------------------------------------------------------ S2: доставка через market-relay

create table if not exists private.market_relay (
    id int primary key default 1 check (id = 1),
    url text check (url is null or url ~ '^https?://[^\s]+/functions/v1/market-relay$'),
    secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
revoke all on private.market_relay from public, anon, authenticated;
insert into private.market_relay (id) values (1) on conflict (id) do nothing;

create or replace function private.market_deliver(p_workspace uuid, p_app uuid, p_url text, p_secret text, p_event text, p_body jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    body jsonb := p_body || jsonb_build_object('event', p_event, 'workspace_id', p_workspace, 'app_id', p_app, 'sent_at', now());
    relay private.market_relay;
    sig text;
    req bigint;
begin
    if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
       or to_regprocedure('extensions.hmac(bytea,bytea,text)') is null then
        return;
    end if;
    select * into relay from private.market_relay where id = 1;
    if relay.url is null or not private.market_url_ok(p_url) then
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
        -- Подписанное тело передаётся строкой: market-relay отправляет его байт в байт.
        execute 'select net.http_post(url => $1, body => $2, headers => $3, timeout_milliseconds => 10000)'
            into req using relay.url,
                 jsonb_build_object('url', p_url, 'event', p_event, 'signature', 'sha256=' || sig, 'payload', body::text),
                 jsonb_build_object('Content-Type', 'application/json', 'x-relay-secret', relay.secret);
        insert into private.market_deliveries (workspace_id, app_id, event, request_id) values (p_workspace, p_app, p_event, req);
    exception when others then
        null; -- сбой отправки не мешает работе с CRM
    end;
end;
$$;
revoke all on function private.market_deliver(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------ S6: Workspace без участников

create or replace function private.purge_orphan_workspaces()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
    w record;
    total int := 0;
begin
    for w in select ws.id from public.workspaces ws
             where ws.deleted_at < now() - interval '30 days'
               and not exists (select 1 from public.workspace_members m
                               where m.workspace_id = ws.id and m.status = 'active')
             order by ws.deleted_at
             limit 200 loop
        -- Сначала участники обсуждений: их триггер пишет в журнал аудита, пока Workspace ещё существует.
        delete from public.chat_participants p using public.chat_conversations c
            where c.id = p.conversation_id and c.workspace_id = w.id;
        delete from public.workspaces where id = w.id;
        total := total + 1;
    end loop;
    return total;
end;
$$;
revoke all on function private.purge_orphan_workspaces() from public, anon, authenticated;

-- Ежедневная очистка (A3) теперь удаляет и такие Workspace.
create or replace function private.platform_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    crm jsonb;
    orphans int;
    deliveries int;
    notices int;
    presence int;
    mail int := 0;
    n int;
    res jsonb;
begin
    orphans := private.purge_orphan_workspaces();
    crm := private.crm_maintenance(null);

    delete from private.market_deliveries where created_at < now() - interval '30 days';
    get diagnostics deliveries = row_count;

    delete from public.notifications where created_at < now() - interval '90 days';
    get diagnostics notices = row_count;

    delete from public.workspace_presence where seen_at < now() - interval '1 day';
    get diagnostics presence = row_count;

    delete from private.email_requests where created_at < now() - interval '8 days';
    get diagnostics n = row_count;
    mail := mail + n;
    delete from private.email_tickets where created_at < now() - interval '8 days';
    get diagnostics n = row_count;
    mail := mail + n;
    delete from private.email_sends where created_at < now() - interval '8 days';
    get diagnostics n = row_count;
    mail := mail + n;

    delete from private.maintenance_runs where at < now() - interval '400 days';

    res := crm || jsonb_build_object('deliveries', deliveries, 'notifications', notices,
                                     'presence', presence, 'mail_logs', mail, 'workspaces', orphans);
    insert into private.maintenance_runs (result) values (res);
    return res;
end;
$$;
revoke all on function private.platform_maintenance() from public, anon, authenticated;
