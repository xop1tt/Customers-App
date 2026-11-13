// Демо-реализация команд для запуска вне Tauri: браузер, тесты и снимки экрана.
// Данные выдуманные; в собранное приложение эта часть не загружается (динамический импорт).

import { IN_TEST } from "./wsMock";
import catalog from "../../src-tauri/data/osm_catalog.json";
import type {
  AccountPrefs, BootInfo, DevicePrefs, DrivesState, Exclusion, ExclusionKind, Lead, OsmCategory, SearchSettings, SearchStatus, SessionInfo, Snapshot, SourceReport,
  SyncStatus, UpdateInfo, WsState, AiChatReply,
} from "./types";
import { wsCall } from "./wsMock";
import { teamCall } from "./chatMock";
import { marketCall } from "./marketMock";

type Handler = (p: unknown) => void;
const listeners = new Map<string, Set<Handler>>();

export function listen(event: string, handler: Handler): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
  return () => listeners.get(event)?.delete(handler);
}

function emit(event: string, payload: unknown = null) {
  listeners.get(event)?.forEach((h) => h(payload));
}

const demo = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3600_000).toISOString();

// ------------------------------------------------------------------ данные

const ORG_NAMES = [
  ["Студия красоты «Лаванда»", "Казань", "ул. Баумана, 44", "beauty", "+7 843 212-48-90", ""],
  ["Танцевальная школа «Ритм»", "Казань", "ул. Пушкина, 12", "dance", "+7 843 555-10-20", "ritm-dance.ru"],
  ["Кофейня «Зерно»", "Санкт-Петербург", "Невский пр., 71", "restaurant", "+7 812 300-11-22", ""],
  ["Автосервис «Мотор»", "Казань", "ул. Декабристов, 85", "auto", "+7 843 270-33-44", "motor-kzn.ru"],
  ["Фитнес-клуб «Атлант»", "Москва", "ул. Тверская, 9", "fitness", "+7 495 777-88-99", "atlant-fit.ru"],
  ["Стоматология «Белый зуб»", "Казань", "пр. Ямашева, 36", "medical", "+7 843 590-12-12", ""],
  ["Цветочный магазин «Флора»", "Санкт-Петербург", "ул. Рубинштейна, 20", "shop", "+7 812 400-50-60", ""],
  ["Языковая школа «Полиглот»", "Москва", "Ленинский пр., 15", "education", "+7 495 100-20-30", "poliglot-school.ru"],
] as const;

const ORDERS = [
  ["Нужен сайт для кофейни с онлайн-меню", 25000, "Нужен сайт и телеграм-бот для приёма заказов. Срочно, оплата по факту."],
  ["Разработка Telegram-бота для записи клиентов", 40000, "Бот для салона красоты: запись, напоминания, оплата."],
  ["Доработка интернет-магазина на Tilda", 15000, "Исправить корзину, добавить фильтры по цене."],
  ["Лендинг для автосервиса", 18000, "Одностраничный сайт с формой записи."],
  ["Интеграция CRM с сайтом", 60000, "Нужна интеграция Bitrix24 с формой на сайте, API."],
  ["Парсер цен конкурентов", 22000, "Ежедневный сбор цен с трёх сайтов, выгрузка в таблицу."],
] as const;

