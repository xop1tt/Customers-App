-- Исправления прав по аудиту команды из 100 сотрудников (2026-11-21, ADR-094). Только create or replace,
-- новые функции, триггеры и политики; таблицы и столбцы не меняются. Повторное применение безопасно.
--
--  1. save_role не переписывает роль, ранг которой не ниже ранга вызывающего, и свою собственную роль
--     (раньше роль «Кадры» с рангом 50 могла понизить роль «Директор» с рангом 90 и удалить директора).
--  2. «Свои записи» (records.edit_own): ответственный и исполнитель; автор — только пока у записи нет другого
--     ответственного. Ответственный и исполнитель могут передать запись или задачу коллеге.
--  3. Значения своих полей и контакты сделки меняет тот, кто может менять саму карточку.
--  4. Записи о звонках и встречах удаляет только records.delete (автор их больше не стирает).
--  5. Блокировка Workspace в crm_apply берётся до записи в журнал конфликтов: курсор не теряет конфликты.
--  6. Конфликты личных коллекций видит только их участник; занятый id не раскрывает имя ограничения.
--  8. Уведомления: задача назначена, запись передана.
--  9. Удалённая учётная запись перестаёт быть ответственным: записи остаются «без ответственного».
-- 10. Экспорт облачного Workspace подтверждает сервер (records.export) и записывает в журнал действий.

-- ------------------------------------------------------------------ 1. save_role

