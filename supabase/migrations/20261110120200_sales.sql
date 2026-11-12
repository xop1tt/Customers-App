-- Customers 2.0, этап 5: воронки, этапы, сделки, контакты сделки, история этапов.
-- Документы: docs/CRM_ARCHITECTURE.md §5, docs/DATABASE_SCHEMA.md §3.3. Только добавление объектов.

create table if not exists public.pipelines (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    name text not null check (char_length(btrim(name)) between 1 and 120),
    position numeric not null default 0,
    is_default boolean not null default false
);
create unique index if not exists pipelines_one_default on public.pipelines (workspace_id)
    where is_default and deleted_at is null;

create table if not exists public.pipeline_stages (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    pipeline_id uuid not null references public.pipelines (id),
    name text not null check (char_length(btrim(name)) between 1 and 120),
    position numeric not null default 0,
    color text not null default '#4f8cff' check (color ~ '^#[0-9a-f]{6}$'),
    probability smallint not null default 0 check (probability between 0 and 100),
    kind text not null default 'open' check (kind in ('open', 'won', 'lost'))
);
create index if not exists pipeline_stages_pipeline on public.pipeline_stages (pipeline_id, position) where deleted_at is null;

create table if not exists public.deals (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    owner_id uuid,
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    pipeline_id uuid not null references public.pipelines (id),
    stage_id uuid not null references public.pipeline_stages (id),
    title text not null check (char_length(btrim(title)) between 1 and 300),
    amount numeric(18, 2) not null default 0 check (amount >= 0),
    currency char(3) not null default 'RUB' check (currency ~ '^[A-Z]{3}$'),
    expected_close_date date,
    company_id uuid references public.companies (id),
    status text not null default 'open' check (status in ('open', 'won', 'lost')),
    lost_reason text check (char_length(lost_reason) <= 500),
    closed_at timestamptz
);
create index if not exists deals_board on public.deals (workspace_id, pipeline_id, stage_id) where deleted_at is null;

create table if not exists public.deal_contacts (
    id uuid primary key,
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    created_by uuid not null, created_at timestamptz not null default now(),
    updated_by uuid, updated_at timestamptz not null default now(),
    archived_at timestamptz, deleted_at timestamptz,
    version bigint not null default 1,
    field_ts jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ts) = 'object'),
    field_ver jsonb not null default '{}'::jsonb check (jsonb_typeof(field_ver) = 'object'),
    server_seq bigint not null default nextval('public.sync_seq'),
    deal_id uuid not null references public.deals (id),
    contact_id uuid not null references public.contacts (id),
    role text check (char_length(role) <= 120)
);
-- Устройства создают связь с одинаковым id (UUID v5 от сделки и контакта), поэтому две привязки сливаются.
create unique index if not exists deal_contacts_pair on public.deal_contacts (deal_id, contact_id);

create table if not exists public.deal_stage_history (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references public.workspaces (id) on delete cascade,
    deal_id uuid not null references public.deals (id) on delete cascade,
    from_stage_id uuid references public.pipeline_stages (id),
    to_stage_id uuid not null references public.pipeline_stages (id),
    changed_by uuid,
    changed_at timestamptz not null default now(),
    server_seq bigint not null default nextval('public.sync_seq')
);
create index if not exists deal_stage_history_ws_seq on public.deal_stage_history (workspace_id, server_seq);
create index if not exists deal_stage_history_deal on public.deal_stage_history (deal_id, changed_at);

select private.crm_attach('pipelines', 'settings', array['archived_at', 'deleted_at', 'name', 'position', 'is_default']);
select private.crm_attach('pipeline_stages', 'settings', array['deleted_at', 'pipeline_id', 'name', 'position', 'color',
    'probability', 'kind']);
select private.crm_attach('deals', 'records', array['owner_id', 'archived_at', 'deleted_at', 'pipeline_id', 'stage_id',
    'title', 'amount', 'currency', 'expected_close_date', 'company_id', 'lost_reason']);
select private.crm_attach('deal_contacts', 'records', array['deleted_at', 'deal_id', 'contact_id', 'role']);

