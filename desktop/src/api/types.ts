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
  /** Отметка «перенесён в CRM» (Customers 2.0). */
  crm?: { workspace_id: string; company_id: string; contact_id: string | null; deal_id: string | null; converted_at: string };
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
  theme: "system" | "dark" | "light";
  language: "system" | "ru" | "en";
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
  /** Канал сборки: Stable (обычная версия) или Beta (Debug/Beta, своя база и настройки). */
  channel: "stable" | "beta";
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

// ---------------------------------------------------------------- Customers 2.0: Workspace и CRM

export interface WorkspaceInfo {
  id: string;
  name: string;
  personal: boolean;
  role: string;
  roleName: string;
  rank: number;
  permissions: string[];
  members: number;
  /** Workspace в Supabase; иначе — только на этом устройстве. */
  remote: boolean;
  defaultCurrency: string;
}

export interface WsMember {
  userId: string;
  displayName: string;
  role: string;
  roleName: string;
  rank: number;
  avatarPath: string | null;
  email: string | null;
}

export interface WsPresence { user_id: string; entity_type: string | null; entity_id: string | null; seen_at: string }
export interface WsRole { key: string; name: string; rank: number; system: boolean; permissions: string[] }
export interface WsRoles { roles: WsRole[]; catalog: { key: string; description: string }[] }

export interface WsState {
  isCloud: boolean;
  me: string;
  workspaces: WorkspaceInfo[];
  active: string | null;
  permissions: string[];
  members: WsMember[];
  pending: number;
  rejected: number;
  conflicts: number;
  syncing: boolean;
  lastSync: string | null;
  error: string | null;
}

/** Строка CRM-таблицы как есть: системные столбцы и поля сущности (snake_case, как в базе). */
export interface CrmRecord {
  id: string;
  workspace_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by?: string | null;
  owner_id?: string | null;
  archived_at?: string | null;
  deleted_at?: string | null;
  [field: string]: unknown;
}

export interface WsFilter { field: string; op: string; value?: unknown }
export interface WsSort { field: string; dir: "asc" | "desc" }
export interface WsQuery {
  filters?: WsFilter[];
  sort?: WsSort[];
  search?: string | null;
  limit?: number;
  offset?: number;
  archived?: boolean;
  deleted?: boolean;
}

export interface WsCollection extends CrmRecord {
  name: string;
  emoji: string | null;
  icon: string | null;
  entity_type: string;
  visibility: "private" | "workspace";
  config: { filters?: WsFilter[]; sort?: WsSort[]; columns?: string[] };
  position: number;
  builtin: string | null;
  count: number;
}

export interface WsConflict {
  id: string;
  entityType: string;
  entityId: string;
  field: string;
  kept: unknown;
  lost: unknown;
  lostBy: string | null;
  keptBy: string | null;
  at: string | null;
}

export interface WsOp {
  op_id: string;
  entity: string;
  id: string;
  kind: string;
  fields: Record<string, unknown>;
  state: string;
  last_error: string | null;
}

export interface WsStageChange { from_stage_id: string | null; to_stage_id: string; changed_by: string | null; changed_at: string }

export interface WsCard {
  record: CrmRecord;
  tasks?: CrmRecord[];
  activities?: CrmRecord[];
  notes?: CrmRecord[];
  comments?: CrmRecord[];
  custom_field_values?: CrmRecord[];
  contacts?: CrmRecord[];
  deals?: CrmRecord[];
  history?: WsStageChange[];
  dealContacts?: CrmRecord[];
  dealLinks?: CrmRecord[];
  conflicts: WsConflict[];
}

export interface WsConverted {
  workspaceId: string;
  companyId: string;
  contactId: string | null;
  dealId: string | null;
  reusedCompany: boolean;
  reusedContact: boolean;
}

export interface WsInvite { id: string; email: string; role: string; expiresAt: string; token: string; link: string }
