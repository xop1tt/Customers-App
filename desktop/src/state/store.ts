// Единое хранилище приложения. Данные берутся у Rust-ядра, события обновляют их без ручной перезагрузки.

import { useSyncExternalStore } from "react";
import { MODULES, moduleOf, RESTORABLE, type ModuleId } from "../lib/modules";
import { api } from "../api";
import { on } from "../api/backend";
import type {
  AccountPrefs, AuthCallback, BootInfo, ChatPoll, MarketInstalled, TeamMember, DevicePrefs, SearchOverview, SearchStatus, SessionInfo, Snapshot, SyncStatus, UpdateInfo, WsCollection, WsState,
} from "../api/types";
import { type LeadFilter, type SectionId, emptyFilter } from "../lib/leads";
import { type LightModeReason, evaluate } from "../lib/powerPolicy";

export type Phase = "loading" | "error" | "auth" | "welcome" | "ready";
export type SettingsSection = "appearance" | "system" | "notifications" | "search" | "account" | "data" | "exclusions" | "outreach" | "reports" | "updates" | "sources";
export type ToastKind = "info" | "error" | "success";
export interface Toast { id: number; kind: ToastKind; text: string }

export interface AppState {
  phase: Phase;
  error: string | null;
  boot: BootInfo | null;
  session: SessionInfo | null;
  device: DevicePrefs;
  account: AccountPrefs | null;
  snap: Snapshot;
  overview: SearchOverview | null;
  search: SearchStatus;
  sync: SyncStatus | null;
  update: UpdateInfo | null;
  lightMode: LightModeReason | null;
  toasts: Toast[];
  authCallback: AuthCallback | null;
  /** Интерфейс */
  section: SectionId;
  selection: string[];
  anchor: string | null;
  filter: LeadFilter;
  settings: SettingsSection | null;
  /** Открытый подраздел настроек; null — первый. */
  settingsSub: string | null;
  exportOpen: boolean;
  /** Окно быстрого поиска (Ctrl/Cmd+K, пакет G5). */
  quickOpen: boolean;
  whatsNewOpen: boolean;
  reportOpen: boolean;
  customizeNav: boolean;
  navPeek: boolean;
  /** Customers 2.0: активный Workspace, его коллекции и открытая карточка. */
  ws: WsState | null;
  collections: WsCollection[];
  collectionId: string | null;
  /** Открытая карточка CRM; `preset` — значения полей новой записи (например, срок задачи из календаря). */
  record: { table: string; id: string; preset?: Record<string, unknown> } | null;
  workspaceOpen: boolean;
  /** Открытое окно маркетплейса (раздел) или null. */
  market: "catalog" | "installed" | "developer" | "moderation" | null;
  /** Установленные интеграции активного Workspace: кнопки в карточках CRM. */
  marketInstalled: MarketInstalled[];
  /** Диалог коллекции: новая (`id: null`) или изменение существующей. */
  collectionEdit: { id: string | null } | null;
  /** Открытый профиль сотрудника (раздел «profile»); null — свой. */
  profileId: string | null;
  /** Справочник сотрудников активного Workspace (раздел «Сотрудники», профили, чат). */
  team: TeamMember[];
  /** Последний опрос чата: непрочитанное и уведомления. */
  chat: ChatPoll | null;
  /** Открытое обсуждение в разделе «Сообщения». */
  chatOpen: string | null;
  /** Растёт при каждом изменении данных Workspace: открытые списки и карточки перечитываются. */
  wsVersion: number;
}

export const DEFAULT_DEVICE: DevicePrefs = {
  accent: null, theme: "system", language: "system", uiScale: 1, navWidth: 260, navOpen: true, navHidden: false, inspectorWidth: 400, inspectorShown: true, compactRows: false, animations: true,
  sidebarHidden: [], sidebarHiddenSources: [], sidebarOrder: [], sidebarSourceOrder: [], sidebarCounts: true, sidebarSources: true, sidebarHover: true, sidebarCollapsed: [],
  lightModeAuto: true, lightModeThreshold: 20, checkUpdates: true, updateCheckHours: 24, lastUpdateCheck: null, backgroundDownload: true, lastSeenVersion: null,
  closeToTray: true, startMinimized: false, launchAtLogin: false, trayHintShown: false, rememberedUser: null, lastSection: "home", listSort: "score",
  listSortDescending: true, reportsOfferAfterCrash: true, reportsLogErrors: true, reportsIncludeLog: true, reportsLastSeen: null, legacyImported: false,
};