-- Правила сделки: этап из той же воронки, статус и дата закрытия — из вида этапа (клиент их не задаёт).
create or replace function private.deal_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    st public.pipeline_stages;
begin
    select * into st from public.pipeline_stages where id = new.stage_id;
    if st.pipeline_id is distinct from new.pipeline_id or st.deleted_at is not null then
        raise exception 'stage does not belong to the pipeline' using errcode = '23503';
    end if;
    new.status := st.kind;
    if st.kind = 'open' then
        new.closed_at := null;
    elsif tg_op = 'INSERT' or old.status is distinct from st.kind or new.closed_at is null then
        new.closed_at := now();
    end if;
    if st.kind <> 'lost' then
        new.lost_reason := null;
    end if;
    return new;
end;
$$;
revoke all on function private.deal_rules() from public, anon, authenticated;
drop trigger if exists deals_rules on public.deals;
create trigger deals_rules before insert or update on public.deals
    for each row execute function private.deal_rules();

-- История этапов пишет сервер, поэтому она не зависит от клиента.
create or replace function private.deal_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
        insert into public.deal_stage_history (workspace_id, deal_id, from_stage_id, to_stage_id, changed_by)
        values (new.workspace_id, new.id, case when tg_op = 'UPDATE' then old.stage_id end, new.stage_id, auth.uid());
    end if;
    return null;
end;
$$;
revoke all on function private.deal_history() from public, anon, authenticated;
drop trigger if exists deals_history on public.deals;
create trigger deals_history after insert or update on public.deals
    for each row execute function private.deal_history();

alter table public.deal_stage_history enable row level security;
alter table public.deal_stage_history force row level security;
drop policy if exists deal_stage_history_select on public.deal_stage_history;
create policy deal_stage_history_select on public.deal_stage_history for select to authenticated
    using (private.has_perm(workspace_id, 'records.view'));
revoke all on public.deal_stage_history from anon, public, authenticated;
grant select on public.deal_stage_history to authenticated;

-- Удаление этапа со сделками: сделки переносятся на указанный этап, этап получает надгробие.
create or replace function public.delete_stage(p_stage uuid, p_move_to uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
    st public.pipeline_stages;
    target public.pipeline_stages;
    moved int;
begin
    select * into st from public.pipeline_stages where id = p_stage and deleted_at is null;
    if st.id is null then
        raise exception 'stage not found' using errcode = 'P0002';
    end if;
    perform private.require_perm(st.workspace_id, 'pipelines.manage');
    select * into target from public.pipeline_stages where id = p_move_to and deleted_at is null;
    if target.id is null or target.workspace_id <> st.workspace_id or target.id = st.id then
        raise exception 'move_to must be another stage of this workspace' using errcode = '22023';
    end if;
    update public.deals set pipeline_id = target.pipeline_id, stage_id = target.id,
        field_ts = field_ts || jsonb_build_object('stage_id', now(), 'pipeline_id', now())
    where stage_id = st.id;
    get diagnostics moved = row_count;
    update public.pipeline_stages set deleted_at = now(), field_ts = field_ts || jsonb_build_object('deleted_at', now())
    where id = st.id;
    return moved;
end;
$$;
revoke all on function public.delete_stage(uuid, uuid) from public, anon;
grant execute on function public.delete_stage(uuid, uuid) to authenticated;

-- Воронка-шаблон нового Workspace.
create or replace function private.seed_pipeline(p_workspace uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    pid uuid := gen_random_uuid();
begin
    if exists (select 1 from public.pipelines where workspace_id = p_workspace) then
        return;
    end if;
    insert into public.pipelines (id, workspace_id, created_by, name, position, is_default)
    values (pid, p_workspace, auth.uid(), 'Продажи', 1, true);
    insert into public.pipeline_stages (id, workspace_id, created_by, pipeline_id, name, position, color, probability, kind)
    select gen_random_uuid(), p_workspace, auth.uid(), pid, s.name, s.pos, s.color, s.prob, s.kind
    from (values ('Новый лид', 1, '#6b7280', 10, 'open'), ('Первый контакт', 2, '#3b82f6', 20, 'open'),
                 ('Переговоры', 3, '#8b5cf6', 40, 'open'), ('Подготовка предложения', 4, '#f59e0b', 60, 'open'),
                 ('Согласование', 5, '#ec4899', 80, 'open'), ('Успешная сделка', 6, '#22c55e', 100, 'won'),
                 ('Проигранная сделка', 7, '#ef4444', 0, 'lost')) as s(name, pos, color, prob, kind);
end;
$$;
revoke all on function private.seed_pipeline(uuid) from public, anon, authenticated;

create or replace function private.seed_workspace(p_workspace uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.seed_pipeline(p_workspace);
end;
$$;
