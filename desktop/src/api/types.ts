// Типы данных, которые отдаёт Rust-ядро. Имена полей совпадают с JSON команд.

export type LeadKind = "order" | "organization";
export type Relevance = "high" | "medium" | "low" | "rejected";

export interface ExternalResult {
  service: string;
  processed_at?: string;
  ok: boolean;
  score?: number;
  label?: string;
  error?: string;
}

export interface LeadData {
  kind: LeadKind;
  source: string;
  external_id: string;
  title: string;
  url: string;
  description: string;
  published_at?: string;
  discovered_at?: string;
  budget?: number;
  currency?: string;
  region?: string;
  contacts: Record<string, string>;
  category?: string;
  project_type?: string;
  customer_name?: string;
  address?: string;
  phone?: string;
  website?: string;
  facts: string[];
  assumptions: string[];
  score: number;
  relevance: Relevance;
  score_reasons: string[];
  status: string;
  external_results: ExternalResult[];
}

export interface Lead {
  id: string;
  data: LeadData;
  discoveredAt: string;
  favorite: boolean;
  archived: boolean;
  excluded: boolean;
  seen: boolean;
  note: string;
  phones: string[];
  emails: string[];
}

export interface SourceState {
  source: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  consecutive_failures: number;
  status: string;
  last_error: string | null;
}

export interface PipelineError {
  id: number;
  at: string | null;
  module: string;
  message: string;
}

export type ExclusionKind = "domain" | "phone" | "email" | "name";

export interface Exclusion {
  id: number;
  kind: ExclusionKind;
  value: string;
  created_at: string | null;
}

export interface SyncLogEntry {
  id: number;
  at: string | null;
  ok: boolean;
  added: number;
  updated: number;
  message: string;
}

export interface LeadEvent {
  id: number;
  at: string | null;
  action: string;
}

export interface Snapshot {
  leads: Lead[];
  sources: SourceState[];
  pipelineErrors: PipelineError[];
  exclusions: Exclusion[];
  syncLog: SyncLogEntry[];
  lastSearchAt: string | null;
  databaseSize: number;
}

export interface CloudUserInfo {
  id: string;
  email: string;
  newEmail: string | null;
  confirmed: boolean;
}

export interface SessionInfo {
  id: string;
  displayName: string;
  /** Аватар в виде data-URL; приходит из облака вместе с остальными настройками. */
  avatar?: string | null;
  isCloud: boolean;
  cloudUser: CloudUserInfo | null;
  databasePath: string;
}

export interface CallAppInfo {
  id: string;
  title: string;
  installed: boolean;
  opensChat: boolean;
}

export interface DevicePrefs {
  accent: string | null;
  uiScale: number;
  navWidth: number;
  navOpen: boolean;
  navHidden: boolean;
  inspectorWidth: number;
  inspectorShown: boolean;
  compactRows: boolean;
  animations: boolean;
  sidebarHidden: string[];
  sidebarHiddenSources: string[];
  sidebarOrder: string[];
  sidebarSourceOrder: string[];
  sidebarCounts: boolean;
  sidebarSources: boolean;
  sidebarHover: boolean;
  lightModeAuto: boolean;
  lightModeThreshold: number;
  checkUpdates: boolean;
  updateCheckHours: number;
  lastUpdateCheck: string | null;
  backgroundDownload: boolean;
  lastSeenVersion: string | null;
  closeToTray: boolean;
  startMinimized: boolean;
  launchAtLogin: boolean;
  trayHintShown: boolean;
  rememberedUser: string | null;
  lastSection: string;
  listSort: string;
  listSortDescending: boolean;
  reportsOfferAfterCrash: boolean;
  reportsLogErrors: boolean;
  reportsIncludeLog: boolean;
  reportsLastSeen: string | null;
  legacyImported: boolean;
}

export interface AccountPrefs {
  autoSearchMinutes: number;
  signature: string;
  backupDirectory: string;
  autoBackup: boolean;
  keepBackups: number;
  dataPath: string | null;
  notifyNewLeads: boolean;
  notifyErrors: boolean;
  notifySync: boolean;
  mailAccount: string;
  mailDelivery: string;
  confirmCalls: boolean;
  confirmCallsVersion: number;
  callApp: string;
  welcomeDone: boolean;
  exportLastTab: string;
}

export interface BootInfo {
  version: string;
  platform: "windows" | "macos" | "linux";
  cloudAvailable: boolean;
  hasUsers: boolean;
  existingInstall: boolean;
  session: SessionInfo | null;
  device: DevicePrefs;
  error: string | null;
}

export interface SourceReport {
  source: string;
  found: number;
  added: number;
  updated: number;
  duplicates: number;
  skipped: string | null;
  warnings: string[];
  errors: string[];
  failed: boolean;
}

