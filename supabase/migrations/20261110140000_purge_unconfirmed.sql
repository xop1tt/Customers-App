-- Автоочистка неподтверждённых регистраций.
-- Кто зарегистрировался, но не ввёл код из письма, через `unconfirmed_ttl` (по умолчанию 24 часа) удаляется из
-- auth.users вместе с хвостами в связанных таблицах, поэтому база не засоряется чужими и ошибочными адресами.
-- Подтверждённые и когда-либо входившие аккаунты не затрагиваются. Срок меняется SQL-запросом:
--   update private.email_limits set unconfirmed_ttl = interval '6 hours';
-- Очистка вызывается вместе с очисткой журналов писем (при каждом запросе письма из приложения), cron не нужен.
-- Повторное применение безопасно.

alter table private.email_limits
    add column if not exists unconfirmed_ttl interval not null default interval '24 hours'
        check (unconfirmed_ttl between interval '1 hour' and interval '30 days');

create or replace function private.purge_unconfirmed_users()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    ttl interval;
    n integer;
begin
    select unconfirmed_ttl into ttl from private.email_limits where id = 1;
    if ttl is null then
        return 0;
    end if;
    delete from auth.users u
    where u.email_confirmed_at is null
      and u.phone_confirmed_at is null
      and u.last_sign_in_at is null
      and u.created_at < now() - ttl;
    get diagnostics n = row_count;
    return n;
end;
$$;

create or replace function private.cleanup_email_logs()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    delete from private.email_requests where created_at < now() - interval '8 days';
    delete from private.email_tickets where created_at < now() - interval '8 days';
    delete from private.email_sends where created_at < now() - interval '8 days';
    perform private.purge_unconfirmed_users();
end;
$$;

revoke all on function private.purge_unconfirmed_users() from public, anon, authenticated;
revoke all on function private.cleanup_email_logs() from public, anon, authenticated;
