-- Исправления аудита безопасности 2026-11-22 (ADR-099). Видимость записей по области роли и отделу (ADR-096)
-- обходилась двумя путями, которые проверяли только право records.view:
--
-- 1. Журнал конфликтов public.sync_conflicts хранит значения полей (kept/lost) любой записи. Сотрудник с областью
--    «свой отдел» или «только свои» читал прямым запросом GET /rest/v1/sync_conflicts названия, суммы и другие
--    поля скрытых от него сделок и компаний. Теперь строка журнала видна, только если видна сама запись.
-- 2. Карточки CRM во вложениях чата: private.chat_attachment_view показывала название и сумму любой записи
--    Workspace, а private.chat_attachments позволяла прикрепить невидимую запись (и проверить, существует ли id).
--
-- Миграция только заменяет политику и тела функций; повторное применение безопасно. Новых таблиц, столбцов и
-- RPC нет, прежние версии приложения работают как раньше (скрытые строки журнала им просто не приходят).

-- ------------------------------------------------------------------ 1. журнал конфликтов

-- Видит ли текущий пользователь строку CRM-таблицы. SECURITY INVOKER: запрос идёт под правами пользователя,
-- поэтому действуют те же политики RLS, что и при обычном чтении таблицы (область роли, отдел, личные коллекции).
-- Таблица берётся только из реестра private.crm_entities.
create or replace function private.row_visible(p_table text, p_id uuid)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
    ok boolean;
begin
    if p_id is null or not exists (select 1 from private.crm_entities e where e.entity = p_table) then
        return false;
    end if;
    execute format('select exists (select 1 from public.%I x where x.id = $1)', p_table) into ok using p_id;
    return coalesce(ok, false);
end;
$$;
revoke all on function private.row_visible(text, uuid) from public, anon;
grant execute on function private.row_visible(text, uuid) to authenticated;

drop policy if exists sync_conflicts_select on public.sync_conflicts;
create policy sync_conflicts_select on public.sync_conflicts for select to authenticated
    using (private.has_perm(workspace_id, 'records.view')
           and (entity_type <> 'collections' or lost_by = (select auth.uid()) or kept_by = (select auth.uid()))
           and private.row_visible(entity_type, entity_id));

-- ------------------------------------------------------------------ 2. карточки CRM в чате

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
        -- Прикрепить можно только запись, которую автор видит сам (ADR-096): иначе по ответу можно было бы
        -- проверять, существует ли скрытая запись, и показывать её название участникам обсуждения.
        if not v_ok or private.can_see_entity(p_workspace, v_type, v_id) is not true then
            raise exception 'attachment not found in this workspace' using errcode = '23503';
        end if;
        if not out @> jsonb_build_array(jsonb_build_object('type', v_type, 'id', v_id)) then
            out := out || jsonb_build_array(jsonb_build_object('type', v_type, 'id', v_id));
        end if;
    end loop;
    return out;
end;
$$;

create or replace function private.chat_attachment_view(p_workspace uuid, p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    item jsonb;
    can_view boolean;
    v_id uuid;
    v_title text;
    v_sub text;
    out jsonb := '[]'::jsonb;
begin
    for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
        v_id := (item ->> 'id')::uuid;
        v_title := null;
        v_sub := null;
        -- Название и подпись — только если читатель видит саму запись (область роли и отдел, ADR-096).
        can_view := coalesce(private.can_see_entity(p_workspace, item ->> 'type', v_id), false);
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

-- Как и раньше, функции вызываются только из chat_post / chat_edit / chat_messages.
revoke all on function private.chat_attachments(uuid, jsonb), private.chat_attachment_view(uuid, jsonb)
    from public, anon, authenticated;
