-- Редактор ролей: удаление своей роли Workspace (создание и правка — save_role).
-- Системные роли не удаляются; роль, которой пользуются участники или открытые приглашения, тоже.
create or replace function public.delete_role(p_workspace uuid, p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    r public.roles;
begin
    perform private.require_perm(p_workspace, 'roles.manage');
    select * into r from public.roles where workspace_id = p_workspace and key = p_key;
    if r.id is null then
        raise exception 'role not found' using errcode = 'P0002';
    end if;
    if r.rank >= private.rank_of(p_workspace, private.uid()) then
        raise exception 'role rank must be below your own' using errcode = '42501';
    end if;
    if exists (select 1 from public.workspace_members where role_id = r.id and status = 'active')
       or exists (select 1 from public.workspace_invitations where role_id = r.id and accepted_at is null and revoked_at is null) then
        raise exception 'role is in use' using errcode = '23503';
    end if;
    delete from public.roles where id = r.id;
end;
$$;
revoke all on function public.delete_role(uuid, text) from public, anon;
grant execute on function public.delete_role(uuid, text) to authenticated;