create or replace function public.save_role(p_workspace uuid, p_key text, p_name text, p_rank int, p_permissions text[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
    mine int;
    existing public.roles;
    rid uuid;
    p text;
begin
    perform private.require_perm(p_workspace, 'roles.manage');
    mine := private.rank_of(p_workspace, u);
    if p_key in ('owner', 'admin', 'manager', 'employee', 'viewer', 'head_of_sales', 'team_lead') then
        raise exception 'system role keys are reserved' using errcode = '22023';
    end if;
    if p_rank is null or p_rank < 0 or p_rank >= mine then
        raise exception 'role rank must be below your own' using errcode = '42501';
    end if;
    select * into existing from public.roles where workspace_id = p_workspace and key = p_key for update;
    if existing.id is not null then
        -- Менять можно только роль ниже своей и не свою: иначе можно понизить роль начальника и затем удалить его.
        if existing.rank >= mine then
            raise exception 'cannot change a role at or above your own' using errcode = '42501';
        end if;
        if mine < 100 and exists (select 1 from public.workspace_members
                                  where workspace_id = p_workspace and user_id = u and role_id = existing.id) then
            raise exception 'cannot change your own role' using errcode = '42501';
        end if;
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
    insert into public.audit_log (workspace_id, actor_id, action, entity_type, entity_id, details)
    values (p_workspace, u, case when existing.id is null then 'role_create' else 'role_update' end, 'role', rid,
            jsonb_build_object('key', p_key, 'rank', p_rank, 'permissions', to_jsonb(coalesce(p_permissions, '{}'))));
    return rid;
end;
$$;
revoke all on function public.save_role(uuid, text, text, int, text[]) from public, anon;
grant execute on function public.save_role(uuid, text, text, int, text[]) to authenticated;

-- ------------------------------------------------------------------ 2–3. права на правку

create or replace function private.can_edit(p_workspace uuid, p_created_by uuid, p_owner uuid, p_assignee uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select private.has_perm(p_workspace, 'records.edit')
        or (private.has_perm(p_workspace, 'records.edit_own')
            and ((select auth.uid()) = p_owner
                 or (select auth.uid()) = p_assignee
                 or (p_owner is null and (select auth.uid()) = p_created_by)));
$$;
revoke all on function private.can_edit(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function private.can_edit(uuid, uuid, uuid, uuid) to authenticated;

-- Есть ли право менять записи вообще (новая строка после правки).
create or replace function private.can_write(p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select private.has_perm(p_workspace, 'records.edit') or private.has_perm(p_workspace, 'records.edit_own');
$$;
revoke all on function private.can_write(uuid) from public, anon;
grant execute on function private.can_write(uuid) to authenticated;

-- Может ли пользователь менять карточку (компанию, контакт, лид, сделку), к которой относится дочерняя запись.
create or replace function private.can_edit_entity(p_workspace uuid, p_type text, p_id uuid)
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
    if t is null or p_id is null then
        return false;
    end if;
    execute format('select to_jsonb(x) from public.%I x where x.id = $1 and x.workspace_id = $2', t)
        into r using p_id, p_workspace;
    if r is null then
        return false;
    end if;
    return private.can_edit(p_workspace, (r ->> 'created_by')::uuid, (r ->> 'owner_id')::uuid, (r ->> 'assignee_id')::uuid);
end;
$$;
revoke all on function private.can_edit_entity(uuid, text, uuid) from public, anon;
grant execute on function private.can_edit_entity(uuid, text, uuid) to authenticated;

create or replace function private.crm_attach(p_table text, p_kind text, p_fields text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
    has_owner boolean;
    has_assignee boolean;
    edit text;
begin
    insert into private.crm_entities (entity, kind, fields) values (p_table, p_kind, p_fields)
    on conflict (entity) do update set kind = excluded.kind, fields = excluded.fields;
    select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table
                   and column_name = 'owner_id') into has_owner;
    select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table
                   and column_name = 'assignee_id') into has_assignee;

    execute format('drop trigger if exists %I on public.%I', p_table || '_crm_stamp', p_table);
    execute format('create trigger %I before insert or update on public.%I for each row execute function private.crm_stamp()',
                   p_table || '_crm_stamp', p_table);
    execute format('drop trigger if exists %I on public.%I', p_table || '_crm_audit', p_table);
    execute format('create trigger %I after update on public.%I for each row execute function private.crm_audit()',
                   p_table || '_crm_audit', p_table);
    execute format('create index if not exists %I on public.%I (workspace_id, server_seq)', p_table || '_ws_seq', p_table);
    execute format('create index if not exists %I on public.%I (workspace_id, updated_at desc) where deleted_at is null',
                   p_table || '_ws_updated', p_table);

    execute format('alter table public.%I enable row level security', p_table);
    execute format('alter table public.%I force row level security', p_table);
    execute format('drop policy if exists %I on public.%I', p_table || '_select', p_table);
    execute format('drop policy if exists %I on public.%I', p_table || '_insert', p_table);
    execute format('drop policy if exists %I on public.%I', p_table || '_update', p_table);

    if p_kind = 'records' then
        edit := format('private.can_edit(workspace_id, created_by, %s, %s)',
                       case when has_owner then 'owner_id' else 'null' end,
                       case when has_assignee then 'assignee_id' else 'null' end);
        execute format('create policy %I on public.%I for select to authenticated using (private.has_perm(workspace_id, %L))',
                       p_table || '_select', p_table, 'records.view');
        execute format('create policy %I on public.%I for insert to authenticated with check (private.has_perm(workspace_id, %L))',
                       p_table || '_insert', p_table, 'records.create');
        -- using: какую строку можно менять (правило can_edit по старой строке). with check: новая строка
        -- остаётся в Workspace участника с правом правки — так ответственный может передать запись коллеге.
        execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)',
                       p_table || '_update', p_table, edit, 'private.can_write(workspace_id)');
    elsif p_kind = 'settings' then
        execute format('create policy %I on public.%I for select to authenticated using (private.has_perm(workspace_id, %L))',
                       p_table || '_select', p_table, 'records.view');
        execute format('create policy %I on public.%I for insert to authenticated with check (private.has_perm(workspace_id, %L))',
                       p_table || '_insert', p_table, 'pipelines.manage');
        execute format('create policy %I on public.%I for update to authenticated using (private.has_perm(workspace_id, %L)) with check (private.has_perm(workspace_id, %L))',
                       p_table || '_update', p_table, 'pipelines.manage', 'pipelines.manage');
    else  -- collections: личные видит и меняет автор, общие видят все, меняет автор или collections.manage
        execute format($p$create policy %I on public.%I for select to authenticated
            using (private.has_perm(workspace_id, 'records.view') and (visibility = 'workspace' or created_by = (select auth.uid())))$p$,
            p_table || '_select', p_table);
        execute format($p$create policy %I on public.%I for insert to authenticated
            with check (private.has_perm(workspace_id, 'records.view')
                        and (visibility = 'private' or private.has_perm(workspace_id, 'collections.manage')))$p$,
            p_table || '_insert', p_table);
        execute format($p$create policy %I on public.%I for update to authenticated
            using (private.has_perm(workspace_id, 'records.view')
                   and (created_by = (select auth.uid()) or (visibility = 'workspace' and private.has_perm(workspace_id, 'collections.manage'))))
            with check ((visibility = 'private' and created_by = (select auth.uid())) or private.has_perm(workspace_id, 'collections.manage'))$p$,
            p_table || '_update', p_table);
    end if;

    execute format('revoke all on public.%I from anon, public, authenticated', p_table);
    execute format('grant select, insert, update on public.%I to authenticated', p_table);
end;
$$;
revoke all on function private.crm_attach(text, text, text[]) from public, anon, authenticated;

-- Политики записей пересоздаются с новым правилом with check.
do $$
declare
    e record;
begin
    for e in select entity, kind, fields from private.crm_entities where kind = 'records' loop
        perform private.crm_attach(e.entity, e.kind, e.fields);
    end loop;
end;
$$;

-- Значения своих полей и контакты сделки — по правам карточки.
drop policy if exists custom_field_values_insert on public.custom_field_values;
create policy custom_field_values_insert on public.custom_field_values for insert to authenticated
    with check (private.has_perm(workspace_id, 'records.create')
                and private.can_edit_entity(workspace_id, entity_type, entity_id));
drop policy if exists custom_field_values_update on public.custom_field_values;
create policy custom_field_values_update on public.custom_field_values for update to authenticated
    using (private.can_edit_entity(workspace_id, entity_type, entity_id))
    with check (private.can_edit_entity(workspace_id, entity_type, entity_id));

drop policy if exists deal_contacts_insert on public.deal_contacts;
create policy deal_contacts_insert on public.deal_contacts for insert to authenticated
    with check (private.has_perm(workspace_id, 'records.create') and private.can_edit_entity(workspace_id, 'deal', deal_id));
drop policy if exists deal_contacts_update on public.deal_contacts;
create policy deal_contacts_update on public.deal_contacts for update to authenticated
    using (private.can_edit_entity(workspace_id, 'deal', deal_id))
    with check (private.can_edit_entity(workspace_id, 'deal', deal_id));

-- ------------------------------------------------------------------ 4. общий триггер (удаление)

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
              -- Свои заметки, комментарии и личные коллекции удаляет автор. Записи о звонках и встречах (activities)
              -- — нет: это история работы с клиентом (аудит 2026-11-21, п. 16).
              and not (tg_table_name in ('collections', 'notes', 'comments') and new.created_by = uid)
              -- Значения своих полей и контакты сделки — часть карточки: их убирает тот, кто может менять карточку.
              and not (tg_table_name = 'custom_field_values'
                       and private.can_edit_entity(new.workspace_id, n ->> 'entity_type', (n ->> 'entity_id')::uuid))
              and not (tg_table_name = 'deal_contacts'
                       and private.can_edit_entity(new.workspace_id, 'deal', (n ->> 'deal_id')::uuid)) then
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

-- ------------------------------------------------------------------ 5–6. crm_apply, конфликты

create or replace function private.crm_apply(p_workspace uuid, p_op jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    uid uuid := auth.uid();
    server_now timestamptz := now();
    entity text := p_op ->> 'entity';
    op_kind text := coalesce(p_op ->> 'kind', 'upsert');
    rid uuid := (p_op ->> 'id')::uuid;
    base bigint := coalesce((p_op ->> 'base_version')::bigint, 0);
    allowed text[];
    fields jsonb := '{}'::jsonb;
    norm jsonb;
    cur jsonb;
    f text;
    ts timestamptz;
    cur_ts timestamptz;
    applied jsonb := '{}'::jsonb;
    applied_ts jsonb := '{}'::jsonb;
    conflicts int := 0;
    cols text;
    sets text;
    n int;
    ver bigint;
begin
    -- Блокировка Workspace берётся до первой записи (в том числе в sync_conflicts): номер server_seq выдаётся
    -- только под ней, поэтому курсор загрузки не перескочит строку, которая ещё не зафиксирована (аудит, п. 12).
    perform pg_advisory_xact_lock(hashtextextended('crm:' || p_workspace::text, 0));
    select e.fields into allowed from private.crm_entities e where e.entity = p_op ->> 'entity';
    if allowed is null then
        return jsonb_build_object('status', 'rejected', 'error', 'unknown entity');
    end if;
    if rid is null then
        return jsonb_build_object('status', 'rejected', 'error', 'id is required');
    end if;
    if op_kind = 'delete' then
        fields := jsonb_build_object('deleted_at', coalesce(p_op -> 'ts' ->> 'deleted_at', server_now::text));
        p_op := jsonb_set(p_op, '{ts}', coalesce(p_op -> 'ts', '{}') || jsonb_build_object('deleted_at', fields ->> 'deleted_at'));
    elsif op_kind = 'restore' then
        fields := jsonb_build_object('deleted_at', null);
    elsif op_kind = 'upsert' then
        select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into fields
        from jsonb_each(coalesce(p_op -> 'fields', '{}'::jsonb)) as e(k, v) where k = any(allowed);
    else
        return jsonb_build_object('status', 'rejected', 'error', 'unknown kind');
    end if;
    -- Значения в виде, в котором их хранит таблица (время, массивы) — для честного сравнения.
    execute format('select to_jsonb(jsonb_populate_record(null::public.%I, $1))', entity) into norm using fields;

    execute format('select to_jsonb(t) from public.%I t where id = $1', entity) into cur using rid;
    if cur is null then
        if op_kind <> 'upsert' then
            return jsonb_build_object('status', 'rejected', 'error', 'not found');
        end if;
        select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(fields) as k;
        select coalesce(jsonb_object_agg(k, to_jsonb(least(coalesce((p_op -> 'ts' ->> k)::timestamptz, server_now), server_now))), '{}'::jsonb),
               coalesce(jsonb_object_agg(k, 1), '{}'::jsonb)
          into applied_ts, applied from jsonb_object_keys(fields) as k;
        begin
            execute format('insert into public.%I (id, workspace_id, created_by, field_ts, field_ver%s) '
                           'select $1, $2, $3, $4, $5%s from jsonb_populate_record(null::public.%I, $6) r',
                           entity, case when cols is null then '' else ', ' || cols end,
                           case when cols is null then '' else ', ' || (select string_agg('r.' || quote_ident(k), ', ')
                                                                         from jsonb_object_keys(fields) as k) end, entity)
                using rid, p_workspace, uid, applied_ts, applied, fields;
        exception when unique_violation then
            -- id занят записью, которую пользователь не видит (другой Workspace, чужая личная коллекция): ответ
            -- не называет ни таблицу, ни ограничение (аудит, п. 15).
            return jsonb_build_object('status', 'rejected', 'error', 'record already exists', 'code', '23505');
        end;
        return jsonb_build_object('status', 'applied', 'version', 1);
    end if;
    if (cur ->> 'workspace_id')::uuid is distinct from p_workspace then
        return jsonb_build_object('status', 'rejected', 'error', 'not found');
    end if;
    ver := (cur ->> 'version')::bigint;

    -- Правка удалённой записи её не воскрешает: изменение уходит в журнал конфликтов.
    if (cur ->> 'deleted_at') is not null and op_kind = 'upsert' and not (fields ? 'deleted_at') then
        insert into public.sync_conflicts (workspace_id, entity_type, entity_id, field, kept, lost, kept_by)
        values (p_workspace, entity, rid, '*deleted', cur -> 'deleted_at', fields, (cur ->> 'updated_by')::uuid);
        return jsonb_build_object('status', 'conflict', 'version', ver, 'error', 'record is deleted');
    end if;

    applied := '{}'::jsonb;
    for f in select jsonb_object_keys(fields) loop
        ts := least(coalesce((p_op -> 'ts' ->> f)::timestamptz, server_now), server_now);
        cur_ts := coalesce((cur -> 'field_ts' ->> f)::timestamptz, '-infinity'::timestamptz);
        if (norm -> f) is not distinct from (cur -> f) then
            continue;  -- то же значение: ничего не меняется
        end if;
        if ts > cur_ts then
            applied := applied || jsonb_build_object(f, norm -> f);
            applied_ts := applied_ts || jsonb_build_object(f, ts);
            -- Поле менялось после версии, на которой основана операция: проигравшее значение сохраняется.
            if base > 0 and coalesce((cur -> 'field_ver' ->> f)::bigint, 0) > base then
                insert into public.sync_conflicts (workspace_id, entity_type, entity_id, field, kept, lost, lost_by, kept_by)
                values (p_workspace, entity, rid, f, norm -> f, cur -> f, private.field_author(cur, f), uid);
                conflicts := conflicts + 1;
            end if;
        else
            insert into public.sync_conflicts (workspace_id, entity_type, entity_id, field, kept, lost, kept_by)
            values (p_workspace, entity, rid, f, cur -> f, norm -> f, private.field_author(cur, f));
            conflicts := conflicts + 1;
        end if;
    end loop;

    if applied = '{}'::jsonb then
        return jsonb_build_object('status', case when conflicts > 0 then 'conflict' else 'merged' end, 'version', ver);
    end if;
    select string_agg(format('%I = r.%I', k, k), ', ') into sets from jsonb_object_keys(applied) as k;
    execute format('update public.%I t set %s, field_ts = t.field_ts || $2, field_ver = t.field_ver || $3 '
                   'from jsonb_populate_record(null::public.%I, $1) r where t.id = $4', entity, sets, entity)
        using applied, applied_ts,
              (select jsonb_object_agg(k, ver + 1) from jsonb_object_keys(applied) as k), rid;
    get diagnostics n = row_count;
    if n = 0 then
        return jsonb_build_object('status', 'rejected', 'error', 'permission denied', 'code', '42501');
    end if;
    return jsonb_build_object('status', case when conflicts > 0 then 'conflict' else 'applied' end, 'version', ver + 1);
end;
$$;
revoke all on function private.crm_apply(uuid, jsonb) from public, anon;
grant execute on function private.crm_apply(uuid, jsonb) to authenticated;

drop policy if exists sync_conflicts_select on public.sync_conflicts;
create policy sync_conflicts_select on public.sync_conflicts for select to authenticated
    using (private.has_perm(workspace_id, 'records.view')
           and (entity_type <> 'collections' or lost_by = (select auth.uid()) or kept_by = (select auth.uid())));

-- ------------------------------------------------------------------ 8. уведомления о работе

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
    check (kind in ('mention', 'added_to_group', 'note_mention', 'comment_mention', 'task_assigned', 'record_assigned'));

-- Задача назначена или передана, клиент/сделка переданы: уведомление новому исполнителю или ответственному,
-- если это сделал другой человек. В тексте — название записи.
create or replace function private.notify_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    n jsonb := to_jsonb(new);
    o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
    col text := case when tg_table_name = 'tasks' then 'assignee_id' else 'owner_id' end;
    target uuid := (n ->> col)::uuid;
    actor uuid := coalesce(auth.uid(), new.updated_by, new.created_by);
    etype text;
    eid uuid;
    title text;
begin
    if target is null or target is not distinct from (o ->> col)::uuid or target = actor or new.deleted_at is not null then
        return null;
    end if;
    if tg_table_name = 'tasks' then
        etype := n ->> 'entity_type';
        eid := (n ->> 'entity_id')::uuid;
        title := n ->> 'title';
    else
        etype := case tg_table_name when 'companies' then 'company' when 'contacts' then 'contact'
                                    when 'crm_leads' then 'crm_lead' when 'deals' then 'deal' end;
        eid := new.id;
        title := coalesce(n ->> 'name', n ->> 'title', nullif(n ->> 'full_name', ''), '');
    end if;
    insert into public.notifications (workspace_id, user_id, kind, actor_id, entity_type, entity_id, excerpt)
    values (new.workspace_id, target, case when tg_table_name = 'tasks' then 'task_assigned' else 'record_assigned' end,
            actor, etype, eid, left(coalesce(title, ''), 300));
    return null;
end;
$$;
revoke all on function private.notify_assignment() from public, anon, authenticated;

create or replace trigger tasks_assignment after insert or update of assignee_id on public.tasks
    for each row execute function private.notify_assignment();
create or replace trigger companies_assignment after insert or update of owner_id on public.companies
    for each row execute function private.notify_assignment();
create or replace trigger contacts_assignment after insert or update of owner_id on public.contacts
    for each row execute function private.notify_assignment();
create or replace trigger crm_leads_assignment after insert or update of owner_id on public.crm_leads
    for each row execute function private.notify_assignment();
create or replace trigger deals_assignment after insert or update of owner_id on public.deals
    for each row execute function private.notify_assignment();

-- ------------------------------------------------------------------ 9. удалённая учётная запись

-- Строка участника удаляется вместе с учётной записью (on delete cascade). Записи, где он был ответственным
-- или исполнителем, остаются в Workspace без ответственного: их видно в фильтре «Без ответственного».
create or replace function private.release_deleted_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    t text;
begin
    if exists (select 1 from public.workspaces where id = old.workspace_id) then
        foreach t in array array['companies', 'contacts', 'crm_leads', 'deals'] loop
            execute format('update public.%I set owner_id = null, field_ts = field_ts || jsonb_build_object(''owner_id'', now()) '
                           'where workspace_id = $1 and owner_id = $2', t) using old.workspace_id, old.user_id;
        end loop;
        update public.tasks set assignee_id = null, field_ts = field_ts || jsonb_build_object('assignee_id', now())
        where workspace_id = old.workspace_id and assignee_id = old.user_id;
    end if;
    return null;
end;
$$;
revoke all on function private.release_deleted_member() from public, anon, authenticated;
create or replace trigger workspace_members_release after delete on public.workspace_members
    for each row execute function private.release_deleted_member();

-- ------------------------------------------------------------------ 10. экспорт

-- Приложение вызывает перед сохранением файла выгрузки облачного Workspace: без records.export файл не сохраняется,
-- каждая выгрузка видна в журнале действий (action = 'export').
create or replace function public.log_export(p_workspace uuid, p_entity text, p_count int, p_format text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.require_perm(p_workspace, 'records.export');
    if not exists (select 1 from private.crm_entities where entity = p_entity and kind = 'records') then
        raise exception 'unknown entity' using errcode = '22023';
    end if;
    if p_format is null or p_format not in ('csv', 'xlsx') or p_count is null or p_count < 0 then
        raise exception 'bad export' using errcode = '22023';
    end if;
    insert into public.audit_log (workspace_id, actor_id, action, entity_type, details)
    values (p_workspace, private.uid(), 'export', p_entity, jsonb_build_object('count', p_count, 'format', p_format));
end;
$$;
revoke all on function public.log_export(uuid, text, int, text) from public, anon;
grant execute on function public.log_export(uuid, text, int, text) to authenticated;
