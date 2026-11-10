// Демо-реализация команд ws_* для браузера, тестов и снимков экрана: Workspace и CRM в памяти.
// Повторяет правила ядра там, где их видно в интерфейсе: версии, производные поля, права, корзина, фильтры коллекций.

import type { CrmRecord, Lead, WorkspaceInfo, WsCollection, WsConflict, WsFilter, WsMember, WsQuery, WsState } from "./types";

type Row = CrmRecord;
const ALL_PERMS = [
  "records.view", "records.create", "records.edit_own", "records.edit", "records.delete", "records.export", "members.view", "members.manage",
  "invitations.manage", "roles.manage", "workspace.manage", "workspace.delete", "ownership.transfer", "pipelines.manage", "fields.manage",
  "collections.manage", "analytics.view", "audit.view",
];
const ROLE_PERMS: Record<string, string[]> = {
  owner: ALL_PERMS,
  admin: ALL_PERMS.filter((p) => !["workspace.delete", "ownership.transfer"].includes(p)),
  manager: ["records.view", "records.create", "records.edit_own", "records.edit", "records.delete", "records.export", "members.view", "invitations.manage", "pipelines.manage", "fields.manage", "collections.manage", "analytics.view"],
  employee: ["records.view", "records.create", "records.edit_own", "members.view", "analytics.view"],
  viewer: ["records.view", "members.view", "analytics.view"],
};
const ROLE_NAME: Record<string, string> = { owner: "Владелец", admin: "Администратор", manager: "Менеджер", employee: "Сотрудник", viewer: "Наблюдатель" };
const RANK: Record<string, number> = { owner: 100, admin: 80, manager: 60, employee: 40, viewer: 20 };

const ME = "00000000-0000-4000-8000-000000000001";
let seq = 1;
const uid = () => `00000000-0000-4000-8000-${String(1000 + seq++).padStart(12, "0")}`;
const now = () => new Date().toISOString();

const PERM_TEXT: Record<string, string> = {
  "records.view": "Читать записи CRM", "records.create": "Создавать записи", "records.edit_own": "Менять свои записи", "records.edit": "Менять любые записи",
  "records.delete": "Удалять и восстанавливать записи", "records.export": "Экспорт и массовая выгрузка", "members.view": "Видеть участников",
  "members.manage": "Менять роли и удалять участников", "invitations.manage": "Приглашать участников", "roles.manage": "Создавать и менять свои роли",
  "workspace.manage": "Название, валюта и настройки Workspace", "workspace.delete": "Удалить Workspace", "ownership.transfer": "Передать владение",
  "pipelines.manage": "Воронки и этапы", "fields.manage": "Пользовательские поля", "collections.manage": "Общие коллекции",
  "analytics.view": "Аналитика и отчёты", "audit.view": "Журнал действий",
};
interface CustomRole { key: string; name: string; rank: number; permissions: string[] }
const customRoles = new Map<string, CustomRole[]>();

interface Ws { info: WorkspaceInfo; members: WsMember[]; tables: Map<string, Row[]>; prefs: Map<string, { position: number; hidden: boolean }>; conflicts: WsConflict[] }

const roleOf = (wsId: string, key: string) => customRoles.get(wsId)?.find((r) => r.key === key);
const member = (userId: string, displayName: string, role: string, wsId = ""): WsMember => {
  const own = roleOf(wsId, role);
  return { userId, displayName, role, roleName: own?.name ?? ROLE_NAME[role] ?? role, rank: own?.rank ?? RANK[role] ?? 0, avatarPath: null, email: null };
};

function info(id: string, name: string, role: string, personal: boolean, members: number): WorkspaceInfo {
  return { id, name, personal, role, roleName: ROLE_NAME[role] ?? role, rank: RANK[role] ?? 0, permissions: ROLE_PERMS[role] ?? [], members, remote: false, defaultCurrency: "RUB" };
}

function row(ws: string, fields: Record<string, unknown>, by = ME): Row {
  const t = now();
  return { id: uid(), workspace_id: ws, version: 1, created_at: t, updated_at: t, created_by: by, updated_by: by, archived_at: null, deleted_at: null, ...fields } as Row;
}