const EMPTY_SNAP: Snapshot = { leads: [], sources: [], pipelineErrors: [], exclusions: [], syncLog: [], lastSearchAt: null, databaseSize: 0 };

const initial: AppState = {
  phase: "loading", error: null, boot: null, session: null, device: DEFAULT_DEVICE, account: null, snap: EMPTY_SNAP, overview: null,
  search: { running: false, progress: null, lastReport: null }, sync: null, update: null, lightMode: null, toasts: [], authCallback: null,
  section: "home", selection: [], anchor: null, filter: emptyFilter(), settings: null, settingsSub: null, exportOpen: false, quickOpen: false, whatsNewOpen: false, reportOpen: false, customizeNav: false, navPeek: false,
  ws: null, collections: [], collectionId: null, record: null, workspaceOpen: false, collectionEdit: null, wsVersion: 0, profileId: null, team: [], chat: null, chatOpen: null, market: null, marketInstalled: [],
};

let state = initial;
const subs = new Set<() => void>();

export const getState = () => state;
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  subs.forEach((f) => f());
}
/** Пустой массив с постоянной ссылкой: селектор `s.ws?.x ?? []` без Workspace иначе возвращал бы новый массив при каждом вызове (бесконечная перерисовка, React #185). */
export const NONE: never[] = [];

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f); }; },
    () => selector(state),
  );
}

// ---------------------------------------------------------------- уведомления

let toastId = 1;
export function toast(text: string, kind: ToastKind = "info") {
  const id = toastId++;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 7000 : 3800);
}
export const dismissToast = (id: number) => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
export const errText = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "Что-то пошло не так.");
/** Выполнить действие и показать ошибку уведомлением. */
export async function attempt<T>(f: () => Promise<T>): Promise<T | undefined> {
  try {
    return await f();
  } catch (e) {
    toast(errText(e), "error");
    return undefined;
  }
}

// ---------------------------------------------------------------- загрузка

let wired = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export async function refreshSnapshot() {
  try {
    const snap = await api.snapshot();
    setState((s) => {
      const known = new Set(snap.leads.map((l) => l.id));
      const selection = s.selection.filter((id) => known.has(id));
      return { snap, selection: selection.length === s.selection.length ? s.selection : selection };
    });
  } catch { /* сессия могла закрыться */ }
}
const scheduleRefresh = () => {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; void refreshSnapshot(); }, 120);
};

export async function refreshOverview() {
  try { setState({ overview: await api.searchOverview() }); } catch { /* нет сессии */ }
}

async function loadSession(boot: BootInfo) {
  const [snap, account, overview, search, sync, update] = await Promise.all([
    api.snapshot(), api.accountPrefs(), api.searchOverview(), api.searchStatus(), api.syncStatus(), api.updateInfo(),
  ]);
  const last = boot.device.lastSection as SectionId;
  const section: SectionId = RESTORABLE.includes(last) ? last : "home";
  setState({
    session: boot.session, snap, account, overview, search, sync, update, section, selection: [], anchor: null, filter: emptyFilter(),
    phase: account.welcomeDone ? "ready" : "welcome",
  });
  void checkPower();
  void refreshWorkspace();
}

export async function boot() {
  try {
    wireEvents();
    const info = await api.bootInfo();
    setState({ boot: info, device: info.device, error: info.error });
    if (info.error) return setState({ phase: "error" });
    if (!info.session) return setState({ phase: "auth", session: null });
    await loadSession(info);
  } catch (e) {
    setState({ phase: "error", error: errText(e) });
  }
}

