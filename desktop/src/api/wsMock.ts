// Демо-реализация команд ws_* для браузера, тестов и снимков экрана: Workspace и CRM в памяти.
// Повторяет правила ядра там, где их видно в интерфейсе: версии, производные поля, права, корзина, фильтры коллекций.

import type { WsAuditItem, WsInvitation, CrmExportRequest, CrmMergeInfo, CrmMergeRequest, CrmRecord, Lead, WorkspaceInfo, WsCollection, WsConflict, WsFilter, WsMember, WsQuery, WsState } from "./types";

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
  "workspace.manage": "Название, валюта и настройки рабочего пространства", "workspace.delete": "Удалить рабочее пространство", "ownership.transfer": "Передать владение",
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
  for (const name of ["pipelines", "pipeline_stages", "companies", "contacts", "crm_leads", "deals", "deal_contacts", "tasks", "activities", "notes", "comments", "custom_fields", "custom_field_values", "attachments", "collections"]) t.set(name, []);
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
  if (demoParams.has("reports")) seedReports(id, t);
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
      workspaces.push({ info: { ...info(team, "Отдел продаж", "manager", false, members.length), remote: true }, members, tables: seed(team, true), prefs: new Map(), conflicts: [] });
      active = team;
    }
    active ??= personal;
  }
  return workspaces.find((w) => w.info.id === active) ?? workspaces[0]!;
}

/** Сбросить демо-данные (тесты). */
export function resetWsMock() {
  workspaces.length = 0;
  invitations.clear();
  auditLog.clear();
  lastMerge = null;
  active = null;
  imports.length = 0;
}