const SEED_COLLECTIONS: [string, string, string, string, WsCollection["config"]][] = [
  ["all_clients", "company", "Все клиенты", "🤝", { filters: [], sort: [{ field: "updated_at", dir: "desc" }] }],
  ["my_clients", "company", "Мои клиенты", "⭐", { filters: [{ field: "owner_id", op: "eq", value: "$me" }], sort: [{ field: "updated_at", dir: "desc" }] }],
  ["new_leads", "crm_lead", "Новые лиды", "🌱", { filters: [{ field: "status", op: "eq", value: "new" }], sort: [{ field: "created_at", dir: "desc" }] }],
  ["deals_this_week", "deal", "Сделки на этой неделе", "📅", { filters: [{ field: "expected_close_date", op: "this_week" }, { field: "status", op: "eq", value: "open" }], sort: [{ field: "expected_close_date", dir: "asc" }] }],
  ["overdue_tasks", "task", "Просроченные задачи", "⏰", { filters: [{ field: "due_at", op: "overdue" }], sort: [{ field: "due_at", dir: "asc" }] }],
  ["won_deals", "deal", "Успешные сделки", "🏆", { filters: [{ field: "status", op: "eq", value: "won" }], sort: [{ field: "closed_at", dir: "desc" }] }],
  ["lost_deals", "deal", "Потерянные сделки", "🥀", { filters: [{ field: "status", op: "eq", value: "lost" }], sort: [{ field: "closed_at", dir: "desc" }] }],
];
const STAGES: [string, string, number][] = [["Новая", "open", 10], ["Квалификация", "open", 25], ["Предложение", "open", 50], ["Переговоры", "open", 75], ["Счёт", "open", 90], ["Успех", "won", 100], ["Проигрыш", "lost", 0]];

function seed(id: string, demo: boolean): Map<string, Row[]> {
  const t = new Map<string, Row[]>();
  for (const name of ["pipelines", "pipeline_stages", "companies", "contacts", "crm_leads", "deals", "deal_contacts", "tasks", "activities", "notes", "comments", "custom_fields", "custom_field_values", "collections"]) t.set(name, []);
  const pipe = row(id, { name: "Продажи", position: 1, is_default: true });
  t.get("pipelines")!.push(pipe);
  STAGES.forEach(([name, kind, probability], i) => t.get("pipeline_stages")!.push(row(id, { pipeline_id: pipe.id, name, kind, probability, position: i + 1, color: null })));
  SEED_COLLECTIONS.forEach(([builtin, entity_type, name, emoji, config], i) =>
    t.get("collections")!.push(row(id, { builtin, entity_type, name, emoji, icon: null, config, visibility: "workspace", position: i + 1 })));
  if (!demo) return t;
  const c1 = row(id, { name: "ООО «Северный ветер»", phones: ["+74951234567"], emails: ["info@sever-veter.ru"], website: "https://sever-veter.ru", domain: "sever-veter.ru", industry: "Логистика", owner_id: ME, source: "fl_ru", inn: null, address: "Москва" });
  const c2 = row(id, { name: "Кофейня «Зерно»", phones: ["+79161112233"], emails: [], industry: "Общепит", owner_id: "00000000-0000-4000-8000-000000000002", address: "Казань" });
  t.get("companies")!.push(c1, c2);
  const p1 = row(id, { company_id: c1.id, first_name: "Ольга", last_name: "Смирнова", full_name: "Ольга Смирнова", position: "Директор по закупкам", phones: ["+79031234567"], emails: ["olga@sever-veter.ru"], owner_id: ME });
  t.get("contacts")!.push(p1);
  const stages = t.get("pipeline_stages")!;
  const week = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  const d1 = row(id, { title: "Сайт для «Северного ветра»", pipeline_id: pipe.id, stage_id: stages[2]!.id, amount: 180000, currency: "RUB", expected_close_date: week, company_id: c1.id, status: "open", owner_id: ME, closed_at: null, lost_reason: null });
  const d2 = row(id, { title: "Меню и брендинг", pipeline_id: pipe.id, stage_id: stages[5]!.id, amount: 45000, currency: "RUB", company_id: c2.id, status: "won", closed_at: now(), owner_id: ME, lost_reason: null });
  t.get("deals")!.push(d1, d2);
  t.get("tasks")!.push(
    row(id, { title: "Позвонить Ольге по смете", status: "todo", priority: "high", due_at: new Date(Date.now() - 3600_000).toISOString(), assignee_id: ME, entity_type: "deal", entity_id: d1.id, completed_at: null }),
    row(id, { title: "Отправить коммерческое предложение", status: "todo", priority: "normal", due_at: new Date(Date.now() + 86400_000).toISOString(), assignee_id: ME, entity_type: "company", entity_id: c1.id, completed_at: null }),
  );
  t.get("notes")!.push(row(id, { body: "Нашли на FL.ru, просили смету до пятницы.", entity_type: "company", entity_id: c1.id }));
  t.get("activities")!.push(row(id, { type: "call", summary: "Первый звонок: интересно, ждут предложение", occurred_at: now(), entity_type: "company", entity_id: c1.id, payload: {} }));
  t.get("crm_leads")!.push(row(id, { title: "Ищем подрядчика на чат-бота", person_name: "Игорь", company_name: "Студия «Пиксель»", phones: [], emails: ["igor@pixel.studio"], status: "new", source: "telegram", owner_id: null }));
  return t;
}

const demoParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
const workspaces: Ws[] = [];
let active: string | null = null;

function ensure(): Ws {
  if (!workspaces.length) {
    const personal = "ws-personal";
    workspaces.push({ info: info(personal, "Моё рабочее пространство", "owner", true, 1), members: [member(ME, "Анна", "owner")], tables: seed(personal, true), prefs: new Map(), conflicts: [] });
    if (demoParams.has("team")) {
      const team = "ws-team";
      const members = [member(ME, "Анна", "manager"), member("00000000-0000-4000-8000-000000000002", "Борис Петров", "owner"), member("00000000-0000-4000-8000-000000000003", "Вера Ким", "employee"),
        member("00000000-0000-4000-8000-000000000004", "Глеб Орлов", "employee"), member("00000000-0000-4000-8000-000000000005", "Дина Лис", "viewer"), member("00000000-0000-4000-8000-000000000006", "Егор Сом", "employee")];
      workspaces.push({ info: info(team, "Отдел продаж", "manager", false, members.length), members, tables: seed(team, true), prefs: new Map(), conflicts: [] });
      active = team;
    }
    active ??= personal;
  }
  return workspaces.find((w) => w.info.id === active) ?? workspaces[0]!;
}

/** Сбросить демо-данные (тесты). */
export function resetWsMock() {
  workspaces.length = 0;
  active = null;
}

function state(): WsState {
  const ws = ensure();
  return {
    isCloud: demoParams.has("team"), me: ME, workspaces: workspaces.map((w) => w.info), active, permissions: ws.info.permissions, members: ws.members,
    pending: 0, rejected: 0, conflicts: ws.conflicts.length, syncing: false, lastSync: null, error: null,
  };
}

const fail = (message: string) => { throw { code: "", message }; };
const has = (ws: Ws, p: string) => ws.info.permissions.includes(p);
const table = (ws: Ws, name: string) => ws.tables.get(name) ?? fail(`Неизвестная сущность: ${name}`);
const TYPE_TABLE: Record<string, string> = { company: "companies", contact: "contacts", crm_lead: "crm_leads", deal: "deals", task: "tasks" };