function makeLeads(): Lead[] {
  const out: Lead[] = [];
  ORG_NAMES.forEach((o, i) => {
    const [title, region, address, category, phone, site] = o;
    const score = [84, 71, 66, 52, 38, 77, 61, 44][i] ?? 50;
    out.push({
      id: `osm${i}`,
      discoveredAt: ago(2 + i * 9),
      favorite: i === 0,
      archived: false,
      excluded: false,
      seen: i > 2,
      note: i === 0 ? "Позвонить во вторник, спросить про запись онлайн." : "",
      phones: [phone],
      emails: i % 2 === 0 ? [`info${i}@example.ru`] : [],
      data: {
        kind: "organization", source: "osm_organizations", external_id: `node/${1000 + i}`, title, url: `https://www.openstreetmap.org/node/${1000 + i}`,
        description: "", region, address, phone, website: site || undefined, category, contacts: i % 2 === 0 ? { email: `info${i}@example.ru` } : {},
        facts: site ? ["Сайт открылся (200) при проверке 05.11.2026", "Нет мобильной версии: не найден viewport"] : ["Сайт в карточке организации не указан"],
        assumptions: ["Клиентам может быть удобна онлайн-запись"],
        score, relevance: score >= 70 ? "high" : score >= 45 ? "medium" : "low",
        score_reasons: site ? ["Сайт без мобильной версии (+20)", "Категория с высоким спросом (+15)"] : ["Нет сайта (+35)", "Категория с высоким спросом (+15)", "Контакты неполные (-5)"],
        status: "new", external_results: i === 1 ? [{ service: "Анализатор сайтов", ok: true, score: 72, label: "Устарел дизайн" }] : [],
      },
    });
  });
  ORDERS.forEach((o, i) => {
    const [title, budget, description] = o;
    const score = [88, 74, 55, 47, 81, 36][i] ?? 50;
    out.push({
      id: `fl${i}`,
      discoveredAt: ago(1 + i * 5),
      favorite: false,
      archived: i === 5,
      excluded: false,
      seen: i > 1,
      note: "",
      phones: i === 0 ? ["+7 999 123-45-67"] : [],
      emails: [],
      data: {
        kind: "order", source: i % 2 ? "telegram_channels" : "fl_ru", external_id: `${i}`, title, url: `https://fl.ru/projects/${i}`, description, budget, currency: "RUB",
        published_at: ago(1 + i * 5), contacts: i === 0 ? { phone: "+7 999 123-45-67" } : {}, facts: [], assumptions: [], score,
        relevance: score >= 70 ? "high" : score >= 45 ? "medium" : "rejected",
        score_reasons: i === 0 ? ["Есть бюджет (+15)", "Явный запрос на разработку (+30)", "Просят срочно (+10)"] : ["Есть бюджет (+15)"], status: "new", external_results: [],
      },
    });
  });
  for (let i = 0; i < 14; i++) {
    out.push({
      id: `ex${i}`,
      discoveredAt: ago(30 + i * 11),
      favorite: false, archived: false, excluded: false, seen: true, note: "", phones: [], emails: [],
      data: {
        kind: i % 3 ? "order" : "organization", source: i % 3 ? "telegram_channels" : "osm_organizations", external_id: `x${i}`,
        title: i % 3 ? `Заказ из канала №${i + 1}: нужен сайт-визитка` : `Организация №${i + 1}`, url: "", description: "Описание заказа.",
        budget: i % 3 ? 8000 + i * 1000 : undefined, region: i % 2 ? "Казань" : "Москва", contacts: {}, facts: [], assumptions: [],
        score: 20 + ((i * 17) % 70), relevance: "medium", score_reasons: [], status: "new", external_results: [],
      },
    });
  }
  return out;
}

let leads: Lead[] = makeLeads();
let exclusions: Exclusion[] = [{ id: 1, kind: "domain", value: "example-spam.ru", created_at: ago(70) }];
let nextExclusion = 2;
const eventsLog = new Map<string, { id: number; at: string; action: string }[]>();
let eventId = 1;

const baseDevice: DevicePrefs = {
  accent: null, theme: "system", language: "system", uiScale: 1, navWidth: 260, navOpen: true, navHidden: false, inspectorWidth: 400, inspectorShown: true, compactRows: false, animations: true,
  sidebarHidden: [], sidebarHiddenSources: [], sidebarOrder: [], sidebarSourceOrder: [], sidebarCounts: true, sidebarSources: true, sidebarHover: true, sidebarCollapsed: [],
  lightModeAuto: true, lightModeThreshold: 20, checkUpdates: true, updateCheckHours: 24, lastUpdateCheck: ago(3), backgroundDownload: true,
  lastSeenVersion: "1.1.0", closeToTray: true, startMinimized: false, launchAtLogin: false, trayHintShown: true, lastSection: "home",
  listSort: "score", listSortDescending: true, reportsOfferAfterCrash: true, reportsLogErrors: true, reportsIncludeLog: true, reportsLastSeen: null, legacyImported: true,
};
let device: DevicePrefs = { ...baseDevice };

