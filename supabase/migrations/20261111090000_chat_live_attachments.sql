-- Чат: Realtime без задержек, карточки CRM во вложениях сообщений, защита.
--
-- Realtime. Каждый пользователь слушает свой закрытый канал «user:<uuid>». Триггеры шлют туда
-- только «толчок» (Workspace, обсуждение, номер), без текста и без данных карточек: содержимое
-- приложение забирает обычными функциями с проверкой прав. Вход в канал проверяет политика RLS на
-- realtime.messages: открыть можно только свой канал. Если Realtime на сервере нет (локальный стенд,
-- CI), всё ниже работает как раньше, а приложение остаётся на опросе.
--
-- Вложения. Сообщение может ссылаться на до 10 карточек того же Workspace (компания, контакт, лид,
-- сделка). Ссылку проверяет сервер: запись из этого Workspace, не удалена, а у автора есть право
-- просмотра. Название и подпись карточки каждый получатель видит только при своём праве просмотра:
-- без него — «Нет доступа».

-- ------------------------------------------------------------------ вложения

alter table public.chat_messages add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.chat_messages drop constraint if exists chat_messages_attachments_check;
alter table public.chat_messages add constraint chat_messages_attachments_check
    check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 10);
-- Сообщение из одних карточек: текст может быть пустым, если есть вложение.
alter table public.chat_messages drop constraint if exists chat_messages_body_check;
alter table public.chat_messages add constraint chat_messages_body_check
    check (char_length(body) <= 4000 and (char_length(body) >= 1 or jsonb_array_length(attachments) > 0));

