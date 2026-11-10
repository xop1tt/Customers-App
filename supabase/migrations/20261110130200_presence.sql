-- Онлайн-присутствие: кто из участников Workspace сейчас в приложении и какую карточку смотрит.
-- Клиент раз в ~25 с вызывает touch_presence (запись «я здесь» и чтение списка за один запрос).
-- Таблица недоступна напрямую; строки старше суток чистит touch_presence.

create table if not exists public.workspace_presence (
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    entity_type text check (entity_type in ('company', 'contact', 'crm_lead', 'deal', 'task')),
    entity_id uuid,
    seen_at timestamptz not null default now(),
    primary key (workspace_id, user_id)
);
alter table public.workspace_presence enable row level security;
alter table public.workspace_presence force row level security;
revoke all on public.workspace_presence from anon, public, authenticated;

create or replace function public.touch_presence(p_workspace uuid, p_entity_type text default null, p_entity_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    u uuid := private.uid();
begin
    perform private.require_perm(p_workspace, 'members.view');
    insert into public.workspace_presence (workspace_id, user_id, entity_type, entity_id, seen_at)
    values (p_workspace, u, p_entity_type, p_entity_id, now())
    on conflict (workspace_id, user_id) do update
        set entity_type = excluded.entity_type, entity_id = excluded.entity_id, seen_at = excluded.seen_at;
    delete from public.workspace_presence where workspace_id = p_workspace and seen_at < now() - interval '1 day';
    return (
        select coalesce(jsonb_agg(jsonb_build_object(
            'user_id', pr.user_id, 'entity_type', pr.entity_type, 'entity_id', pr.entity_id, 'seen_at', pr.seen_at
        ) order by pr.seen_at desc), '[]'::jsonb)
        from public.workspace_presence pr
        join public.workspace_members m on m.workspace_id = pr.workspace_id and m.user_id = pr.user_id and m.status = 'active'
        where pr.workspace_id = p_workspace and pr.seen_at > now() - interval '90 seconds'
    );
end;
$$;
revoke all on function public.touch_presence(uuid, text, uuid) from public, anon;
grant execute on function public.touch_presence(uuid, text, uuid) to authenticated;