function matches(r: Row, f: WsFilter): boolean {
  const v = r[f.field];
  const want = f.value === "$me" ? ME : f.value;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  switch (f.op) {
    case "eq": return v === want;
    case "ne": return v !== want;
    case "gt": return (v as number) > (want as number);
    case "lt": return (v as number) < (want as number);
    case "gte": return (v as number) >= (want as number);
    case "lte": return (v as number) <= (want as number);
    case "in": return Array.isArray(want) && want.includes(v);
    case "contains": return String(v ?? "").toLowerCase().includes(String(want ?? "").toLowerCase());
    case "empty": return v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
    case "not_empty": return !(v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length));
    case "overdue": return typeof v === "string" && v < now() && !(r.status === "done" || r.status === "cancelled");
    case "today": return typeof v === "string" && v.slice(0, 10) === day(new Date());
    case "this_week": {
      if (typeof v !== "string") return false;
      const d = new Date();
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
      const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
      return v.slice(0, 10) >= day(monday) && v.slice(0, 10) <= day(sunday);
    }
    default: return fail(`Неизвестное условие фильтра: ${f.op}`);
  }
}

function list(ws: Ws, name: string, q: WsQuery = {}): { items: Row[]; total: number } {
  let rows = table(ws, name).filter((r) => (q.deleted ? !!r.deleted_at : !r.deleted_at) && (q.archived || !r.archived_at));
  for (const f of q.filters ?? []) rows = rows.filter((r) => matches(r, f));
  const s = q.search?.trim().toLowerCase();
  if (s) rows = rows.filter((r) => Object.entries(r).some(([k, v]) => !k.endsWith("id") && JSON.stringify(v ?? "").toLowerCase().includes(s)));
  const sort = q.sort?.length ? q.sort : [{ field: name === "collections" || name === "pipeline_stages" ? "position" : "updated_at", dir: name === "collections" || name === "pipeline_stages" ? "asc" : "desc" }];
  rows = [...rows].sort((a, b) => {
    for (const { field, dir } of sort) {
      const x = a[field] as string | number | null, y = b[field] as string | number | null;
      if (x === y) continue;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1);
    }
    return 0;
  });
  return { items: rows.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 500)), total: rows.length };
}

function rights(ws: Ws, name: string, current: Row | undefined, fields: Record<string, unknown>) {
  if (name === "collections" && fields.visibility !== "private" && (current?.visibility ?? fields.visibility ?? "workspace") === "workspace" && !has(ws, "collections.manage")) fail("Нет прав на общие коллекции.");
  if ((name === "pipelines" || name === "pipeline_stages") && !has(ws, "pipelines.manage")) fail("Нет прав на изменение воронок.");
  if (name === "custom_fields" && !has(ws, "fields.manage")) fail("Нет прав на свои поля.");
  if (!current) {
    if (!has(ws, "records.create") && name !== "collections") fail("Нет прав на создание записей.");
    return;
  }
  if ("deleted_at" in fields && !has(ws, "records.delete")) fail("Нет прав на удаление.");
  const own = current.created_by === ME || current.owner_id === ME || current.assignee_id === ME;
  if (!has(ws, "records.edit") && !(own && has(ws, "records.edit_own")) && name !== "collections") fail("Нет прав на изменение этой записи.");
}

function save(ws: Ws, name: string, id: string | null, fields: Record<string, unknown>): Row {
  const rows = table(ws, name);
  const current = id ? rows.find((r) => r.id === id) : undefined;
  if (id && !current) fail("Запись не найдена.");
  if (current?.deleted_at && !("deleted_at" in fields)) fail("Запись удалена. Восстановите её, чтобы изменить.");
  rights(ws, name, current, fields);
  const required: Record<string, string[]> = { companies: ["name"], crm_leads: ["title"], deals: ["title", "pipeline_id", "stage_id"], tasks: ["title"], notes: ["body"], comments: ["body"], collections: ["name", "entity_type"] };
  const merged = { ...(current ?? {}), ...fields } as Row;
  for (const f of required[name] ?? []) if (merged[f] === null || merged[f] === undefined || merged[f] === "") fail(`Заполните поле: ${f}`);
  if (name === "contacts") merged.full_name = [merged.first_name, merged.last_name].filter(Boolean).join(" ") || null;
  if (name === "deals" && "stage_id" in fields) {
    const stage = table(ws, "pipeline_stages").find((s) => s.id === merged.stage_id);
    const kind = (stage?.kind as string) ?? "open";
    if (merged.status !== kind) merged.closed_at = kind === "open" ? null : now();
    merged.status = kind;
    if (current && current.stage_id !== merged.stage_id) addHistory(ws, current.id, current.stage_id as string, merged.stage_id as string);
  }
  if (name === "tasks" && "status" in fields) merged.completed_at = merged.status === "done" ? (current?.completed_at ?? now()) : null;
  if (current) {
    Object.assign(current, merged, { version: current.version + 1, updated_at: now(), updated_by: ME });
    return current;
  }
  const r = row(ws.info.id, { owner_id: ["companies", "contacts", "crm_leads", "deals"].includes(name) ? ME : undefined, ...merged });
  if (name === "deals") r.status ??= "open";
  if (name === "tasks") { r.status ??= "todo"; r.priority ??= "normal"; }
  if (name === "crm_leads") r.status ??= "new";
  rows.push(r);
  return r;
}

