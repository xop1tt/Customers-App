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

export interface SessionInfo {
  id: string;
  displayName: string;
  /** Аватар в виде data-URL. */
  avatar?: string | null;
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
  /** Свёрнутые группы боковой панели. */
  sidebarCollapsed: string[];
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
  /** Сколько последних поисков считать «новыми» (1–50). */
  newLeadsSearches: number;
  signature: string;
  backupDirectory: string;
  autoBackup: boolean;
  /** Частота автоматических копий, часы: 6, 12, 24, 72 или 168. */
  backupHours: number;
  keepBackups: number;
  dataPath: string | null;
  notifyNewLeads: boolean;
  notifyErrors: boolean;
  notifySync: boolean;
  notifyMessages: boolean;
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

/** Переносимая копия (G8, ADR-062): создан ли ключ восстановления. */
export interface PortableState {
  hasKey: boolean;
  extension: string;
  keyLength: number;
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

/** Колонка экспорта CRM: поле записи или своё поле Workspace (`custom`). */
export interface CrmExportField extends ExportFieldInfo { custom: boolean }
/** Объединение дубликатов (пакет G4): `values` — выбранные значения полей оставшейся записи. */
export interface CrmMergeRequest { entity: "companies" | "contacts"; keep: string; remove: string; values: Record<string, unknown> }
export interface CrmMergeInfo { entity: string; keep: string; remove: string; removedTitle: string; at: string }

export type CrmExportFormat = "xlsx" | "csv";
/** Что выгрузить: записи таблицы `entity` или то, что показывает коллекция; `query` — поиск и фильтры пользователя. */
export interface CrmExportRequest {
  entity: string;
  collection?: string | null;
  query?: WsQuery;
  format: CrmExportFormat;
  fields: string[];
  lang: string;
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
  /** Копия облачного Workspace прежних версий; ядро переводит такие в локальные (ADR-100). */
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

export interface WsState {
  me: string;
  workspaces: WorkspaceInfo[];
  active: string | null;
  permissions: string[];
  members: WsMember[];
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

export interface WsStageChange { from_stage_id: string | null; to_stage_id: string; changed_by: string | null; changed_at: string }

/** Строка истории этапов для отчётов (ws_stage_history). */
export interface StageChange { deal_id: string; from_stage_id: string | null; to_stage_id: string; changed_at: string }

export interface WsCard {
  record: CrmRecord;
  tasks?: CrmRecord[];
  activities?: CrmRecord[];
  notes?: CrmRecord[];
  comments?: CrmRecord[];
  custom_field_values?: CrmRecord[];
  attachments?: CrmRecord[];
  contacts?: CrmRecord[];
  deals?: CrmRecord[];
  history?: WsStageChange[];
  dealContacts?: CrmRecord[];
  dealLinks?: CrmRecord[];
}

export interface WsConverted {
  workspaceId: string;
  companyId: string;
  contactId: string | null;
  dealId: string | null;
  reusedCompany: boolean;
  reusedContact: boolean;
}

// ---------------------------------------------------------------- локальная модель (OpenAI-совместимый ответ)

export interface AiToolCall { id?: string; type?: string; function: { name: string; arguments: string | Record<string, unknown> } }
/** Что модель принимает кроме текста; null — неизвестно (файл отправляется, ответ сервера покажет, принят ли он). */
export interface AiCaps { vision: boolean | null; audio: boolean | null }
export interface AiChatReply { choices: { message: { role: string; content: string | null; tool_calls?: AiToolCall[] }; finish_reason?: string }[] }

// ------------------------------------------------------------------ импорт таблиц (B1)

export type ImportDuplicates = "link" | "skip" | "create";
export interface ImportOptions { mapping: (string | null)[]; duplicates: ImportDuplicates; pipelineId?: string | null; ownerId?: string | null }
export interface ImportFile { headers: string[]; rows: number; sample: string[][]; mapping: (string | null)[]; fields: { key: string; label: string }[] }
export interface ImportRowPreview { line: number; company: string | null; contact: string | null; deal: string | null; status: "new" | "existing" | "skip" | "empty" | "error"; existing: string | null; messages: string[] }
export interface ImportPreview { rows: number; new: number; existing: number; skipped: number; errors: number; empty: number; deals: number; contacts: number; warnings: number; items: ImportRowPreview[] }
export interface ImportSummary { companies: number; contacts: number; deals: number; notes: number; linked: number; skipped: number; errors: number; unknownStages: string[] }
export interface ImportResult extends ImportSummary { batchId: string | null; errorRows: { line: number; message: string }[] }
export interface ImportBatch { id: string; file: string; createdAt: string; summary: ImportSummary | null; undoneAt: string | null }
