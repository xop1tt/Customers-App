-- Масштаб на команду до 100 человек (2026-11-22, ADR-097, аудит «100 сотрудников», пакет 4). Только добавления,
-- повторное применение безопасно.
--   1. Индексы на внешние ключи, о которых сообщает советник Supabase (удаление Workspace, участника, отдела,
--      этапа воронки и выборки по ним не читают таблицы целиком).
--   2. Содержимое вложения видно только тем, кто видит само вложение (видимость отделов, ADR-096); файл
--      загружается только в тот Workspace, где лежит вложение.
--   3. «Толчок» Realtime об изменениях CRM: после выгрузки изменений коллеги, у которых сейчас открыто
--      приложение в этом Workspace, сразу забирают изменения обычной синхронизацией. В толчке нет содержимого.

-- ------------------------------------------------------------------ 1. индексы внешних ключей

create index if not exists attachment_blobs_workspace_id on public.attachment_blobs (workspace_id);
create index if not exists chat_conversations_created_by on public.chat_conversations (created_by);
create index if not exists chat_messages_workspace_id on public.chat_messages (workspace_id);
create index if not exists chat_participants_added_by on public.chat_participants (added_by);
create index if not exists collection_user_prefs_workspace_id on public.collection_user_prefs (workspace_id);
create index if not exists comments_parent_id on public.comments (parent_id);
create index if not exists companies_department_id on public.companies (department_id);
create index if not exists contacts_department_id on public.contacts (department_id);
create index if not exists crm_leads_converted_company_id on public.crm_leads (converted_company_id);
create index if not exists crm_leads_converted_contact_id on public.crm_leads (converted_contact_id);
create index if not exists crm_leads_department_id on public.crm_leads (department_id);
create index if not exists custom_field_values_field_id on public.custom_field_values (field_id);
create index if not exists deal_contacts_contact_id on public.deal_contacts (contact_id);
create index if not exists deal_stage_history_from_stage_id on public.deal_stage_history (from_stage_id);
create index if not exists deal_stage_history_to_stage_id on public.deal_stage_history (to_stage_id);
create index if not exists deals_company_id on public.deals (company_id);
create index if not exists deals_department_id on public.deals (department_id);
create index if not exists deals_pipeline_id on public.deals (pipeline_id);
create index if not exists deals_stage_id on public.deals (stage_id);
create index if not exists departments_created_by on public.departments (created_by);
create index if not exists departments_head_id on public.departments (head_id);
create index if not exists departments_parent_id on public.departments (parent_id);
create index if not exists market_apps_developer_id on public.market_apps (developer_id);
create index if not exists market_apps_live_version_id on public.market_apps (live_version_id);
create index if not exists market_installs_app_id on public.market_installs (app_id);
create index if not exists market_installs_installed_by on public.market_installs (installed_by);
create index if not exists market_installs_version_id on public.market_installs (version_id);
create index if not exists market_versions_reviewed_by on public.market_versions (reviewed_by);
create index if not exists member_profiles_department_id on public.member_profiles (department_id);
create index if not exists member_profiles_manager_id on public.member_profiles (manager_id);
create index if not exists member_profiles_updated_by on public.member_profiles (updated_by);
create index if not exists member_profiles_user_id on public.member_profiles (user_id);
create index if not exists notifications_actor_id on public.notifications (actor_id);
create index if not exists notifications_conversation_id on public.notifications (conversation_id);
create index if not exists notifications_message_id on public.notifications (message_id);
create index if not exists notifications_workspace_id on public.notifications (workspace_id);
create index if not exists role_permissions_permission_key on public.role_permissions (permission_key);
create index if not exists role_scopes_role_id on public.role_scopes (role_id);
create index if not exists sync_ops_workspace_id on public.sync_ops (workspace_id);
create index if not exists tasks_department_id on public.tasks (department_id);
create index if not exists workspace_invitations_accepted_by on public.workspace_invitations (accepted_by);
create index if not exists workspace_invitations_invited_by on public.workspace_invitations (invited_by);
create index if not exists workspace_invitations_role_id on public.workspace_invitations (role_id);
create index if not exists workspace_members_invited_by on public.workspace_members (invited_by);
create index if not exists workspace_members_role_id on public.workspace_members (role_id);
create index if not exists workspace_presence_user_id on public.workspace_presence (user_id);

-- ------------------------------------------------------------------ 2. содержимое вложений

-- Видимость содержимого — как у вложения: select из attachments проходит его RLS (карточка, отдел, роль).
drop policy if exists attachment_blobs_select on public.attachment_blobs;
create policy attachment_blobs_select on public.attachment_blobs for select to authenticated
    using (exists (select 1 from public.attachments a where a.id = attachment_id and a.workspace_id = attachment_blobs.workspace_id));