/** Сменить свою роль в активном Workspace (тесты): например, чтобы стать владельцем. */
export function setWsMockRole(role: string) {
  const ws = ensure();
  Object.assign(ws.info, { role, roleName: ROLE_NAME[role] ?? role, rank: RANK[role] ?? 0, permissions: ROLE_PERMS[role] ?? [] });
  const me = ws.members.find((m) => m.userId === ME);
  if (me) me.role = role;
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

/** Демо для экрана «Отчёты» (флаг ?reports): сделки за два месяца с историей этапов, причинами проигрыша и разными ответственными. */
function seedReports(id: string, t: Map<string, Row[]>) {
  const stages = t.get("pipeline_stages")!;
  const open = stages.filter((x) => x.kind === "open");
  const won = stages.find((x) => x.kind === "won")!;
  const lost = stages.find((x) => x.kind === "lost")!;
  const owners = [ME, "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
  const reasons = ["Дорого", "Выбрали конкурента", "дорого", "Нет бюджета", ""];
  const day = 86400_000;
  for (let i = 0; i < 18; i++) {
    const created = Date.now() - (2 + ((i * 7) % 55)) * day;
    const outcome = i % 3 === 0 ? "won" : i % 4 === 1 ? "lost" : "open";
    const depth = outcome === "won" ? open.length : 1 + (i % open.length);
    const path = open.slice(0, depth).map((x) => x.id as string);
    const final = outcome === "won" ? won : outcome === "lost" ? lost : open[depth - 1]!;
    if (outcome !== "open") path.push(final.id as string);
    const closed = outcome === "open" ? null : new Date(created + (5 + (i % 9) * 2) * day).toISOString();
    const expected = outcome === "open" ? new Date(Date.now() + ((i % 5) * 17 - 10) * day).toISOString().slice(0, 10) : null;
    const d = row(id, { title: `Демо-сделка ${i + 1}`, pipeline_id: final.pipeline_id, stage_id: final.id, amount: 20000 + ((i * 37000) % 300000), currency: "RUB", expected_close_date: expected,
      status: outcome, closed_at: closed, owner_id: owners[(i + (i >> 1)) % owners.length], lost_reason: outcome === "lost" ? reasons[i % reasons.length] || null : null, company_id: null });
    d.created_at = new Date(created).toISOString();
    t.get("deals")!.push(d);
    const end = closed ? Date.parse(closed) : Date.now() - day;
    path.forEach((to, k) => {
      const at = new Date(created + ((end - created) * k) / Math.max(path.length - 1, 1)).toISOString();
      const h = history.get(d.id) ?? [];
      h.push({ from_stage_id: k ? path[k - 1]! : null, to_stage_id: to, changed_by: ME, changed_at: at });
      history.set(d.id, h);
    });
  }
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
  if (type && type !== "task") for (const t of ["tasks", "activities", "notes", "comments", "custom_field_values", "attachments"]) out[t] = linked(t);
  const by = (t: string, field: string) => list(ws, t, { filters: [{ field, op: "eq", value: id }] }).items;
  if (name === "companies") { out.contacts = by("contacts", "company_id"); out.deals = by("deals", "company_id"); }
  if (name === "deals") { out.history = history.get(id) ?? []; out.dealContacts = by("deal_contacts", "deal_id"); }
  if (name === "contacts") out.dealLinks = by("deal_contacts", "contact_id");
  return out;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-zа-яё0-9@.+]/gi, "");
/** Объединение дубликатов в демо: то же, что ядро (`workspace/merge.rs`), с отменой последнего объединения. */
let lastMerge: { ws: string; info: CrmMergeInfo; rows: { table: string; id: string; before: Record<string, unknown>; version: number }[] } | null = null;
function mergeRun(ws: Ws, req: CrmMergeRequest) {
  if (!["companies", "contacts"].includes(req.entity)) fail("Объединять можно только компании и контакты.");
  if (!has(ws, "records.edit") || !has(ws, "records.delete")) fail("Недостаточно прав для объединения записей: нужно право менять и удалять любые записи.");
  if (req.keep === req.remove) fail("Выберите две разные записи.");
  const live = (id: string) => table(ws, req.entity).find((r) => r.id === id && !r.deleted_at);
  const keep = live(req.keep) ?? fail("Запись, которая остаётся, не найдена.");
  const remove = live(req.remove) ?? fail("Вторая запись не найдена или уже удалена.");
  const rows: { table: string; id: string; before: Record<string, unknown>; version: number }[] = [];
  const touch = (t: string, r: Row, fields: Record<string, unknown>) => {
    const before = Object.fromEntries(Object.keys(fields).map((k) => [k, r[k] ?? null]));
    const out = save(ws, t, r.id, fields);
    rows.push({ table: t, id: r.id, before, version: out.version });
  };
  const kind = req.entity === "companies" ? "company" : "contact";
  let moved = 0;
  if (Object.keys(req.values).length) touch(req.entity, keep, req.values); else rows.push({ table: req.entity, id: keep.id, before: {}, version: keep.version });
  const direct: [string, string][] = kind === "company" ? [["contacts", "company_id"], ["deals", "company_id"], ["crm_leads", "converted_company_id"]] : [["crm_leads", "converted_contact_id"]];
  for (const [t, col] of direct) for (const r of table(ws, t).filter((x) => x[col] === remove.id && !x.deleted_at)) { touch(t, r, { [col]: keep.id }); moved++; }
  if (kind === "contact") {
    for (const r of table(ws, "deal_contacts").filter((x) => x.contact_id === remove.id && !x.deleted_at)) {
      if (!table(ws, "deal_contacts").some((x) => x.deal_id === r.deal_id && x.contact_id === keep.id && !x.deleted_at)) {
        const created = save(ws, "deal_contacts", null, { deal_id: r.deal_id, contact_id: keep.id, role: r.role ?? null });
        rows.push({ table: "deal_contacts", id: created.id, before: { deleted_at: now() }, version: created.version });
        moved++;
      }
      touch("deal_contacts", r, { deleted_at: now() });
    }
  }
  for (const t of ["tasks", "activities", "notes", "comments", "attachments"]) {
    for (const r of table(ws, t).filter((x) => x.entity_type === kind && x.entity_id === remove.id && !x.deleted_at)) { touch(t, r, { entity_id: keep.id }); moved++; }
  }
  const values = table(ws, "custom_field_values");
  for (const r of values.filter((x) => x.entity_type === kind && x.entity_id === remove.id && !x.deleted_at)) {
    const mine = values.find((x) => x.entity_type === kind && x.entity_id === keep.id && x.field_id === r.field_id && !x.deleted_at);
    if ((mine && mine.value !== null) || r.value === null) touch("custom_field_values", r, { deleted_at: now() });
    else { if (mine) touch("custom_field_values", mine, { deleted_at: now() }); touch("custom_field_values", r, { entity_id: keep.id }); moved++; }
  }
  touch(req.entity, remove, { deleted_at: now() });
  const title = String((kind === "company" ? remove.name : remove.full_name) || "Без названия");
  const note = save(ws, "activities", null, { type: "system", occurred_at: now(), summary: `Объединено с «${title}»`, payload: { event: "merged", merged_id: remove.id }, entity_type: kind, entity_id: keep.id });
  rows.push({ table: "activities", id: note.id, before: { deleted_at: now() }, version: note.version });
  lastMerge = { ws: ws.info.id, info: { entity: req.entity, keep: keep.id, remove: remove.id, removedTitle: title, at: now() }, rows };
  return { kept: keep, moved };
}

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

// Экспорт (пакет G1): те же ключи и заголовки колонок, что в ядре (workspace/export.rs). Файл в демо не пишется —
// проверяются права, колонки и число записей, которые попали бы в выгрузку.
type ExportCol = [key: string, title: string, byDefault?: boolean];
const EXPORT_TAIL: ExportCol[] = [["created_at", "Создано"], ["updated_at", "Изменено"]];
const EXPORT_FIELDS: Record<string, ExportCol[]> = {
  companies: [["name", "Компания", true], ["legal_name", "Юридическое название"], ["inn", "ИНН", true], ["website", "Сайт", true], ["domain", "Домен"], ["phones", "Телефон компании", true],
    ["emails", "Почта компании", true], ["address", "Адрес", true], ["industry", "Отрасль", true], ["size_range", "Размер"], ["source", "Источник"], ["owner_id", "Ответственный", true], ...EXPORT_TAIL],
  contacts: [["full_name", "Контакт", true], ["first_name", "Имя"], ["last_name", "Фамилия"], ["position", "Должность", true], ["company_id", "Компания", true], ["phones", "Телефон", true],
    ["emails", "Почта", true], ["source", "Источник"], ["owner_id", "Ответственный", true], ...EXPORT_TAIL],
  deals: [["title", "Сделка", true], ["pipeline_id", "Воронка"], ["stage_id", "Этап", true], ["status", "Статус", true], ["amount", "Сумма", true], ["currency", "Валюта", true],
    ["expected_close_date", "Ожидаемое закрытие", true], ["company_id", "Компания", true], ["contact", "Контакт", true], ["lost_reason", "Причина проигрыша"], ["closed_at", "Закрыта"],
    ["owner_id", "Ответственный", true], ...EXPORT_TAIL],
  tasks: [["title", "Задача", true], ["description", "Описание"], ["status", "Статус", true], ["priority", "Приоритет", true], ["due_at", "Срок", true], ["remind_at", "Напомнить"],
    ["assignee_id", "Исполнитель", true], ["related", "Связано с", true], ["completed_at", "Выполнена"], ...EXPORT_TAIL],
  crm_leads: [["title", "Лид", true], ["person_name", "Контакт", true], ["company_name", "Компания", true], ["phones", "Телефон", true], ["emails", "Почта", true], ["status", "Статус", true],
    ["source", "Источник"], ["owner_id", "Ответственный", true], ...EXPORT_TAIL],
};

function exportFields(ws: Ws, name: string) {
  const base = EXPORT_FIELDS[name] ?? fail("Эти записи не выгружаются.");
  const type = Object.entries(TYPE_TABLE).find(([, t]) => t === name)?.[0];
  const custom = list(ws, "custom_fields", { filters: [{ field: "entity_type", op: "eq", value: type }], sort: [{ field: "position", dir: "asc" }], limit: 5000 }).items;
  return [
    ...base.map(([key, title, byDefault]) => ({ key, title, default: !!byDefault, custom: false })),
    ...custom.map((d) => ({ key: `cf:${d.id}`, title: String(d.label), default: true, custom: true })),
  ];
}

function exportRun(ws: Ws, r: CrmExportRequest): { count: number } {
  if (!has(ws, "records.export")) fail("Недостаточно прав для экспорта записей.");
  if (r.format !== "csv" && r.format !== "xlsx") fail(`Неизвестный формат файла: ${String(r.format)}`);
  let name = r.entity;
  let q: WsQuery = { ...(r.query ?? {}) };
  if (r.collection) {
    const c = table(ws, "collections").find((x) => x.id === r.collection) ?? fail("Коллекция не найдена.");
    const cfg = c.config as WsCollection["config"];
    name = TYPE_TABLE[c.entity_type as string] ?? fail("Неизвестный тип коллекции.");
    q = { ...q, filters: [...(cfg.filters ?? []), ...(q.filters ?? [])] };
  }
  const known = new Set(exportFields(ws, name).map((f) => f.key));
  if (!r.fields.length) fail("Выберите хотя бы одну колонку.");
  const unknown = r.fields.find((k) => !known.has(k));
  if (unknown) fail(`Неизвестная колонка: ${unknown}`);
  return { count: list(ws, name, { ...q, deleted: false, limit: 100_000, offset: 0 }).total };
}

const invitations = new Map<string, (WsInvitation & { token: string })[]>();
const auditLog = new Map<string, WsAuditItem[]>();
let auditSeq = 1;
function seedAudit(wsId: string) {
  if (auditLog.has(wsId)) return;
  auditLog.set(wsId, []); // вход участников в журнале есть с самого начала
  for (const m of workspaces.find((w) => w.info.id === wsId)?.members ?? []) audit(wsId, m.userId, "member_join", "member", m.userId, { role: m.role });
}
/** Запись в журнал демо-Workspace (как триггеры базы). */
function audit(wsId: string, actor: string | null, action: string, entityType: string | null, entityId: string | null, details: Record<string, unknown> = {}) {
  seedAudit(wsId);
  const list = auditLog.get(wsId) ?? [];
  list.unshift({ id: auditSeq++, actor_id: actor, action, entity_type: entityType, entity_id: entityId, at: now(), details });
  auditLog.set(wsId, list);
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
      if (!workspaces.some((w) => w.info.id === s("id"))) fail("Такого рабочего пространства нет в списке.");
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
    case "ws_set_local_details":
      ws.info = { ...ws.info, name: s("name").trim().slice(0, 120), defaultCurrency: s("currency").trim().toUpperCase() };
      return state();
    case "ws_list": return list(ws, s("entity"), (args.query as WsQuery) ?? {});
    case "ws_card": return card(ws, s("entity"), s("id"));
    case "ws_stage_history": {
      const alive = new Set(table(ws, "deals").filter((d) => !d.deleted_at).map((d) => d.id));
      return [...history.entries()].filter(([deal]) => alive.has(deal)).flatMap(([deal_id, h]) => h.map((x) => ({ deal_id, from_stage_id: x.from_stage_id, to_stage_id: x.to_stage_id, changed_at: x.changed_at })))
        .sort((a, b) => a.changed_at.localeCompare(b.changed_at));
    }
    case "ws_save": return save(ws, s("entity"), (args.id as string) ?? null, args.fields as Record<string, unknown>);
    case "ws_delete": return save(ws, s("entity"), s("id"), { deleted_at: now() });
    case "ws_restore": return save(ws, s("entity"), s("id"), { deleted_at: null });
    case "ws_duplicates": return duplicates(ws, s("entity"), args.fields as Record<string, unknown>, (args.except as string) ?? null);
    case "ws_convert_lead": {
      const lead = leads().find((l) => l.id === s("leadId")) ?? fail("Лид не найден.");
      return convert(ws, lead, (args.options as { createDeal?: boolean }) ?? {});
    }
    case "ws_collections": return collections(ws);
    case "ws_import_read": case "ws_import_preview": case "ws_import_run": case "ws_import_history": case "ws_import_undo":
      return importCall(ws, cmd, args);
    case "ws_collection_items": {
      const c = table(ws, "collections").find((x) => x.id === s("id")) ?? fail("Коллекция не найдена.");
      const cfg = c.config as WsCollection["config"];
      const q = (args.query as WsQuery) ?? {};
      const t = TYPE_TABLE[c.entity_type as string] ?? fail("Неизвестный тип коллекции.");
      return { collection: c, entity: t, ...list(ws, t, { ...q, filters: [...(cfg.filters ?? []), ...(q.filters ?? [])], sort: q.sort?.length ? q.sort : cfg.sort }) };
    }
    case "ws_export_fields": return exportFields(ws, s("entity"));
    case "ws_export": return exportRun(ws, args.request as CrmExportRequest);
    case "ws_merge": return mergeRun(ws, args.request as CrmMergeRequest);
    case "ws_merge_last": return lastMerge && lastMerge.ws === ws.info.id && lastMerge.rows.every((r) => table(ws, r.table).find((x) => x.id === r.id)?.version === r.version) ? lastMerge.info : null;
    case "ws_merge_undo": {
      const m = lastMerge;
      if (!m || m.ws !== ws.info.id) return fail("Нечего отменять.");
      if (!m.rows.every((r) => table(ws, r.table).find((x) => x.id === r.id)?.version === r.version)) fail("Отменить нельзя: после объединения записи уже изменились или ушли на сервер.");
      for (const r of [...m.rows].reverse()) save(ws, r.table, r.id, r.before);
      lastMerge = null;
      return m.info;
    }
    case "ws_reorder_collections":
      (args.ids as string[]).forEach((id, i) => ws.prefs.set(id, { position: i + 1, hidden: ws.prefs.get(id)?.hidden ?? false }));
      return null;
    case "ws_hide_collection":
      ws.prefs.set(s("id"), { position: ws.prefs.get(s("id"))?.position ?? 0, hidden: Boolean(args.hidden) });
      return null;
    case "ws_attach_add": {
      const size = Math.floor((s("data").length * 3) / 4) - (s("data").match(/=+$/)?.[0].length ?? 0);
      if (size > 5 * 1024 * 1024) fail("Файл больше 5 МБ.");
      if (!s("name").trim()) fail("У файла нет имени.");
      return save(ws, "attachments", null, { entity_type: s("entityType"), entity_id: s("entityId"), name: s("name").trim().slice(0, 255), mime: s("mime"), size });
    }
    case "ws_attach_save": return table(ws, "attachments").find((a) => a.id === s("id"))?.name ?? fail("Вложение не найдено.");
    case "ws_presence": {
      // Демо: Борис всегда онлайн, Вера смотрит ту же карточку, что и вы.
      if (!demoParams.has("team")) return [];
      const others = ws.members.filter((m) => m.userId !== ME).slice(0, 2);
      return others.map((m, i) => ({ user_id: m.userId, entity_type: i === 1 ? (args.entityType as string | null) : null, entity_id: i === 1 ? (args.entityId as string | null) : null, seen_at: now() }));
    }
    case "ws_upload_local": {
      if (!demoParams.has("team")) fail("Загрузка доступна в облачной учётной записи.");
      const id = `ws-${uid()}`;
      const tables = new Map([...ws.tables].map(([k, rows]) => [k, rows.filter((r) => !r.deleted_at).map((r) => ({ ...r, workspace_id: id }))]));
      workspaces.push({ info: info(id, ws.info.name, "owner", false, 1), members: [member(ME, "Анна", "owner")], tables, prefs: new Map(), conflicts: [] });
      active = id;
      const copied = [...tables.values()].reduce((n, rows) => n + rows.length, 0);
      return { workspace: id, copied, skipped: 0, state: state() };
    }
    case "ws_roles": {
      if (!demoParams.has("team")) return { roles: [], catalog: [] };
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
      const email = s("email").toLowerCase();
      const list = invitations.get(ws.info.id) ?? [];
      if (list.some((i) => i.email === email)) fail("Этому адресу уже отправлено открытое приглашение.");
      const inv = { id: uid(), email, role: s("role"), roleName: ROLE_NAME[s("role")] ?? s("role"), createdAt: now(), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), sentCount: 1, lastSentAt: now(), invitedBy: ME, token };
      invitations.set(ws.info.id, [inv, ...list]);
      return { id: inv.id, email, role: inv.role, expiresAt: inv.expiresAt, token, link: `customers://invite?token=${token}` };
    }
    case "ws_invitations": {
      if (!demoParams.has("team")) return [];
      if (!has(ws, "invitations.manage")) fail("Нет прав на приглашения.");
      return (invitations.get(ws.info.id) ?? []).map(({ token: _t, ...i }) => i);
    }
    case "ws_revoke_invitation": {
      if (!has(ws, "invitations.manage")) fail("Нет прав на приглашения.");
      invitations.set(ws.info.id, (invitations.get(ws.info.id) ?? []).filter((i) => i.id !== s("id")));
      return true;
    }
    case "ws_resend_invitation": {
      if (!has(ws, "invitations.manage")) fail("Нет прав на приглашения.");
      const inv = (invitations.get(ws.info.id) ?? []).find((i) => i.id === s("id")) ?? fail("Приглашение не найдено.");
      if (inv.sentCount >= 5) fail("Приглашение отправлялось слишком много раз (не больше 5).");
      if (Date.now() - Date.parse(inv.lastSentAt) < 10 * 60_000) fail("Повторно отправить можно не раньше чем через 10 минут.");
      inv.sentCount += 1; inv.lastSentAt = now(); inv.expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString(); inv.token = `demo${uid().slice(-12)}`;
      return { id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, token: inv.token, link: `customers://invite?token=${inv.token}` };
    }
    case "ws_audit": {
      if (!demoParams.has("team")) return { items: [], more: false };
      if (!has(ws, "audit.view")) fail("Нет прав на журнал действий.");
      seedAudit(ws.info.id);
      const f = (auditLog.get(ws.info.id) ?? []).filter((i) => (!args.actor || i.actor_id === args.actor) && (!args.action || i.action === args.action) && (!args.entityId || i.entity_id === args.entityId));
      const off = Number(args.offset ?? 0);
      return { items: f.slice(off, off + 100), more: f.length > off + 100 };
    }
    case "ws_set_member_role": {
      if (!demoParams.has("team")) return remoteOnly();
      if (!has(ws, "members.manage")) fail("Нет прав на изменение ролей.");
      const m = ws.members.find((x) => x.userId === s("user")) ?? fail("Участник не найден.");
      Object.assign(m, member(m.userId, m.displayName, s("role"), ws.info.id));
      audit(ws.info.id, ME, "member_role", "member", m.userId, { role: s("role") });
      return state();
    }
    case "ws_transfer_ownership": {
      if (!demoParams.has("team")) return remoteOnly();
      if (!has(ws, "ownership.transfer")) fail("Передать владение может только владелец.");
      const target = ws.members.find((x) => x.userId === s("user") && x.userId !== ME) ?? fail("Владельцем можно сделать только другого участника.");
      Object.assign(target, member(target.userId, target.displayName, "owner", ws.info.id));
      const myself = ws.members.find((x) => x.userId === ME);
      if (myself) Object.assign(myself, member(ME, myself.displayName, "admin", ws.info.id));
      Object.assign(ws.info, { role: "admin", roleName: ROLE_NAME.admin, rank: RANK.admin, permissions: ROLE_PERMS.admin ?? [] });
      audit(ws.info.id, ME, "member_role", "member", s("user"), { role: "owner" });
      return state();
    }
    case "ws_delete_workspace": {
      if (!demoParams.has("team")) return remoteOnly();
      if (!has(ws, "workspace.delete")) fail("Удалить рабочее пространство может только владелец.");
      if (ws.info.personal) fail("Личное рабочее пространство удалить нельзя.");
      if (s("confirmName").trim() !== ws.info.name) fail("Название не совпадает.");
      const i = workspaces.indexOf(ws);
      workspaces.splice(i, 1);
      active = workspaces.find((w) => w.info.personal)?.info.id ?? workspaces[0]?.info.id ?? null;
      return state();
    }
    case "ws_remove_member":
      if (!demoParams.has("team")) return remoteOnly();
      if (!has(ws, "members.manage")) fail("Нет прав на удаление участников.");
      ws.members = ws.members.filter((x) => x.userId !== s("user"));
      audit(ws.info.id, ME, "member_removed", "member", s("user"));
      return state();
    case "ws_accept_invitation": case "ws_leave": return remoteOnly();
    default: return null;
  }
}