/** После входа или регистрации: подтянуть данные открытой сессии. */
let entering: Promise<void> | null = null;
export function enterSession(): Promise<void> {
  if (entering) return entering;
  entering = (async () => {
    try {
      const info = await api.bootInfo();
      setState({ boot: info, device: info.device });
      if (info.session) await loadSession(info);
    } finally {
      entering = null;
    }
  })();
  return entering;
}

export async function leaveSession() {
  await attempt(() => api.logout());
  setState({ phase: "auth", session: null, snap: EMPTY_SNAP, account: null, overview: null, settings: null, exportOpen: false, selection: [], ...NO_WORKSPACE });
}

const NO_WORKSPACE: Partial<AppState> = { ws: null, collections: [], collectionId: null, record: null, workspaceOpen: false, collectionEdit: null, team: [], chat: null, chatOpen: null, market: null, marketInstalled: [] };

// ---------------------------------------------------------------- Workspace и коллекции

let wsTimer: ReturnType<typeof setTimeout> | null = null;
/** Состояние Workspace и список коллекций. Ошибка (нет сессии, база недоступна) не ломает генератор лидов. */
export async function refreshWorkspace() {
  try {
    const [ws, collections] = await Promise.all([api.wsState(), api.wsCollections()]);
    setState((s) => {
      const known = s.collectionId && collections.some((c) => c.id === s.collectionId);
      const lost = s.section === "collection" && !known;
      return { ws, collections, ...(lost ? { section: "home" as SectionId, collectionId: null, record: null } : {}), wsVersion: s.wsVersion + 1 };
    });
  } catch {
    setState({ ws: null, collections: [] });
  }
}
const scheduleWorkspace = () => {
  if (wsTimer) return;
  wsTimer = setTimeout(() => { wsTimer = null; void refreshWorkspace(); }, 150);
};

export function openCollection(id: string) {
  setState({ section: "collection", collectionId: id, record: null, selection: [], anchor: null, navPeek: false });
}
/** Профиль сотрудника; без id — свой. */
export function openProfile(id: string | null = null) {
  setState({ section: "profile", profileId: id, collectionId: null, record: null, selection: [], anchor: null, navPeek: false });
}
export const openRecord = (table: string, id: string | null, preset?: Record<string, unknown>) => setState({ record: id ? { table, id, ...(preset ? { preset } : {}) } : null });

export async function checkPower() {
  try {
    const p = await api.powerState();
    const d = state.device;
    setState({ lightMode: evaluate(p, d.lightModeAuto, d.lightModeThreshold) });
  } catch { /* нет данных об энергопитании */ }
}

function wireEvents() {
  if (wired) return;
  wired = true;
  void on("data-changed", scheduleRefresh);
  void on<SearchStatus>("search-state", (search) => setState({ search }));
  void on<{ summary: string; failed: boolean }>("search-finished", (r) => { toast(r.summary, r.failed ? "error" : "success"); });
  void on<SyncStatus>("sync-state", (sync) => setState({ sync }));
  void on<SessionInfo | null>("session-changed", (s) => { if (s && state.phase !== "auth") setState({ session: s }); else void enterSession(); });
  void on<{ reason: string }>("session-ended", (r) => {
    setState({ phase: "auth", session: null, snap: EMPTY_SNAP, settings: null, exportOpen: false, ...NO_WORKSPACE });
    if (r?.reason) toast(r.reason, "error");
  });
  void on<DevicePrefs>("device-prefs", (device) => { setState({ device }); void checkPower(); });
  void on<{ action: string }>("tray-action", (a) => {
    if (a.action === "new") setSection("new");
    else if (a.action === "settings") openSettings("account");
  });
  void on<AccountPrefs>("account-prefs", (account) => setState({ account }));
  void on("search-settings", () => { void refreshOverview(); });
  void on<UpdateInfo>("update-state", (update) => setState({ update }));
  void on<{ kind: string; text: string }>("toast", (t) => toast(t.text, t.kind === "error" ? "error" : "info"));
  void on<AuthCallback>("auth-callback", (authCallback) => {
    if (authCallback.kind === "message") toast(authCallback.message);
    else if (authCallback.kind === "error") toast(authCallback.message, "error");
    else if (authCallback.kind === "signedIn") void enterSession();
    else setState({ authCallback });
  });
  void on("exit-requested", () => {});
  void on("workspace-changed", scheduleWorkspace);
}