export interface SearchReport {
  sources: SourceReport[];
  cancelled: boolean;
}

export interface SearchStatus {
  running: boolean;
  progress: string | null;
  lastReport: SearchReport | null;
}

export type SyncKind = "idle" | "syncing" | "offline" | "failed";

export interface SyncStatus {
  enabled: boolean;
  kind: SyncKind;
  message: string | null;
  lastSync: string | null;
  pending: number;
}

export type UpdatePhase =
  | { phase: "idle" | "checking" | "upToDate" | "available" | "downloading" | "ready" | "installing" }
  | { phase: "failed"; message: string };

export interface AvailableUpdateInfo {
  version: string;
  title: string;
  notes: string;
  page: string | null;
  size: number | null;
}

export type UpdateInfo = {
  phase: UpdatePhase["phase"];
  message?: string;
  current: string;
  canUpdate: boolean;
  available: AvailableUpdateInfo | null;
  stagedVersion: string | null;
  lastCheck: string | null;
  releasesPage: string;
};

export interface ReleaseSummary {
  tag: string;
  title: string;
  date: string | null;
  notes: string;
  page: string | null;
  current: boolean;
}

export interface WhatsNewFeature {
  topic: string;
  title: string;
  items: string[];
  preview: string | null;
}

export type WhatsNew = { show: false } | { show: true; version: string; title: string; page: string | null; features: WhatsNewFeature[]; notes: string };

export interface OsmCategory {
  key: string;
  label: string;
  group: string;
  filters: string[];
  enabled: boolean;
  weight: number;
}

export interface SearchSettings {
  rss: { enabled: boolean; intervalHours: number; feeds: string[]; keywords: string[] };
  telegram: { enabled: boolean; intervalHours: number; channels: string[]; maxPages: number; keywords: string[] };
  vk: { enabled: boolean; intervalHours: number; communities: string[]; pageSize: number; maxPages: number; keywords: string[] };
  osm: {
    enabled: boolean;
    intervalHours: number;
    regions: string[];
    categories: OsmCategory[];
    checkWebsites: boolean;
    refreshDays: number;
    recheckDays: number;
    maxNewPerRun: number;
    endpoint: string;
  };
}

export interface SearchOverview {
  settings: SearchSettings;
  hasVkToken: boolean;
  problems: Record<string, string | null>;
  autoSearchMinutes: number;
}

export interface BackupFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: string | null;
}

export interface DriveInfo {
  service: string;
  title: string;
  subtitle: string;
  kind: "oauth" | "webdav";
  provider: string | null;
  connected: boolean;
  connectedAt: string | null;
  available: boolean;
  defaultUrl: string;
  passwordPage: string | null;
  passwordOptional: boolean;
  webdavUrl: string | null;
  login: string | null;
}

export interface ProviderInfo {
  provider: string;
  clientIdLabel: string;
  consolePage: string;
  needsSecret: boolean;
  buildVariable: string;
  builtIn: boolean;
  hasKey: boolean;
}

export interface DrivesState {
  drives: DriveInfo[];
  providers: ProviderInfo[];
  redirect: string;
  busy: string | null;
}

export interface MailAccount {
  provider: string;
  host: string;
  port: number;
  security: "tls" | "startTls";
  username: string;
  fromAddress: string;
  fromName: string;
  copyToSelf: boolean;
}

export interface MailProviderInfo {
  id: string;
  title: string;
  host: string;
  port: number;
  security: "tls" | "startTls";
  passwordPage: string | null;
  hint: string;
}

export interface MailState {
  account: MailAccount | null;
  delivery: "mailApp" | "smtp";
  hasPassword: boolean;
  smtpReady: boolean;
  signature: string;
}

export interface NotionProperty {
  name: string;
  type: string;
  typeTitle: string;
  writable: boolean;
}

export interface CrmState {
  bitrix: { connected: boolean; target: string | null };
  webhook: { connected: boolean; target: string | null };
  notion: { connected: boolean; title?: string; database?: string; properties?: NotionProperty[]; mapping?: Record<string, string>; hasTitle?: boolean };
  lastTab: string;
}

export interface ExportFieldInfo {
  key: string;
  title: string;
  default: boolean;
}

export interface CrmReport {
  exported: number;
  skipped: number;
  failures: { id: string; title: string; message: string }[];
  stoppedEarly: boolean;
}

export interface PathsInfo {
  root: string;
  logs: string;
  documents: string;
  errorLog: string;
}

export interface CrashReport {
  path: string;
  date: string;
  kind: string;
}

export interface PowerState {
  systemSaver: boolean;
  batteryPercent: number | null;
  charging: boolean | null;
}

export interface CmdError {
  code: string;
  message: string;
}

export type AuthCallback = { kind: "newPassword" | "signedIn" } | { kind: "message" | "error"; message: string };
