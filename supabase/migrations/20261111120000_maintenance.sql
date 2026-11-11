-- A3. Фоновое обслуживание: база не растёт без предела.
-- Раз в сутки (GitHub Actions → Edge Function maintenance → public.platform_maintenance) удаляются:
--   * журнал синхронизации sync_ops старше 30 дней и надгробия CRM старше 90 дней (private.crm_maintenance);
--   * журнал доставок маркетплейса старше 30 дней;
--   * уведомления старше 90 дней (то же правило, что уже применяет chat_poll для читающего);
--   * отметки присутствия старше 1 дня;
--   * служебные журналы почты старше 8 дней (то же правило, что в purge_unconfirmed).
-- Журнал аудита и конфликты синхронизации не удаляются. Каждый запуск записывается в private.maintenance_runs.
-- Миграция только добавляет объекты и безопасна при повторном применении.

create table if not exists private.maintenance_runs (
    id bigserial primary key,
    at timestamptz not null default now(),
    result jsonb not null
);
revoke all on private.maintenance_runs from public, anon, authenticated;

create or replace function private.platform_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    crm jsonb;
    deliveries int;
    notices int;
    presence int;
    mail int := 0;
    n int;
    res jsonb;
begin
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
                                     'presence', presence, 'mail_logs', mail);
    insert into private.maintenance_runs (result) values (res);
    return res;
end;
$$;
revoke all on function private.platform_maintenance() from public, anon, authenticated;

-- Вызывает только Edge Function maintenance (ключ service_role); пользователям и anon недоступна.
create or replace function public.platform_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
    return private.platform_maintenance();
end;
$$;
revoke all on function public.platform_maintenance() from public, anon, authenticated;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant execute on function public.platform_maintenance() to service_role;
    end if;
end;
$$;