let account: AccountPrefs = {
  autoSearchMinutes: 120, newLeadsSearches: 1, signature: "", backupDirectory: "~/Documents/Customers Backups", autoBackup: true, keepBackups: 14, dataPath: null,
  notifyNewLeads: true, notifyErrors: true, notifySync: false, notifyMessages: true, mailAccount: "", mailDelivery: "mailApp", confirmCalls: true, confirmCallsVersion: 1, callApp: "system",
  welcomeDone: !demo.has("welcome"), exportLastTab: "file",
};

function defaultSettings(): SearchSettings {
  return {
    rss: { enabled: true, intervalHours: 2, feeds: ["https://www.fl.ru/rss/all.xml"], keywords: [] },
    telegram: { enabled: true, intervalHours: 3, channels: ["teleworko", "freetasks"], maxPages: 3, keywords: ["сайт", "бот", "crm"] },
    vk: { enabled: false, intervalHours: 6, communities: [], pageSize: 20, maxPages: 3, keywords: [] },
    osm: {
      enabled: true, intervalHours: 120, regions: ["Казань", "Санкт-Петербург"], categories: (catalog.categories as OsmCategory[]).map((c) => ({ ...c })),
      checkWebsites: true, refreshDays: 7, recheckDays: 60, maxNewPerRun: 40, endpoint: "https://overpass-api.de/api/interpreter",
    },
  };
}
let settings = defaultSettings();
let hasVk = false;

const sources = [
  { source: "fl_ru", last_success_at: ago(1.5), last_attempt_at: ago(1.5), consecutive_failures: 0, status: "ok", last_error: null },
  { source: "telegram_channels", last_success_at: ago(26), last_attempt_at: ago(3), consecutive_failures: 2, status: "partial", last_error: "Канал freetasks: превышено время ожидания" },
  { source: "osm_organizations", last_success_at: ago(40), last_attempt_at: ago(40), consecutive_failures: 0, status: "ok", last_error: null },
];

const syncLog = [
  { id: 4, at: ago(1.5), ok: true, added: 3, updated: 1, message: "Поиск завершён: новых 3, обновлено 1." },
  { id: 3, at: ago(26), ok: false, added: 0, updated: 0, message: "Поиск завершён: новых 0, обновлено 0. С ошибками: Telegram-каналы" },
  { id: 2, at: ago(50), ok: true, added: 7, updated: 0, message: "Поиск завершён: новых 7, обновлено 0." },
  { id: 1, at: ago(75), ok: true, added: 12, updated: 2, message: "Поиск завершён: новых 12, обновлено 2." },
];

const pipelineErrors = [
  { id: 2, at: ago(3), module: "telegram_channels", message: "Канал freetasks: превышено время ожидания" },
  { id: 1, at: ago(30), module: "telegram_channels", message: "Канал theyseeku: страница недоступна (HTTP 502)" },
];

let search: SearchStatus = {
  running: false, progress: null,
  lastReport: {
    cancelled: false,
    sources: [
      { source: "fl_ru", found: 30, added: 3, updated: 1, duplicates: 26, skipped: null, warnings: [], errors: [], failed: false },
      { source: "telegram_channels", found: 14, added: 0, updated: 0, duplicates: 14, skipped: null, warnings: [], errors: ["Канал freetasks: превышено время ожидания"], failed: true },
    ] as SourceReport[],
  },
};