-- Проверка вложений автора: [{type, id}] → нормализованный список без повторов.
create or replace function private.chat_attachments(p_workspace uuid, p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    item jsonb;
    v_type text;
    v_id uuid;
    v_table text;
    v_ok boolean;
    out jsonb := '[]'::jsonb;
begin
    if p_items is null or p_items = 'null'::jsonb then
        return out;
    end if;
    if jsonb_typeof(p_items) <> 'array' then
        raise exception 'attachments must be an array' using errcode = '22023';
    end if;
    if jsonb_array_length(p_items) > 10 then
        raise exception 'at most 10 attachments' using errcode = '22023';
    end if;
    if jsonb_array_length(p_items) > 0 and not private.has_perm(p_workspace, 'records.view') then
        raise exception 'permission denied: records.view' using errcode = '42501';
    end if;
    for item in select * from jsonb_array_elements(p_items) loop
        v_type := item ->> 'type';
        v_table := private.entity_table(v_type);
        if v_table is null then
            raise exception 'unknown attachment type' using errcode = '22023';
        end if;
        begin
            v_id := (item ->> 'id')::uuid;
        exception when others then
            raise exception 'bad attachment id' using errcode = '22023';
        end;
        execute format('select exists (select 1 from public.%I where id = $1 and workspace_id = $2 and deleted_at is null)', v_table)
            into v_ok using v_id, p_workspace;
        if not v_ok then
            raise exception 'attachment not found in this workspace' using errcode = '23503';
        end if;
        if not out @> jsonb_build_array(jsonb_build_object('type', v_type, 'id', v_id)) then
            out := out || jsonb_build_array(jsonb_build_object('type', v_type, 'id', v_id));
        end if;
    end loop;
    return out;
end;
$$;

-- Вложения глазами текущего пользователя: название и подпись только при праве просмотра.
create or replace function private.chat_attachment_view(p_workspace uuid, p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    item jsonb;
    can_view boolean := private.has_perm(p_workspace, 'records.view');
    v_id uuid;
    v_title text;
    v_sub text;
    out jsonb := '[]'::jsonb;
begin
    for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
        v_id := (item ->> 'id')::uuid;
        v_title := null;
        v_sub := null;
        if can_view then
            case item ->> 'type'
                when 'company' then
                    select x.name, coalesce(x.legal_name, '') into v_title, v_sub from public.companies x
                    where x.id = v_id and x.workspace_id = p_workspace and x.deleted_at is null;
                when 'contact' then
                    select x.full_name, concat_ws(' · ', nullif(x.position, ''), co.name) into v_title, v_sub
                    from public.contacts x left join public.companies co on co.id = x.company_id and co.deleted_at is null
                    where x.id = v_id and x.workspace_id = p_workspace and x.deleted_at is null;
                when 'crm_lead' then
                    select x.title, concat_ws(' · ', nullif(x.person_name, ''), nullif(x.company_name, '')) into v_title, v_sub
                    from public.crm_leads x where x.id = v_id and x.workspace_id = p_workspace and x.deleted_at is null;
                when 'deal' then
                    select x.title, trim(to_char(x.amount, 'FM999G999G999G990D00')) || ' ' || x.currency into v_title, v_sub
                    from public.deals x where x.id = v_id and x.workspace_id = p_workspace and x.deleted_at is null;
                else null;
            end case;
        end if;
        out := out || jsonb_build_array(jsonb_build_object(
            'type', item ->> 'type', 'id', v_id, 'title', coalesce(v_title, ''), 'subtitle', coalesce(v_sub, ''),
            'available', v_title is not null));
    end loop;
    return out;
end;
$$;

create or replace function private.chat_message_json(m public.chat_messages)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    select jsonb_build_object('id', m.id, 'seq', m.seq, 'author_id', m.author_id, 'kind', m.kind,
                              'body', case when m.deleted_at is null then m.body else '' end,
                              'mentions', m.mentions, 'created_at', m.created_at, 'edited_at', m.edited_at,
                              'deleted', m.deleted_at is not null,
                              'attachments', case when m.deleted_at is null
                                                  then private.chat_attachment_view(m.workspace_id, m.attachments)
                                                  else '[]'::jsonb end);
$$;

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
        select private.chat_message_json(m) as x
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

-- Отправка с карточками. Новое имя, а не новая версия chat_send: у PostgREST не должно быть двух функций
-- с одним именем, а удалять функции миграциям нельзя. Прежняя chat_send остаётся для старых версий приложения.
create or replace function public.chat_post(p_conversation uuid, p_body text default '', p_mentions uuid[] default '{}',
                                            p_attachments jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    c public.chat_conversations := private.chat_require(p_conversation);
    v_body text := btrim(coalesce(p_body, ''));
    v_files jsonb := private.chat_attachments(c.workspace_id, p_attachments);
    v_mentions uuid[];
    msg public.chat_messages;
begin
    if char_length(v_body) > 4000 or (char_length(v_body) = 0 and jsonb_array_length(v_files) = 0) then
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
    insert into public.chat_messages (conversation_id, workspace_id, author_id, kind, body, mentions, attachments)
    values (c.id, c.workspace_id, u, 'text', v_body, v_mentions, v_files) returning * into msg;
    update public.chat_conversations set last_message_at = msg.created_at where id = c.id;
    update public.chat_participants set last_read_seq = greatest(last_read_seq, msg.seq) where conversation_id = c.id and user_id = u;
    if c.kind = 'group' and v_body <> '' then
        insert into public.notifications (workspace_id, user_id, kind, actor_id, conversation_id, message_id, excerpt)
        select c.workspace_id, x, 'mention', u, c.id, msg.id, left(v_body, 300) from unnest(v_mentions) x;
    end if;
    return private.chat_message_json(msg);
end;
$$;

-- Изменить своё сообщение: текст меняется, вложения остаются.
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
    if char_length(v_body) > 4000 or (char_length(v_body) = 0 and jsonb_array_length(m.attachments) = 0) then
        raise exception 'message is 1 to 4000 characters' using errcode = '22023';
    end if;
    update public.chat_messages set body = v_body, edited_at = now() where id = m.id returning * into m;
    return private.chat_message_json(m);
end;
$$;

-- Удаление стирает и ссылки на карточки.
create or replace function private.chat_forget_attachments()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.deleted_at is not null and old.deleted_at is null then
        new.attachments := '[]'::jsonb;
        if new.body = '' then
            new.body := '—';
        end if;
    end if;
    return new;
end;
$$;
create or replace trigger chat_messages_forget before update of deleted_at on public.chat_messages
    for each row execute function private.chat_forget_attachments();

-- ------------------------------------------------------------------ журнал модерации

-- Чужое сообщение удалено или участника убрали из обсуждения — запись в журнал Workspace (без текста).
create or replace function private.chat_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    actor uuid := (select auth.uid());
begin
    if tg_table_name = 'chat_messages' then
        if new.deleted_at is not null and old.deleted_at is null and actor is distinct from old.author_id then
            insert into public.audit_log (workspace_id, actor_id, action, entity_type, entity_id, details)
            values (old.workspace_id, actor, 'chat.message_deleted', 'chat_message', old.id,
                    jsonb_build_object('conversation_id', old.conversation_id, 'author_id', old.author_id));
        end if;
        return null;
    end if;
    if actor is distinct from old.user_id then
        insert into public.audit_log (workspace_id, actor_id, action, entity_type, entity_id, details)
        select c.workspace_id, actor, 'chat.member_removed', 'chat_conversation', c.id, jsonb_build_object('user_id', old.user_id)
        from public.chat_conversations c where c.id = old.conversation_id;
    end if;
    return null;
end;
$$;
create or replace trigger chat_messages_audit after update of deleted_at on public.chat_messages
    for each row execute function private.chat_audit();
create or replace trigger chat_participants_audit after delete on public.chat_participants
    for each row execute function private.chat_audit();

-- ------------------------------------------------------------------ Realtime

-- Отправить «толчок» в личные каналы. Сбой Realtime никогда не мешает сообщению сохраниться.
create or replace function private.live_push(p_users uuid[], p_event text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    x uuid;
begin
    if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
        return;
    end if;
    foreach x in array coalesce(p_users, '{}') loop
        begin
            execute 'select realtime.send($1, $2, $3, true)' using p_payload, p_event, 'user:' || x::text;
        exception when others then
            null;
        end;
    end loop;
end;
$$;

create or replace function private.live_chat_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.live_push(
        (select array_agg(p.user_id) from public.chat_participants p where p.conversation_id = new.conversation_id),
        'chat', jsonb_build_object('workspace_id', new.workspace_id, 'conversation_id', new.conversation_id, 'seq', new.seq));
    return null;
end;
$$;
create or replace trigger chat_messages_live after insert or update on public.chat_messages
    for each row execute function private.live_chat_message();

-- Состав и настройки обсуждения: новый участник сразу видит обсуждение, удалённый — перестаёт.
create or replace function private.live_chat_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    conv uuid := coalesce(new.conversation_id, old.conversation_id);
    ws uuid := (select workspace_id from public.chat_conversations where id = conv);
begin
    perform private.live_push(
        array(select p.user_id from public.chat_participants p where p.conversation_id = conv
              union select coalesce(new.user_id, old.user_id)),
        'chat', jsonb_build_object('workspace_id', ws, 'conversation_id', conv));
    return null;
end;
$$;
create or replace trigger chat_participants_live after insert or delete or update of role on public.chat_participants
    for each row execute function private.live_chat_members();

create or replace function private.live_chat_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.title is distinct from old.title or new.members_can_add is distinct from old.members_can_add then
        perform private.live_push(
            (select array_agg(p.user_id) from public.chat_participants p where p.conversation_id = new.id),
            'chat', jsonb_build_object('workspace_id', new.workspace_id, 'conversation_id', new.id));
    end if;
    return null;
end;
$$;
create or replace trigger chat_conversations_live after update on public.chat_conversations
    for each row execute function private.live_chat_conversation();

create or replace function private.live_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.live_push(array[new.user_id], 'notify', jsonb_build_object('workspace_id', new.workspace_id, 'seq', new.seq));
    return null;
end;
$$;
create or replace trigger notifications_live after insert on public.notifications
    for each row execute function private.live_notification();

-- Вход в канал: только в свой «user:<uuid>» и только для событий broadcast.
do $$
begin
    if to_regclass('realtime.messages') is not null and to_regprocedure('realtime.topic()') is not null then
        execute 'drop policy if exists customers_own_user_channel on realtime.messages';
        execute $p$create policy customers_own_user_channel on realtime.messages for select to authenticated
                   using (realtime.topic() = 'user:' || (select auth.uid())::text and extension = 'broadcast')$p$;
    end if;
end;
$$;

-- ------------------------------------------------------------------ права на функции

revoke all on function private.chat_attachments(uuid, jsonb), private.chat_attachment_view(uuid, jsonb),
    private.chat_message_json(public.chat_messages), private.live_push(uuid[], text, jsonb),
    private.live_chat_message(), private.live_chat_members(), private.live_chat_conversation(),
    private.live_notification(), private.chat_forget_attachments(), private.chat_audit() from public, anon, authenticated;
revoke all on function public.chat_post(uuid, text, uuid[], jsonb), public.chat_edit(uuid, text),
    public.chat_messages(uuid, bigint, bigint, int, boolean) from public, anon;
grant execute on function public.chat_post(uuid, text, uuid[], jsonb), public.chat_edit(uuid, text),
    public.chat_messages(uuid, bigint, bigint, int, boolean) to authenticated;