// ------------------------------------------------------------------ импорт таблиц (упрощённо: CSV, компании и контакты)

const IMPORT_FIELDS: [string, string, string[]][] = [
  ["company.name", "Компания: название", ["компани", "организац", "название", "клиент"]],
  ["company.website", "Компания: сайт", ["сайт", "website"]],
  ["company.address", "Компания: адрес", ["адрес", "город"]],
  ["contact.full_name", "Контакт: имя и фамилия", ["контакт", "фио", "имя"]],
  ["contact.phone", "Контакт: телефон", ["телефон", "тел"]],
  ["contact.email", "Контакт: почта", ["почта", "email"]],
  ["deal.title", "Сделка: название", ["сделка"]],
  ["deal.amount", "Сделка: сумма", ["сумма", "бюджет"]],
  ["note", "Заметка", ["заметка", "комментарий"]],
];
const imports: { id: string; file: string; createdAt: string; summary: Record<string, unknown>; undoneAt: string | null; created: [string, string][] }[] = [];

function importTable(name: string, data: string): { headers: string[]; rows: string[][] } {
  if (!/\.(csv|txt)$/i.test(name)) fail("В демо читается только CSV.");
  const text = new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0))).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = (lines[0] ?? "").includes(";") ? ";" : ",";
  const [head, ...rows] = lines.map((l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, "")));
  if (!head) fail("Файл пустой.");
  return { headers: head!, rows };
}