// Живое демо начинается со страницы входа и всегда облачное; тесты по-прежнему стартуют с открытой сессией.
let signedIn = demo.has("auth") ? false : IN_TEST ? !demo.has("local") : false;
let cloud = IN_TEST ? demo.has("cloud") : true;
let profile: { name: string | null; avatar: string | null } = { name: null, avatar: null };
let signedEmail = "alex@example.ru";
const session = (): SessionInfo => ({
  id: cloud ? "cloud-1" : "alex", displayName: profile.name ?? (cloud ? signedEmail : "alex"), avatar: profile.avatar,
  cloudUser: cloud ? { id: "1", email: signedEmail, newEmail: null, confirmed: true } : null, databasePath: "/Users/demo/Library/Application Support/Customers/demo/leads.db",
});

let update: UpdateInfo = {
  phase: demo.has("update") ? "ready" : "idle", current: "1.1.0", canUpdate: true, available: demo.has("update") ? { version: "1.2.0", title: "Customers 1.2.0", notes: "• Новый интерфейс", page: null, size: 90_000_000 } : null,
  stagedVersion: demo.has("update") ? "1.2.0" : null, lastCheck: ago(3), releasesPage: "https://github.com/xop1tt/Customers-App/releases",
};

const sync = (): SyncStatus => ({ enabled: cloud, kind: "idle", message: null, lastSync: ago(0.2), pending: 0 });

function snapshot(): Snapshot {
  return { leads, sources, pipelineErrors, exclusions, syncLog, lastSearchAt: ago(1.5), databaseSize: 2_400_000 };
}

function log(id: string, action: string) {
  const list = eventsLog.get(id) ?? [];
  list.unshift({ id: eventId++, at: new Date().toISOString(), action });
  eventsLog.set(id, list);
}

function patchLeads(ids: string[], f: (l: Lead) => void) {
  for (const l of leads) if (ids.includes(l.id)) f(l);
  emit("data-changed");
}

/** Ключ восстановления переносимой копии в демо (G8). */
let portableKey: string | null = null;

const drives: DrivesState = {
  redirect: "http://127.0.0.1:47811/callback", busy: null,
  providers: [
    { provider: "google", clientIdLabel: "Client ID", consolePage: "https://console.cloud.google.com/apis/credentials", needsSecret: true, buildVariable: "GOOGLE_OAUTH_CLIENT_ID", builtIn: false, hasKey: false },
    { provider: "dropbox", clientIdLabel: "App key", consolePage: "https://www.dropbox.com/developers/apps", needsSecret: false, buildVariable: "DROPBOX_OAUTH_CLIENT_ID", builtIn: false, hasKey: false },
  ],
  drives: [
    { service: "googleDrive", title: "Google Диск", subtitle: "Копии в папке приложения", kind: "oauth", provider: "google", connected: false, connectedAt: null, available: false, defaultUrl: "", passwordPage: null, passwordOptional: false, webdavUrl: null, login: null },
    { service: "dropbox", title: "Dropbox", subtitle: "Копии в папке приложения", kind: "oauth", provider: "dropbox", connected: false, connectedAt: null, available: false, defaultUrl: "", passwordPage: null, passwordOptional: false, webdavUrl: null, login: null },
    { service: "yandexDisk", title: "Яндекс Диск", subtitle: "По WebDAV с паролем приложения", kind: "webdav", provider: null, connected: true, connectedAt: ago(100), available: true, defaultUrl: "https://webdav.yandex.ru", passwordPage: "https://id.yandex.ru/security/app-passwords", passwordOptional: false, webdavUrl: "https://webdav.yandex.ru/", login: "alex" },
    { service: "webdav", title: "WebDAV", subtitle: "Nextcloud, ownCloud и другие", kind: "webdav", provider: null, connected: false, connectedAt: null, available: true, defaultUrl: "", passwordPage: null, passwordOptional: true, webdavUrl: null, login: null },
  ],
};

