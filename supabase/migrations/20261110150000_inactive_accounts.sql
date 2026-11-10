-- Неактивные облачные аккаунты: предупреждение по почте, возможность сохранить аккаунт, удаление.
--
-- Правила:
--  * неактивным считается аккаунт без входа и без обновления сессии `inactive_after` (по умолчанию 2 года);
--  * за `inactive_warn_before` (по умолчанию 30 дней) до срока ему отправляется письмо со ссылкой «Сохранить аккаунт»;
--  * удаляются только те аккаунты, которым письмо было отправлено не менее `inactive_warn_before` назад и которые
--    с тех пор не заходили и не нажимали «Сохранить». Без отправленного письма аккаунт не удаляется никогда;
--  * аккаунты, состоящие в Workspace вместе с другими активными участниками, не удаляются (их данные общие).
-- Сроки меняются SQL-запросом, например: update private.email_limits set inactive_after = interval '3 years';
-- Функции вызываются только серверными функциями inactive-accounts и keep-account (ключ service_role).
-- Повторное применение безопасно.

alter table private.email_limits
    add column if not exists inactive_after interval not null default interval '2 years'
        check (inactive_after between interval '90 days' and interval '10 years'),
    add column if not exists inactive_warn_before interval not null default interval '30 days'
        check (inactive_warn_before between interval '7 days' and interval '180 days');

create table if not exists private.inactive_notices (
    user_id uuid primary key references auth.users (id) on delete cascade,
    warned_at timestamptz,
    keep_token_hash text,
    kept_at timestamptz,
    updated_at timestamptz not null default now()
);
alter table private.inactive_notices enable row level security;
revoke all on private.inactive_notices from public, anon, authenticated;

-- Последняя активность: вход, обновление сессии, нажатие «Сохранить аккаунт», создание аккаунта.
create or replace function private.last_activity(p_user uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
    select greatest(
        u.created_at,
        u.last_sign_in_at,
        (select max(rt.updated_at) from auth.refresh_tokens rt where rt.user_id = u.id::text),
        (select n.kept_at from private.inactive_notices n where n.user_id = u.id)
    )
    from auth.users u where u.id = p_user;
$$;

-- Состоит ли пользователь в Workspace с другими активными участниками.
create or replace function private.in_shared_workspace(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.workspace_members m
        where m.user_id = p_user and m.status = 'active'
          and exists (select 1 from public.workspace_members o
                      where o.workspace_id = m.workspace_id and o.user_id <> p_user and o.status = 'active')
    );
$$;

-- Кому пора отправить предупреждение: до удаления остаётся не больше `inactive_warn_before`.
create or replace function public.inactive_accounts_due(p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    cfg private.email_limits;
begin
    select * into cfg from private.email_limits where id = 1;
    return coalesce((
        select jsonb_agg(jsonb_build_object(
                   'user_id', x.id, 'email', x.email, 'last_activity', x.act,
                   'delete_on', x.act + cfg.inactive_after))
        from (
            select u.id, u.email, private.last_activity(u.id) as act
            from auth.users u
            where u.email_confirmed_at is not null and u.email is not null
              and not exists (select 1 from private.inactive_notices n
                              where n.user_id = u.id and n.warned_at is not null
                                and n.warned_at > private.last_activity(u.id))
              and private.last_activity(u.id) < now() - (cfg.inactive_after - cfg.inactive_warn_before)
              and not private.in_shared_workspace(u.id)
            order by private.last_activity(u.id)
            limit greatest(1, least(coalesce(p_limit, 20), 100))
        ) x
    ), '[]'::jsonb);
end;
$$;

-- Письмо отправлено: запоминаем время и хеш ключа ссылки «Сохранить аккаунт».
create or replace function public.inactive_mark_warned(p_user uuid, p_token_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_token_hash is null or length(p_token_hash) <> 64 then
        raise exception 'bad token hash' using errcode = '22023';
    end if;
    insert into private.inactive_notices (user_id, warned_at, keep_token_hash, kept_at, updated_at)
    values (p_user, now(), p_token_hash, null, now())
    on conflict (user_id) do update
        set warned_at = now(), keep_token_hash = excluded.keep_token_hash, kept_at = null, updated_at = now();
end;
$$;

-- Ссылка «Сохранить аккаунт»: считается активностью, срок отсчитывается заново.
create or replace function public.inactive_keep(p_token_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    uid uuid;
begin
    select user_id into uid from private.inactive_notices
    where keep_token_hash = p_token_hash and warned_at is not null;
    if uid is null then
        return false;
    end if;
    update private.inactive_notices set kept_at = now(), updated_at = now() where user_id = uid;
    return true;
end;
$$;

-- Удаление: только после отправленного предупреждения и без активности с тех пор.
create or replace function public.inactive_purge(p_limit integer default 50)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    cfg private.email_limits;
    n integer;
begin
    select * into cfg from private.email_limits where id = 1;
    with victims as (
        select u.id
        from private.inactive_notices w
        join auth.users u on u.id = w.user_id
        where w.warned_at is not null
          and w.warned_at <= now() - cfg.inactive_warn_before
          and private.last_activity(u.id) <= w.warned_at
          and private.last_activity(u.id) < now() - cfg.inactive_after
          and not private.in_shared_workspace(u.id)
        limit greatest(1, least(coalesce(p_limit, 50), 200))
    )
    delete from auth.users where id in (select id from victims);
    get diagnostics n = row_count;
    return n;
end;
$$;

revoke all on function private.last_activity(uuid) from public, anon, authenticated;
revoke all on function private.in_shared_workspace(uuid) from public, anon, authenticated;
revoke all on function public.inactive_accounts_due(integer) from public, anon, authenticated;
revoke all on function public.inactive_mark_warned(uuid, text) from public, anon, authenticated;
revoke all on function public.inactive_keep(text) from public, anon, authenticated;
revoke all on function public.inactive_purge(integer) from public, anon, authenticated;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        grant execute on function public.inactive_accounts_due(integer) to service_role;
        grant execute on function public.inactive_mark_warned(uuid, text) to service_role;
        grant execute on function public.inactive_keep(text) to service_role;
        grant execute on function public.inactive_purge(integer) to service_role;
    end if;
end;
$$;
