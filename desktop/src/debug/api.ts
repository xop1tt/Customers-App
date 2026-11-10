// Команды Debug Menu (только Beta). В Stable этих команд в ядре нет.

import { call } from "../api/backend";

export type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
export const LEVELS: Level[] = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

export interface LogEntry { seq: number; at: string; level: Level; module: string; message: string }
export interface LogQuery { levels: Level[]; text: string; since?: string | null; until?: string | null; limit?: number | null }

export interface Component { name: string; state: "ok" | "off" | "busy" | "warning" | "error"; detail: string }
export interface WindowInfo { scaleFactor: number | null; physicalWidth: number | null; physicalHeight: number | null; logicalWidth: number | null; logicalHeight: number | null }
export interface Dashboard {
  version: string; channel: string; identifier: string; gitCommit: string | null; gitBranch: string | null; buildProfile: string;
  os: string | null; osVersion: string | null; kernel: string | null; arch: string; tauri: string; webview: string | null;
  window: WindowInfo; uptimeSecs: number; pid: number | null; memoryBytes: number | null; cpuPercent: number | null;
  dataDir: string; logsDir: string; components: Component[];
}

export interface Check { id: string; title: string; status: "pass" | "warn" | "fail" | "skipped"; detail: string; hint: string | null }

export interface TestDataState { hasSession: boolean; isTest: boolean; canMark: boolean; reason: string | null; testLeads: number; totalLeads: number }
export interface Generated { added: number; skipped: number; durationMs: number; totalLeads: number }

export interface ScenarioInfo { id: string; group: string; title: string; description: string }
export type ScenarioStatus = "PASS" | "FAIL" | "SKIPPED";
export interface ScenarioOutcome { id: string; title: string; status: ScenarioStatus; durationMs: number; error: string | null; details: string[] }
export interface ScenarioReport { runId: string; startedAt: string; durationMs: number; passed: number; failed: number; skipped: number; results: ScenarioOutcome[] }

export const debugApi = {
  dashboard: () => call<Dashboard>("debug_dashboard"),
  logs: (query: LogQuery) => call<LogEntry[]>("debug_logs", { query }),
  log: (level: Level, module: string, message: string) => call("debug_log", { level, module, message }),
  clearLogs: () => call("debug_clear_logs"),
  exportLogs: (query: LogQuery, path: string) => call<string>("debug_export_logs", { query, path }),
  diagnostics: () => call<Check[]>("debug_diagnostics"),
  exportDiagnostics: (path: string) => call<string>("debug_export_diagnostics", { path }),
  testDataState: () => call<TestDataState>("debug_test_data_state"),
  markTestAccount: (on: boolean) => call<TestDataState>("debug_mark_test_account", { on }),
  generate: (count: number, seed: number) => call<Generated>("debug_generate_test_data", { count, seed }),
  clearTestData: () => call<number>("debug_clear_test_data"),
  resetTestAccount: (confirm: string) => call("debug_reset_test_account", { confirm }),
  scenarios: () => call<ScenarioInfo[]>("debug_scenarios"),
  runScenarios: (ids: string[]) => call<ScenarioReport>("debug_run_scenarios", { ids }),
  setWindowSize: (width: number, height: number) => call("debug_set_window_size", { width, height }),
};