// ------------------------------------------------------------------ команды

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Демо «Ai»: настройки в памяти, ответы модели задаются тестом. */
export const hubDemo = {
  blob: {} as unknown,
  /** Уведомления от помощника, отправленные ядру. */
  notified: [] as { title: string; body: string }[],
  models: ["demo-model-7b", "llama3.1"],
  /** Ответ модели на запрос; по умолчанию — короткий текст. */
  reply: ((_body: { messages: { role: string; content?: string | null }[] }): AiChatReply => ({ choices: [{ message: { role: "assistant", content: "Это демо-ответ локальной модели." } }] })) as (body: { messages: { role: string; content?: string | null }[] }) => AiChatReply,
  reset() { this.blob = {}; this.notified = []; this.models = ["demo-model-7b", "llama3.1"]; this.reply = () => ({ choices: [{ message: { role: "assistant", content: "Это демо-ответ локальной модели." } }] }); },
};

export async function call(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  if (cmd === "hub_load") return structuredClone(hubDemo.blob);
  if (cmd === "hub_save") { hubDemo.blob = structuredClone(args.value); return null; }
  if (cmd === "ai_models") {
    if (!/^https?:\/\//.test(String(args.baseUrl))) throw { code: "", message: "Адрес сервера модели: например, http://localhost:1234/v1" };
    if (String(args.baseUrl).includes("offline")) throw { code: "", message: "Сервер модели недоступен: connection refused. Запущен ли он и включён ли локальный сервер?" };
    return [...hubDemo.models];
  }
  if (cmd === "ai_notify") { hubDemo.notified.push({ title: String(args.title), body: String(args.body) }); return null; }
  if (cmd === "ai_chat") return hubDemo.reply(args.body as { messages: { role: string; content?: string | null }[] });
  if (cmd === "ws_market") {
    const ws = (await wsCall("ws_state", {}, () => leads)) as WsState;
    const remote = ws.workspaces.find((w) => w.id === ws.active)?.remote ?? false;
    // В демо облачной команды (?team) вы — ещё и модератор маркетплейса.
    return marketCall(String(args.action), (args.args ?? {}) as Record<string, unknown>,
      { cloud: ws.isCloud, me: ws.me, wsId: remote ? ws.active : null, perms: ws.permissions, moderator: ws.isCloud });
  }
  if (["ws_team", "ws_update_member", "ws_chat", "ws_chat_poll"].includes(cmd)) {
    const ws = (await wsCall("ws_state", {}, () => leads)) as WsState;
    const me = session();
    if (cmd === "ws_chat" && args.action === "chat_post") {
      // Как сервер: название и подпись карточки берутся из CRM этого рабочего пространства.
      const a = (args.args ?? {}) as Record<string, unknown>;
      const refs = (a.attachments as { type: string; id: string }[] | undefined) ?? [];
      const cards = [];
      for (const r of refs) {
        const table = ({ company: "companies", contact: "contacts", crm_lead: "crm_leads", deal: "deals" } as Record<string, string>)[r.type];
        const rows = table ? ((await wsCall("ws_list", { entity: table, query: { limit: 10000 } }, () => leads)) as { items: Record<string, unknown>[] }).items : [];
        const row = rows.find((x) => x.id === r.id);
        if (!row) throw { code: "error", message: "Карточка не найдена в этом рабочем пространстве." };
        const title = String(row.name ?? row.full_name ?? row.title ?? "");
        const subtitle = String(r.type === "deal" ? `${row.amount ?? 0} ${row.currency ?? "RUB"}` : r.type === "contact" ? row.position ?? "" : r.type === "crm_lead" ? row.company_name ?? "" : row.legal_name ?? "");
        cards.push({ type: r.type, id: r.id, title, subtitle, available: true });
      }
      args = { ...args, args: { ...a, attachments: cards } };
    }
    return teamCall(cmd, args, { team: ws.isCloud, me: ws.me, myName: me.displayName, myAvatar: me.avatar ?? null, wsId: ws.active ?? "", members: ws.members, perms: ws.permissions });
  }
  if (cmd.startsWith("ws_")) {
    const out = await wsCall(cmd, args, () => leads);
    if (["ws_save", "ws_delete", "ws_restore", "ws_merge", "ws_merge_undo", "ws_convert_lead", "ws_switch", "ws_create_workspace", "ws_rename_workspace", "ws_set_local_details", "ws_reorder_collections", "ws_hide_collection", "ws_resolve_conflict"].includes(cmd)) {
      setTimeout(() => emit("workspace-changed", null), 0);
      if (cmd === "ws_convert_lead") {
        const c = out as { workspaceId: string; companyId: string; contactId: string | null; dealId: string | null };
        patchLeads([String(args.leadId)], (l) => { l.data.crm = { workspace_id: c.workspaceId, company_id: c.companyId, contact_id: c.contactId, deal_id: c.dealId, converted_at: new Date().toISOString() }; });
      }
    }
    return out;
  }
  switch (cmd) {
    case "boot_info":
      return {
        version: "1.1.0", platform: demo.get("platform") === "windows" ? "windows" : "macos", cloudAvailable: true,
        session: signedIn ? session() : null, device, error: null,
      } satisfies BootInfo;
    case "cloud_sign_in":
      if (String(args.email)) signedEmail = String(args.email);
      if (String(args.password) === "wrong") throw { code: "", message: "Неверный адрес почты или пароль." };
      signedIn = true;
      cloud = true;
      emit("session-changed", session());
      return null;
    case "cloud_sign_up":
      profile = { ...profile, name: String(args.username ?? "") || null };
      return String(args.email);
    case "set_profile":
      if (args.name != null) profile = { ...profile, name: String(args.name) };
      if (args.avatar != null) profile = { ...profile, avatar: String(args.avatar) || null };
      emit("session-changed", session());
      return session();
    case "call_apps":
      return [
        { id: "system", title: "Стандартное приложение системы", installed: true, opensChat: false },
        { id: "whatsapp", title: "WhatsApp", installed: true, opensChat: true },
        { id: "telegram", title: "Telegram", installed: true, opensChat: true },
        { id: "viber", title: "Viber", installed: false, opensChat: true },
        { id: "skype", title: "Skype", installed: false, opensChat: false },
      ];
    case "cloud_confirm":
    case "cloud_finish_reset":
    case "cloud_set_password_after_recovery":
      signedIn = true;
      cloud = true;
      emit("session-changed", session());
      return null;
    case "cloud_request_reset":
      return String(args.email);
    case "logout":
      signedIn = false;
      emit("session-ended", { reason: "" });
      return null;
    case "snapshot":
      return snapshot();
    case "lead_events":
      return eventsLog.get(String(args.id)) ?? [{ id: 0, at: leads.find((l) => l.id === args.id)?.discoveredAt ?? ago(5), action: "Найден" }];
    case "set_favorite":
      patchLeads(args.ids as string[], (l) => (l.favorite = !!args.on));
      return null;
    case "set_archived":
      patchLeads(args.ids as string[], (l) => (l.archived = !!args.on));
      return null;
    case "delete_leads":
      leads = leads.filter((l) => !(args.ids as string[]).includes(l.id));
      emit("data-changed");
      return null;
    case "mark_seen":
      patchLeads(args.ids as string[], (l) => (l.seen = true));
      return null;
    case "mark_all_seen":
      patchLeads(leads.map((l) => l.id), (l) => (l.seen = true));
      return null;
    case "set_note":
      patchLeads([String(args.id)], (l) => (l.note = String(args.note)));
      return null;
    case "log_event":
      log(String(args.id), String(args.action));
      return null;
    case "exclude": {
      const value = String(args.value);
      exclusions = [{ id: nextExclusion++, kind: ((args.kind as ExclusionKind | undefined) ?? (value.includes("@") ? "email" : value.includes(".") && !value.includes(" ") ? "domain" : "name")) as ExclusionKind, value, created_at: new Date().toISOString() }, ...exclusions];
      emit("data-changed");
      return `Добавлено исключение: ${value}`;
    }
    case "remove_exclusion":
      exclusions = exclusions.filter((e) => e.id !== args.id);
      emit("data-changed");
      return null;
    case "export_to_file":
      return `Экспортировано лидов: ${(args.ids as string[]).length}`;
    case "export_fields":
      return [
        ["title", "Название", true], ["kind", "Тип", true], ["source", "Источник", true], ["score", "Оценка", true], ["phone", "Телефон", true], ["email", "Email", true],
        ["website", "Сайт", true], ["address", "Адрес", false], ["region", "Регион", false], ["budget", "Бюджет", false], ["url", "Ссылка", true], ["description", "Описание", false],
      ].map(([key, title, d]) => ({ key, title, default: d }));
    case "list_backups":
      return [1, 2, 3].map((i) => ({ name: `leadgen-2026-11-0${6 - i}_10-00.db`, path: `/b/${i}`, size: 2_300_000, modifiedAt: ago(i * 24) }));
    case "backup_now":
      emit("toast", { kind: "info", text: "Резервная копия сохранена" });
      return "/b/new";
    case "portable_state":
      return { hasKey: portableKey !== null, extension: "customers", keyLength: 30 };
    case "create_portable_key":
      if (portableKey && !args.replace) throw { code: "error", message: "Ключ восстановления уже создан. Чтобы получить новый, замените ключ." };
      portableKey = "7KQ2M-XW9RT-4HBNC-P3VZE-6GJ8S-YD5FA";
      return portableKey;
    case "export_portable":
      if (!portableKey) throw { code: "error", message: "Сначала создайте ключ восстановления: «Настройки → Данные → Перенос на другой компьютер»." };
      return `Переносимая копия сохранена: ${String(args.path)}. Баз CRM: 1`;
    case "import_portable":
      return "Данные перенесены из копии. Текущая база сохранена в резервных копиях.";
    case "upload_portable_to_drive":
      return `Копия «customers-2026-11-11_10-00.customers» выгружена в ${String(args.service)}`;
    case "restore_backup":
    case "move_database":
      return "Готово";
    case "account_prefs":
      return account;
    case "patch_account_prefs":
      account = { ...account, ...(args.changes as object) };
      emit("account-prefs", account);
      return account;
    case "device_prefs":
      return device;
    case "patch_device_prefs":
      device = { ...device, ...(args.changes as object) };
      emit("device-prefs", device);
      return device;
    case "set_ui_language":
      return null;
    case "set_zoom":
      if (typeof document !== "undefined") (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = String(args.scale);
      return null;
    case "power_state":
      return { systemSaver: false, batteryPercent: 78, charging: true };
    case "search_overview":
      return { settings, hasVkToken: hasVk, problems: { fl_ru: null, telegram_channels: null, vk_communities: settings.vk.enabled && !hasVk ? "нужен сервисный ключ VK" : null, osm_organizations: null }, autoSearchMinutes: account.autoSearchMinutes };
    case "set_search_settings":
      settings = args.settings as SearchSettings;
      emit("search-settings");
      return null;
    case "set_vk_token":
      hasVk = String(args.token).trim() !== "";
      emit("search-settings");
      return null;
    case "reset_source_memory":
      return null;
    case "run_search": {
      search = { ...search, running: true, progress: "Подготовка…" };
      emit("search-state", search);
      for (const step of ["RSS-ленты…", "Telegram-каналы…", "OpenStreetMap…"]) {
        await wait(demo.has("fast") ? 10 : 500);
        search = { ...search, progress: step };
        emit("search-state", search);
      }
      search = { ...search, running: false, progress: null };
      emit("search-state", search);
      emit("search-finished", { summary: "Поиск завершён: новых 0, обновлено 0.", failed: false, added: 0, updated: 0 });
      return null;
    }
    case "stop_search":
      search = { ...search, running: false, progress: null };
      emit("search-state", search);
      return null;
    case "search_status":
      return search;
    case "sync_status":
      return sync();
    case "sync_now":
      return null;
    case "drives_state":
      return drives;
    case "disconnect_drive": {
      const d = drives.drives.find((x) => x.service === args.service);
      if (d) d.connected = false;
      emit("integrations-changed");
      return null;
    }
    case "connect_webdav": {
      const d = drives.drives.find((x) => x.service === args.service);
      if (d) Object.assign(d, { connected: true, login: args.login, webdavUrl: args.url, connectedAt: new Date().toISOString() });
      emit("integrations-changed");
      return `${d?.title ?? "Диск"} подключён`;
    }
    case "mail_providers":
      return [
        { id: "gmail", title: "Gmail", host: "smtp.gmail.com", port: 465, security: "tls", passwordPage: "https://myaccount.google.com/apppasswords", hint: "Нужен пароль приложения." },
        { id: "yandex", title: "Яндекс Почта", host: "smtp.yandex.ru", port: 465, security: "tls", passwordPage: "https://id.yandex.ru/security/app-passwords", hint: "Нужен пароль приложения." },
        { id: "custom", title: "Другой сервер (SMTP)", host: "", port: 465, security: "tls", passwordPage: null, hint: "" },
      ];
    case "mail_preset":
      return { provider: "yandex", host: "smtp.yandex.ru", port: 465, security: "tls", username: args.email, fromAddress: args.email, fromName: args.name, copyToSelf: true };
    case "mail_state":
      return { account: null, delivery: "mailApp", hasPassword: false, smtpReady: false, signature: "" };
    case "crm_state":
      return { bitrix: { connected: false, target: null }, webhook: { connected: false, target: null }, notion: { connected: false }, lastTab: "file" };
    case "crm_sent_count":
      return 0;
    case "update_info":
      return update;
    case "check_updates":
      update = { ...update, phase: "upToDate" };
      emit("update-state", update);
      return update;
    case "recent_releases":
      return [
        { tag: "v1.1.0", title: "Customers 1.1.0", date: ago(30), notes: "", page: null, current: true },
        { tag: "v1.0.9", title: "Customers 1.0.9", date: ago(200), notes: "", page: null, current: false },
        { tag: "v1.0.8", title: "Customers 1.0.8", date: ago(500), notes: "", page: null, current: false },
      ];
    case "whats_new":
      return demo.has("whatsnew")
        ? { show: true, version: "1.1.0", title: "Customers 1.1.0", page: null, notes: "", features: [
            { topic: "interface", title: "Интерфейс", items: ["Единый интерфейс Flat Dark на macOS и Windows", "Панель настроек с поиском"], preview: "settings" },
            { topic: "search", title: "Поиск", items: ["Источники проверяются по своим интервалам"], preview: null },
          ] }
        : { show: false };
    case "paths_info":
      return { root: "/Users/demo/Library/Application Support/Lead Generator", logs: "/Users/demo/Library/Logs/LeadGenerator", documents: "/Users/demo/Documents", errorLog: "/Users/demo/Library/Logs/LeadGenerator/errors.log" };
    case "error_log":
      return ["2026-11-05 12:01:10 Канал freetasks: превышено время ожидания"];
    case "crash_reports":
      return [];
    case "update_intervals":
      return [[1, "Каждый час"], [3, "Каждые 3 часа"], [6, "Каждые 6 часов"], [12, "Каждые 12 часов"], [24, "Раз в сутки"], [168, "Раз в неделю"]].map(([hours, title]) => ({ hours, title }));
    case "cloud_stats":
      return { leads_active: leads.length, leads: leads.length + 3, exclusions: exclusions.length, settings: 2 };
    default:
      return null;
  }
}
