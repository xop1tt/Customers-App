// Единое хранилище приложения. Данные берутся у Rust-ядра, события обновляют их без ручной перезагрузки.

import { useSyncExternalStore } from "react";
import { api } from "../api";
import { on } from "../api/backend";
import type {
  AccountPrefs, AuthCallback, BootInfo, DevicePrefs, SearchOverview, SearchStatus, SessionInfo, Snapshot, SyncStatus, UpdateInfo,
} from "../api/types";
import { type LeadFilter, type SectionId, emptyFilter, isLeadList } from "../lib/leads";
import { type LightModeReason, evaluate } from "../lib/powerPolicy";

export type Phase = "loading" | "error" | "auth" | "welcome" | "ready";
export type SettingsSection = "appearance" | "system" | "notifications" | "search" | "account" | "data" | "exclusions" | "outreach" | "reports" | "updates";
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
  exportOpen: boolean;
  whatsNewOpen: boolean;
  reportOpen: boolean;
  customizeNav: boolean;
  navPeek: boolean;
  sourceKey: string;
}

export const DEFAULT_DEVICE: DevicePrefs = {
  accent: null, uiScale: 1, navWidth: 260, navOpen: true, navHidden: false, inspectorWidth: 400, inspectorShown: true, compactRows: false, animations: true,
  sidebarHidden: [], sidebarHiddenSources: [], sidebarOrder: [], sidebarSourceOrder: [], sidebarCounts: true, sidebarSources: true, sidebarHover: true,
  lightModeAuto: true, lightModeThreshold: 20, checkUpdates: true, updateCheckHours: 24, lastUpdateCheck: null, backgroundDownload: true, lastSeenVersion: null,
  closeToTray: true, startMinimized: false, launchAtLogin: false, trayHintShown: false, rememberedUser: null, lastSection: "home", listSort: "score",
  listSortDescending: true, reportsOfferAfterCrash: true, reportsLogErrors: true, reportsIncludeLog: true, reportsLastSeen: null, legacyImported: false,
};

const EMPTY_SNAP: Snapshot = { leads: [], sources: [], pipelineErrors: [], exclusions: [], syncLog: [], lastSearchAt: null, databaseSize: 0 };

const initial: AppState = {
  phase: "loading", error: null, boot: null, session: null, device: DEFAULT_DEVICE, account: null, snap: EMPTY_SNAP, overview: null,
  search: { running: false, progress: null, lastReport: null }, sync: null, update: null, lightMode: null, toasts: [], authCallback: null,
  section: "home", selection: [], anchor: null, filter: emptyFilter(), settings: null, exportOpen: false, whatsNewOpen: false, reportOpen: false, customizeNav: false, navPeek: false, sourceKey: "fl_ru",
};

let state = initial;
const subs = new Set<() => void>();

export const getState = () => state;
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  subs.forEach((f) => f());
}
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
  const section: SectionId = (["home", "all", "new", "favorites", "archive", "excluded", "sources", "runs"] as string[]).includes(last) ? last : "home";
  setState({
    session: boot.session, snap, account, overview, search, sync, update, section, selection: [], anchor: null, filter: emptyFilter(),
    phase: account.welcomeDone ? "ready" : "welcome",
  });
  void checkPower();
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
  setState({ phase: "auth", session: null, snap: EMPTY_SNAP, account: null, overview: null, settings: null, exportOpen: false, selection: [] });
}

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
    setState({ phase: "auth", session: null, snap: EMPTY_SNAP, settings: null, exportOpen: false });
    if (r?.reason) toast(r.reason, "error");
  });
  void on<DevicePrefs>("device-prefs", (device) => { setState({ device }); void checkPower(); });
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
}

// ---------------------------------------------------------------- действия интерфейса

export function setSection(section: SectionId) {
  setState({ section, selection: [], anchor: null, navPeek: false });
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
export const openSettings = (settings: SettingsSection | null) => setState({ settings });

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

export const isListSection = () => isLeadList(state.section);

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