-- Раньше условие сравнивало workspace_id вложения само с собой: файл можно было записать с чужим workspace_id.
drop policy if exists attachment_blobs_insert on public.attachment_blobs;
create policy attachment_blobs_insert on public.attachment_blobs for insert to authenticated
    with check (private.has_perm(workspace_id, 'records.create')
                and exists (select 1 from public.attachments a
                            where a.id = attachment_id and a.workspace_id = attachment_blobs.workspace_id
                              and a.created_by = (select auth.uid())));

-- ------------------------------------------------------------------ 3. толчок об изменениях CRM

-- Один толчок на транзакцию crm_push (флаг транзакции), только если изменение принято, только тем
-- участникам, у кого приложение открыто в этом Workspace (опрос чата обновляет присутствие раз в 15 с), кроме автора.
-- Без Realtime на сервере (локальный стенд) live_push ничего не делает; сбой никогда не мешает записи.
create or replace function private.crm_live_nudge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    flag text := 'customers.crm_nudged_' || replace(new.workspace_id::text, '-', '');
begin
    if new.result ->> 'status' is distinct from 'applied' then
        return null;
    end if;
    if coalesce(current_setting(flag, true), '') = '1' then
        return null;
    end if;
    perform set_config(flag, '1', true);
    perform private.live_push(
        array(select pr.user_id from public.workspace_presence pr
              join public.workspace_members m on m.workspace_id = pr.workspace_id and m.user_id = pr.user_id and m.status = 'active'
              where pr.workspace_id = new.workspace_id and pr.seen_at > now() - interval '2 minutes'
                and pr.user_id is distinct from new.user_id),
        'crm',
        jsonb_build_object('workspace_id', new.workspace_id));
    return null;
exception when others then
    return null;
end;
$$;
revoke all on function private.crm_live_nudge() from public, anon, authenticated;

drop trigger if exists sync_ops_live_nudge on public.sync_ops;
create trigger sync_ops_live_nudge after insert on public.sync_ops
    for each row execute function private.crm_live_nudge();

-- ------------------------------------------------------------------ 4. место под вложения

-- Решение Maksim: 300 МБ файлов на Workspace (бесплатный тариф Supabase не переполнится). Считаются файлы
-- живых вложений: удалённое в корзину вложение место освобождает сразу. Докупленное место (разовый платёж,
-- отдельная работа) — `extra_bytes`; пишет его только сервер, клиентам таблица недоступна.
create table if not exists private.attachment_quota (
    workspace_id uuid primary key references public.workspaces (id) on delete cascade,
    extra_bytes bigint not null default 0 check (extra_bytes >= 0),
    updated_at timestamptz not null default now()
);
revoke all on private.attachment_quota from public, anon, authenticated;

create or replace function private.attachment_limit(p_workspace uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
    select 314572800 + coalesce((select q.extra_bytes from private.attachment_quota q where q.workspace_id = p_workspace), 0)
$$;

create or replace function private.attachment_used(p_workspace uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
    select coalesce(sum(a.size), 0)::bigint
    from public.attachments a
    where a.workspace_id = p_workspace and a.deleted_at is null
      and exists (select 1 from public.attachment_blobs b where b.attachment_id = a.id)
$$;
revoke all on function private.attachment_limit(uuid), private.attachment_used(uuid) from public, anon, authenticated;

-- Перед записью файла: размер совпадает с объявленным во вложении (base64 длиннее на треть), и место есть.
create or replace function private.attachment_blob_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    a public.attachments;
begin
    perform pg_advisory_xact_lock(hashtextextended('att:' || new.workspace_id::text, 0));
    select * into a from public.attachments x where x.id = new.attachment_id;
    if a.id is null or a.size is null or char_length(new.data) > ceil(a.size * 4 / 3.0) + 4 then
        raise exception 'attachment size mismatch' using errcode = '22023';
    end if;
    if private.attachment_used(new.workspace_id) + a.size > private.attachment_limit(new.workspace_id) then
        raise exception 'attachment quota exceeded' using errcode = '53400',
            detail = format('used %s of %s bytes', private.attachment_used(new.workspace_id), private.attachment_limit(new.workspace_id));
    end if;
    return new;
end;
$$;
revoke all on function private.attachment_blob_quota() from public, anon, authenticated;

drop trigger if exists attachment_blobs_quota on public.attachment_blobs;
create trigger attachment_blobs_quota before insert on public.attachment_blobs
    for each row execute function private.attachment_blob_quota();

-- Сколько места занято и сколько всего: приложение предупреждает до загрузки файла.
create or replace function public.attachment_usage(p_workspace uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not private.is_member(p_workspace) then
        raise exception 'not a member' using errcode = '42501';
    end if;
    return jsonb_build_object('used', private.attachment_used(p_workspace), 'limit', private.attachment_limit(p_workspace));
end;
$$;
revoke all on function public.attachment_usage(uuid) from public, anon;
grant execute on function public.attachment_usage(uuid) to authenticated;