function importCall(ws: Ws, cmd: string, args: Record<string, unknown>): unknown {
  if (cmd === "ws_import_history") return imports.slice().reverse().map(({ created: _c, ...b }) => b);
  if (cmd === "ws_import_undo") {
    const b = imports.find((x) => x.id === args.batch) ?? fail("Импорт не найден.");
    if (b.undoneAt) return { removed: 0, alreadyUndone: true };
    for (const [t, id] of [...b.created].reverse()) save(ws, t, id, { deleted_at: now() });
    b.undoneAt = now();
    return { removed: b.created.length, failed: 0 };
  }
  const t = importTable(args.name as string, args.data as string);
  if (cmd === "ws_import_read") {
    const used = new Set<string>();
    const mapping = t.headers.map((h) => {
      const f = IMPORT_FIELDS.find(([k, , syn]) => !used.has(k) && syn.some((x) => h.toLowerCase().includes(x)));
      if (f) used.add(f[0]);
      return f?.[0] ?? null;
    });
    return { headers: t.headers, rows: t.rows.length, sample: t.rows.slice(0, 5), mapping, fields: IMPORT_FIELDS.map(([key, label]) => ({ key, label })) };
  }
  const o = args.options as { mapping: (string | null)[]; duplicates: string };
  if (!o.mapping.some(Boolean)) fail("Сопоставьте хотя бы одну колонку.");
  const col = (r: string[], key: string) => { const i = o.mapping.indexOf(key); return i >= 0 ? (r[i] ?? "").trim() : ""; };
  const items = t.rows.map((r, i) => {
    const company = col(r, "company.name") || null;
    const contact = col(r, "contact.full_name") || null;
    const deal = col(r, "deal.title") || null;
    const found = company ? table(ws, "companies").find((c) => !c.deleted_at && String(c.name).toLowerCase() === company.toLowerCase()) : undefined;
    const status = !company && !contact && !deal ? "empty" : !company && !contact ? "error" : found ? (o.duplicates === "skip" ? "skip" : o.duplicates === "create" ? "new" : "existing") : "new";
    return { line: i + 2, company, contact, deal, status, existing: found && o.duplicates === "link" ? String(found.name) : null, messages: status === "error" ? ["Нет компании и контакта"] : [] };
  });
  const count = (s: string) => items.filter((x) => x.status === s).length;
  if (cmd === "ws_import_preview") {
    return { rows: items.length, new: count("new"), existing: count("existing"), skipped: count("skip"), errors: count("error"), empty: count("empty"),
      deals: items.filter((x) => x.deal).length, contacts: items.filter((x) => x.contact).length, warnings: 0, items: items.slice(0, 100) };
  }
  const created: [string, string][] = [];
  const sum = { companies: 0, contacts: 0, deals: 0, notes: 0, linked: 0, skipped: count("skip"), errors: count("error"), unknownStages: [] as string[] };
  t.rows.forEach((r, i) => {
    const it = items[i]!;
    if (it.status === "skip" || it.status === "error" || it.status === "empty") return;
    let companyId: string | null = null;
    if (it.company) {
      const found = it.status === "existing" ? table(ws, "companies").find((c) => String(c.name).toLowerCase() === it.company!.toLowerCase()) : undefined;
      if (found) { companyId = found.id; sum.linked += 1; }
      else { const c = save(ws, "companies", null, { name: it.company, website: col(r, "company.website") || null, address: col(r, "company.address") || null }); companyId = c.id; created.push(["companies", c.id]); sum.companies += 1; }
    }
    if (it.contact) {
      const [first, ...last] = it.contact.split(/\s+/);
      const c = save(ws, "contacts", null, { first_name: first, last_name: last.join(" ") || null, company_id: companyId, phones: col(r, "contact.phone") ? [col(r, "contact.phone")] : [], emails: col(r, "contact.email") ? [col(r, "contact.email")] : [] });
      created.push(["contacts", c.id]);
      sum.contacts += 1;
    }
  });
  const id = `imp-${uid()}`;
  if (created.length) imports.push({ id, file: args.name as string, createdAt: now(), summary: sum, undoneAt: null, created });
  return { ...sum, batchId: created.length ? id : null, errorRows: items.filter((x) => x.status === "error").map((x) => ({ line: x.line, message: x.messages.join("; ") })) };
}