const history = new Map<string, { from_stage_id: string | null; to_stage_id: string; changed_by: string; changed_at: string }[]>();
function addHistory(_ws: Ws, deal: string, from: string | null, to: string) {
  const h = history.get(deal) ?? [];
  h.push({ from_stage_id: from, to_stage_id: to, changed_by: ME, changed_at: now() });
  history.set(deal, h);
}

function card(ws: Ws, name: string, id: string) {
  const record = table(ws, name).find((r) => r.id === id) ?? fail("Запись не найдена.");
  const type = Object.entries(TYPE_TABLE).find(([, t]) => t === name)?.[0];
  const out: Record<string, unknown> = { record, conflicts: ws.conflicts.filter((c) => c.entityId === id) };
  const linked = (t: string) => list(ws, t, { filters: [{ field: "entity_type", op: "eq", value: type }, { field: "entity_id", op: "eq", value: id }], sort: [{ field: "created_at", dir: "desc" }] }).items;
  if (type && type !== "task") for (const t of ["tasks", "activities", "notes", "comments", "custom_field_values"]) out[t] = linked(t);
  const by = (t: string, field: string) => list(ws, t, { filters: [{ field, op: "eq", value: id }] }).items;
  if (name === "companies") { out.contacts = by("contacts", "company_id"); out.deals = by("deals", "company_id"); }
  if (name === "deals") { out.history = history.get(id) ?? []; out.dealContacts = by("deal_contacts", "deal_id"); }
  if (name === "contacts") out.dealLinks = by("deal_contacts", "contact_id");
  return out;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-zа-яё0-9@.+]/gi, "");
function duplicates(ws: Ws, name: string, fields: Record<string, unknown>, except: string | null) {
  const keys = new Set<string>();
  for (const f of ["name", "full_name", "title"]) if (typeof fields[f] === "string" && fields[f]) keys.add(norm(fields[f]));
  for (const f of ["phones", "emails"]) if (Array.isArray(fields[f])) (fields[f] as unknown[]).forEach((x) => keys.add(norm(x)));
  if (!keys.size) return [];
  return list(ws, name).items.filter((r) => r.id !== except && [r.name, r.full_name, r.title, ...((r.phones as unknown[]) ?? []), ...((r.emails as unknown[]) ?? [])].some((v) => v && keys.has(norm(v))));
}

function convert(ws: Ws, lead: Lead, opts: { createDeal?: boolean; pipelineId?: string | null }) {
  const d = lead.data;
  const existing = list(ws, "companies").items.find((c) => c.source_lead_id === lead.id) ?? duplicates(ws, "companies", { name: d.title, phones: lead.phones, emails: lead.emails }, null)[0];
  const company = existing ?? save(ws, "companies", null, { name: d.title, phones: lead.phones, emails: lead.emails, website: d.website ?? null, source: d.source, source_lead_id: lead.id });
  let dealId: string | null = null;
  if (opts.createDeal && !existing) {
    const pipe = opts.pipelineId ?? list(ws, "pipelines").items[0]?.id;
    const stage = list(ws, "pipeline_stages", { filters: [{ field: "pipeline_id", op: "eq", value: pipe }] }).items[0];
    dealId = save(ws, "deals", null, { title: d.title, pipeline_id: pipe, stage_id: stage?.id, company_id: company.id, amount: d.budget ?? null, currency: "RUB" }).id;
  }
  if (!existing) save(ws, "activities", null, { type: "system", summary: "Перенесено из генератора лидов", occurred_at: now(), entity_type: "company", entity_id: company.id, payload: { lead: lead.id } });
  return { workspaceId: ws.info.id, companyId: company.id, contactId: null, dealId, reusedCompany: !!existing, reusedContact: false };
}