// ---------------------------------------------------------------- действия интерфейса

/** Последний открытый раздел каждого модуля: рейка возвращает в него. Только в памяти. */
const lastIn = new Map<ModuleId, { section: SectionId; collectionId: string | null }>();

/** Открыть модуль рейки: последний раздел в нём или его главный раздел. */
export function openModule(id: ModuleId) {
  const cur = state.section;
  // «Настроить панель» у каждой вкладки своя: при смене вкладки режим настройки закрывается.
  if (moduleOf(cur) !== id && state.customizeNav) setState({ customizeNav: false });
  lastIn.set(moduleOf(cur), { section: cur, collectionId: state.collectionId });
  if (moduleOf(cur) === id) return;
  const last = lastIn.get(id);
  if (last?.section === "collection" && last.collectionId && state.collections.some((c) => c.id === last.collectionId)) return openCollection(last.collectionId);
  const home = MODULES.find((m) => m.id === id)!.home;
  setSection(last && last.section !== "collection" && last.section !== "profile" ? last.section : home);
}

/** Открыть запись CRM из любого места: если открыт не модуль CRM, сначала переход в подходящий раздел. */
export function goToRecord(table: string, id: string, preset?: Record<string, unknown>) {
  if (moduleOf(state.section) !== "crm") setSection(table === "deals" ? "deals" : table === "tasks" ? "calendar" : "today");
  openRecord(table, id, preset);
}

export function setSection(section: SectionId) {
  // Источники настраиваются в окне настроек, отдельной страницы у них нет.
  if (section === "sources") { openSettings("sources"); return; }
  setState({ section, selection: [], anchor: null, navPeek: false, collectionId: null, record: null });
  void api.patchDevicePrefs({ lastSection: section }).catch(() => {});
}
/** Открыть список лидов с готовым фильтром, например по источнику. */
export function openSource(source: string) {
  setState({ section: "all", selection: [], anchor: null, navPeek: false, filter: { ...emptyFilter(), source } });
}
/** Список лидов с оценкой не ниже заданной. */
export function openScore(minScore: number) {
  setState({ section: "all", selection: [], anchor: null, navPeek: false, filter: { ...emptyFilter(), minScore } });
}
export const setFilter = (f: Partial<LeadFilter>) => setState((s) => ({ filter: { ...s.filter, ...f } }));
export const openSettings = (settings: SettingsSection | null, settingsSub: string | null = null) => setState({ settings, settingsSub });

export function select(ids: string[], anchor?: string | null) {
  setState((s) => ({ selection: ids, anchor: anchor === undefined ? s.anchor : anchor }));
}

export async function patchDevice(changes: Partial<DevicePrefs>) {
  setState((s) => ({ device: { ...s.device, ...changes } }));
  try {
    const device = await api.patchDevicePrefs(changes);
    setState({ device });
  } catch (e) { toast(errText(e), "error"); }
}
export async function patchAccount(changes: Partial<AccountPrefs>) {
  setState((s) => (s.account ? { account: { ...s.account, ...changes } } : {}));
  try {
    const account = await api.patchAccountPrefs(changes);
    setState({ account });
  } catch (e) { toast(errText(e), "error"); }
}


/** Изменить настройки поиска: сразу в интерфейсе, затем в ядре. */
export async function updateSettings(mutate: (s: import("../api/types").SearchSettings) => void) {
  const cur = state.overview;
  if (!cur) return;
  const settings = structuredClone(cur.settings);
  mutate(settings);
  setState({ overview: { ...cur, settings } });
  try {
    await api.setSearchSettings(settings);
  } catch (e) {
    toast(errText(e), "error");
    await refreshOverview();
  }
}