function collections(ws: Ws) {
  return list(ws, "collections").items
    .filter((c) => !ws.prefs.get(c.id)?.hidden && (c.visibility === "workspace" || c.created_by === ME))
    .map((c) => {
      const t = TYPE_TABLE[c.entity_type as string] ?? "companies";
      const cfg = c.config as WsCollection["config"];
      return { ...c, position: ws.prefs.get(c.id)?.position ?? c.position, count: list(ws, t, { filters: cfg.filters ?? [] }).total };
    })
    .sort((a, b) => (a.position as number) - (b.position as number));
}

async function remoteOnly(): Promise<never> {
  return fail("Участники и приглашения доступны в облачной учётной записи.");
}

export async function wsCall(cmd: string, args: Record<string, unknown>, leads: () => Lead[]): Promise<unknown> {
  const ws = ensure();
  const s = (k: string) => args[k] as string;
  switch (cmd) {
    case "ws_state": case "ws_refresh": case "ws_sync_now": return state();
    case "ws_switch":
      if (!workspaces.some((w) => w.info.id === s("id"))) fail("Такого Workspace нет в списке.");
      active = s("id");
      return state();
    case "ws_create_workspace": {
      const name = s("name").trim();
      if (!name || name.length > 120) fail("Название — от 1 до 120 символов.");
      const id = `ws-${uid()}`;
      workspaces.push({ info: info(id, name, "owner", false, 1), members: [member(ME, "Анна", "owner")], tables: seed(id, false), prefs: new Map(), conflicts: [] });
      active = id;
      return state();
    }
    case "ws_rename_workspace":
      ws.info = { ...ws.info, name: s("name").trim().slice(0, 120) };
      return state();
    case "ws_list": return list(ws, s("entity"), (args.query as WsQuery) ?? {});
    case "ws_card": return card(ws, s("entity"), s("id"));
    case "ws_save": return save(ws, s("entity"), (args.id as string) ?? null, args.fields as Record<string, unknown>);
    case "ws_delete": return save(ws, s("entity"), s("id"), { deleted_at: now() });
    case "ws_restore": return save(ws, s("entity"), s("id"), { deleted_at: null });
    case "ws_duplicates": return duplicates(ws, s("entity"), args.fields as Record<string, unknown>, (args.except as string) ?? null);
    case "ws_convert_lead": {
      const lead = leads().find((l) => l.id === s("leadId")) ?? fail("Лид не найден.");
      return convert(ws, lead, (args.options as { createDeal?: boolean }) ?? {});
    }
    case "ws_collections": return collections(ws);
    case "ws_collection_items": {
      const c = table(ws, "collections").find((x) => x.id === s("id")) ?? fail("Коллекция не найдена.");
      const cfg = c.config as WsCollection["config"];
      const q = (args.query as WsQuery) ?? {};
      const t = TYPE_TABLE[c.entity_type as string] ?? fail("Неизвестный тип коллекции.");
      return { collection: c, entity: t, ...list(ws, t, { ...q, filters: [...(cfg.filters ?? []), ...(q.filters ?? [])], sort: q.sort?.length ? q.sort : cfg.sort }) };
    }
    case "ws_reorder_collections":
      (args.ids as string[]).forEach((id, i) => ws.prefs.set(id, { position: i + 1, hidden: ws.prefs.get(id)?.hidden ?? false }));
      return null;
    case "ws_hide_collection":
      ws.prefs.set(s("id"), { position: ws.prefs.get(s("id"))?.position ?? 0, hidden: Boolean(args.hidden) });
      return null;
    case "ws_roles": {
      if (!demoParams.has("team") || !ws.info.remote) return { roles: [], catalog: [] };
      const sys = Object.keys(ROLE_PERMS).map((key) => ({ key, name: ROLE_NAME[key], rank: RANK[key], system: true, permissions: ROLE_PERMS[key] }));
      const own = (customRoles.get(ws.info.id) ?? []).map((r) => ({ ...r, system: false }));
      return { roles: [...sys, ...own].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)), catalog: ALL_PERMS.map((key) => ({ key, description: PERM_TEXT[key] })) };
    }
    case "ws_save_role": {
      if (!demoParams.has("team")) return remoteOnly();
      if (!has(ws, "roles.manage")) fail("Нет прав на роли.");
      const key = s("key");
      if (key in ROLE_PERMS) fail("Ключи системных ролей зарезервированы.");
      const rank = Number(args.rank);
      if (!(rank >= 0 && rank < ws.info.rank)) fail("Ранг роли должен быть ниже вашего.");
      const perms = args.permissions as string[];
      const lacking = perms.find((p) => !has(ws, p));
      if (lacking) fail(`Нельзя выдать разрешение, которого нет у вас: ${lacking}`);
      const list = customRoles.get(ws.info.id) ?? [];
      const next = { key, name: s("name").trim(), rank, permissions: perms };
      customRoles.set(ws.info.id, [...list.filter((r) => r.key !== key), next]);
      ws.members.forEach((m) => { if (m.role === key) Object.assign(m, member(m.userId, m.displayName, key, ws.info.id)); });
      return wsCall("ws_roles", {}, leads);
    }
    case "ws_delete_role": {
      if (!demoParams.has("team")) return remoteOnly();
      if (!has(ws, "roles.manage")) fail("Нет прав на роли.");
      if (ws.members.some((m) => m.role === s("key"))) fail("Роль используется участниками.");
      customRoles.set(ws.info.id, (customRoles.get(ws.info.id) ?? []).filter((r) => r.key !== s("key")));
      return wsCall("ws_roles", {}, leads);
    }
    case "ws_delete_stage": {
      if (!has(ws, "pipelines.manage")) fail("Нет прав на изменение воронок.");
      const target = table(ws, "pipeline_stages").find((x) => x.id === s("moveTo") && !x.deleted_at) ?? fail("Этап для переноса не найден.");
      if (target.id === s("stage")) fail("Выберите другой этап для переноса сделок.");
      const deals = table(ws, "deals").filter((d) => d.stage_id === s("stage"));
      deals.forEach((d) => save(ws, "deals", d.id, { stage_id: target.id, pipeline_id: target.pipeline_id }));
      save(ws, "pipeline_stages", s("stage"), { deleted_at: now() });
      return { moved: deals.length };
    }
    case "ws_conflicts": return { conflicts: ws.conflicts, rejected: [] };
    case "ws_resolve_conflict": ws.conflicts = ws.conflicts.filter((c) => c.id !== s("id")); return null;
    case "ws_dismiss_rejected": return 0;
    case "ws_invite": {
      if (!demoParams.has("team")) return remoteOnly();
      if (!has(ws, "invitations.manage")) fail("Нет прав на приглашения.");
      const token = `demo${uid().slice(-12)}`;
      return { id: uid(), email: s("email").toLowerCase(), role: s("role"), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), token, link: `customers://invite?token=${token}` };
    }
    case "ws_set_member_role": {
      if (!demoParams.has("team")) return remoteOnly();
      if (!has(ws, "members.manage")) fail("Нет прав на изменение ролей.");
      const m = ws.members.find((x) => x.userId === s("user")) ?? fail("Участник не найден.");
      Object.assign(m, member(m.userId, m.displayName, s("role"), ws.info.id));
      return state();
    }
    case "ws_remove_member":
      if (!demoParams.has("team")) return remoteOnly();
      if (!has(ws, "members.manage")) fail("Нет прав на удаление участников.");
      ws.members = ws.members.filter((x) => x.userId !== s("user"));
      return state();
    case "ws_accept_invitation": case "ws_leave": return remoteOnly();
    default: return null;
  }
}
