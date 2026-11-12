// Отчёты по сделкам (этап 2): воронка с конверсиями, итоги периода, причины проигрыша, менеджеры.
// Всё считается в интерфейсе из уже загруженных сделок, этапов и истории этапов (ws_stage_history).

import type { CrmRecord, StageChange } from "../api/types";

export type Period = "month" | "quarter" | "year" | "all";

/** Начало периода по местному времени: текущий месяц, квартал или год; null — всё время. */
export function periodStart(p: Period, now: Date = new Date()): Date | null {
  if (p === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  if (p === "quarter") return new Date(now.getFullYear(), now.getMonth() - (now.getMonth() % 3), 1);
  if (p === "year") return new Date(now.getFullYear(), 0, 1);
  return null;
}

const live = (r: CrmRecord) => !r.deleted_at;
const time = (v: unknown) => (typeof v === "string" && v ? new Date(v).getTime() : NaN);
const since = (v: unknown, from: Date | null) => !from || time(v) >= from.getTime();

/** Суммы по валютам, крупные первыми. Сделки без суммы не считаются. */
export function sums(deals: CrmRecord[]): [string, number][] {
  const m = new Map<string, number>();
  for (const d of deals) {
    if (typeof d.amount !== "number") continue;
    const cur = String(d.currency || "RUB");
    m.set(cur, (m.get(cur) ?? 0) + d.amount);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export interface FunnelStep {
  stage: CrmRecord;
  /** Сделок, дошедших до этапа (или дальше). */
  reached: number;
  /** Доля от предыдущего шага, 0–1; у первого — null. */
  fromPrev: number | null;
  /** Доля от первого шага, 0–1. */
  fromFirst: number;
}

/**
 * Воронка: сделки воронки, созданные в периоде. Открытые этапы по порядку, в конце — успешный этап.
 * Сделка «дошла» до этапа, если была на нём или на более позднем открытом этапе (по истории и текущему этапу);
 * выигранная сделка прошла все открытые этапы.
 */
export function funnel(stages: CrmRecord[], deals: CrmRecord[], history: StageChange[], pipelineId: string, from: Date | null): FunnelStep[] {
  const own = stages.filter((s) => s.pipeline_id === pipelineId && !s.deleted_at).sort((a, b) => Number(a.position) - Number(b.position));
  const open = own.filter((s) => (s.kind ?? "open") === "open");
  const won = own.filter((s) => s.kind === "won");
  const pos = new Map(open.map((s, i) => [s.id, i]));
  const visited = new Map<string, Set<string>>();
  for (const h of history) {
    const set = visited.get(h.deal_id) ?? new Set<string>();
    if (h.from_stage_id) set.add(h.from_stage_id);
    set.add(h.to_stage_id);
    visited.set(h.deal_id, set);
  }
  const cohort = deals.filter((d) => live(d) && d.pipeline_id === pipelineId && since(d.created_at, from));
  const reachedIdx = cohort.map((d) => {
    if (d.status === "won") return open.length;
    let best = -1;
    for (const s of [String(d.stage_id), ...(visited.get(d.id) ?? [])]) best = Math.max(best, pos.get(s) ?? -1);
    return best;
  });
  const steps: FunnelStep[] = [];
  const counts = [...open.map((_, i) => reachedIdx.filter((r) => r >= i).length)];
  if (won.length) counts.push(cohort.filter((d) => d.status === "won").length);
  [...open, ...won.slice(0, 1)].forEach((stage, i) => {
    const reached = counts[i] ?? 0;
    const prev = i ? counts[i - 1]! : null;
    steps.push({ stage, reached, fromPrev: prev === null ? null : prev ? reached / prev : 0, fromFirst: counts[0] ? reached / counts[0] : 0 });
  });
  return steps;
}

export interface Summary {
  created: number;
  won: number;
  lost: number;
  wonSums: [string, number][];
  /** Доля выигранных среди закрытых в периоде, 0–1; null — закрытых нет. */
  winRate: number | null;
  /** Средний срок от создания до выигрыша, дней; null — выигранных нет. */
  cycleDays: number | null;
  open: number;
  openSums: [string, number][];
}

/** Итоги периода: закрытые в периоде (по дате закрытия), созданные в периоде и открытые сейчас. */
export function summary(deals: CrmRecord[], pipelineId: string | null, from: Date | null): Summary {
  const own = deals.filter((d) => live(d) && (!pipelineId || d.pipeline_id === pipelineId));
  const closed = own.filter((d) => d.status !== "open" && since(d.closed_at, from));
  const won = closed.filter((d) => d.status === "won");
  const lost = closed.filter((d) => d.status === "lost");
  const cycles = won.map((d) => (time(d.closed_at) - time(d.created_at)) / 86400_000).filter((n) => Number.isFinite(n) && n >= 0);
  const open = own.filter((d) => d.status === "open");
  return {
    created: own.filter((d) => since(d.created_at, from)).length,
    won: won.length,
    lost: lost.length,
    wonSums: sums(won),
    winRate: won.length + lost.length ? won.length / (won.length + lost.length) : null,
    cycleDays: cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null,
    open: open.length,
    openSums: sums(open),
  };
}

export const NO_REASON = "Причина не указана";

/** Причины проигрыша сделок, закрытых в периоде: самые частые первыми, без учёта регистра. */
export function lostReasons(deals: CrmRecord[], pipelineId: string | null, from: Date | null, limit = 6): { reason: string; count: number }[] {
  const m = new Map<string, { reason: string; count: number }>();
  for (const d of deals) {
    if (!live(d) || d.status !== "lost" || (pipelineId && d.pipeline_id !== pipelineId) || !since(d.closed_at, from)) continue;
    const reason = String(d.lost_reason ?? "").trim() || NO_REASON;
    const key = reason.toLocaleLowerCase("ru");
    const cur = m.get(key) ?? { reason, count: 0 };
    cur.count += 1;
    m.set(key, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "ru")).slice(0, limit);
}

export interface OwnerRow {
  owner: string | null;
  open: number;
  won: number;
  lost: number;
  wonSums: [string, number][];
  winRate: number | null;
}

/** Итоги по ответственным: открытые сейчас, выигранные и проигранные в периоде. Сначала больше выигравшие. */
export function byOwner(deals: CrmRecord[], pipelineId: string | null, from: Date | null): OwnerRow[] {
  const groups = new Map<string | null, CrmRecord[]>();
  for (const d of deals) {
    if (!live(d) || (pipelineId && d.pipeline_id !== pipelineId)) continue;
    const k = d.owner_id ? String(d.owner_id) : null;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  return [...groups.entries()]
    .map(([owner, list]) => {
      const s = summary(list, null, from);
      return { owner, open: s.open, won: s.won, lost: s.lost, wonSums: s.wonSums, winRate: s.winRate };
    })
    .filter((r) => r.open + r.won + r.lost > 0)
    .sort((a, b) => b.won - a.won || b.open - a.open);
}

/** Проценты без дробной части: 0.4567 → «46 %». */
export const percent = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)} %`);

// ---------------------------------------------------------------- прогноз и отчёты руководителя (G3)

const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthKey = (d: Date) => dateKey(d).slice(0, 7);

/** Взвешенные суммы: сумма сделки × вероятность её этапа. */
function weighted(deals: CrmRecord[], prob: (d: CrmRecord) => number): [string, number][] {
  return sums(deals.map((d) => (typeof d.amount === "number" ? { ...d, amount: (d.amount * prob(d)) / 100 } : d)));
}

export type ForecastBucket = "overdue" | "m0" | "m1" | "m2" | "later" | "none";

export interface ForecastRow {
  bucket: ForecastBucket;
  /** Первый день месяца для m0–m2. */
  month: Date | null;
  count: number;
  sums: [string, number][];
  /** Ожидаемые суммы: сумма × вероятность этапа. */
  weighted: [string, number][];
}

export interface Forecast {
  rows: ForecastRow[];
  weighted: [string, number][];
  /** Открытые сделки без суммы: в прогнозе денег их нет. */
  noAmount: number;
}

/**
 * Прогноз по открытым сделкам воронки: по месяцу ожидаемой даты закрытия (`expected_close_date`), с весом —
 * вероятностью этапа (`pipeline_stages.probability`, 0–100). Дата в прошлом — «срок прошёл», без даты — отдельно.
 */
export function forecast(deals: CrmRecord[], stages: CrmRecord[], pipelineId: string | null, now: Date = new Date()): Forecast {
  const prob = new Map(stages.map((s) => [s.id, Math.min(100, Math.max(0, Number(s.probability) || 0))]));
  const p = (d: CrmRecord) => prob.get(String(d.stage_id)) ?? 0;
  const open = deals.filter((d) => live(d) && d.status === "open" && (!pipelineId || d.pipeline_id === pipelineId));
  const today = dateKey(now);
  const months = [0, 1, 2].map((i) => new Date(now.getFullYear(), now.getMonth() + i, 1));
  const keys = months.map(monthKey);
  const bucketOf = (d: CrmRecord): ForecastBucket => {
    const v = typeof d.expected_close_date === "string" ? d.expected_close_date.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "none";
    if (v < today) return "overdue";
    const i = keys.indexOf(v.slice(0, 7));
    return i === 0 ? "m0" : i === 1 ? "m1" : i === 2 ? "m2" : "later";
  };
  const order: ForecastBucket[] = ["overdue", "m0", "m1", "m2", "later", "none"];
  const rows = order.map((bucket, i) => {
    const list = open.filter((d) => bucketOf(d) === bucket);
    return { bucket, month: i >= 1 && i <= 3 ? months[i - 1]! : null, count: list.length, sums: sums(list), weighted: weighted(list, p) };
  });
  return { rows, weighted: weighted(open, p), noAmount: open.filter((d) => typeof d.amount !== "number").length };
}

export interface MonthRow {
  month: Date;
  created: number;
  won: number;
  lost: number;
  wonSums: [string, number][];
}

/** Динамика за последние `count` месяцев (старые первыми): создано, выиграно и проиграно по месяцу события. */
export function monthly(deals: CrmRecord[], pipelineId: string | null, now: Date = new Date(), count = 6): MonthRow[] {
  const own = deals.filter((d) => live(d) && (!pipelineId || d.pipeline_id === pipelineId));
  const at = (v: unknown) => (typeof v === "string" && v ? monthKey(new Date(v)) : "");
  return Array.from({ length: count }, (_, i) => {
    const month = new Date(now.getFullYear(), now.getMonth() - (count - 1 - i), 1);
    const key = monthKey(month);
    const won = own.filter((d) => d.status === "won" && at(d.closed_at) === key);
    return {
      month,
      created: own.filter((d) => at(d.created_at) === key).length,
      won: won.length,
      lost: own.filter((d) => d.status === "lost" && at(d.closed_at) === key).length,
      wonSums: sums(won),
    };
  });
}

export const MANUAL_SOURCE = "Вручную";
export const IMPORT_SOURCE = "Импорт из таблиц";

/** Читаемое имя источника клиента: `import:файл` — импорт, `leadgen:telegram` — поиск клиентов, пусто — вручную. */
export function sourceName(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return MANUAL_SOURCE;
  if (s.startsWith("import:")) return IMPORT_SOURCE;
  if (s.startsWith("leadgen:")) return `Поиск клиентов · ${s.slice(8) || "—"}`;
  return s;
}

export interface SourceRow {
  source: string;
  /** Новых клиентов (компаний) в периоде. */
  clients: number;
  /** Выиграно сделок в периоде у клиентов этого источника. */
  won: number;
  wonSums: [string, number][];
}

/** Источники клиентов: новые компании периода и выигранные в периоде сделки их источника. Больше клиентов — выше. */
export function sources(companies: CrmRecord[], deals: CrmRecord[], pipelineId: string | null, from: Date | null): SourceRow[] {
  const sourceOf = new Map(companies.map((c) => [c.id, sourceName(c.source)]));
  const rows = new Map<string, { source: string; clients: number; won: CrmRecord[] }>();
  const get = (source: string) => {
    let r = rows.get(source);
    if (!r) rows.set(source, (r = { source, clients: 0, won: [] }));
    return r;
  };
  for (const c of companies) if (live(c) && since(c.created_at, from)) get(sourceName(c.source)).clients += 1;
  for (const d of deals) {
    if (!live(d) || d.status !== "won" || (pipelineId && d.pipeline_id !== pipelineId) || !since(d.closed_at, from)) continue;
    const s = d.company_id ? sourceOf.get(String(d.company_id)) : undefined;
    get(s ?? "Без клиента").won.push(d);
  }
  return [...rows.values()]
    .map((r) => ({ source: r.source, clients: r.clients, won: r.won.length, wonSums: sums(r.won) }))
    .filter((r) => r.clients + r.won > 0)
    .sort((a, b) => b.clients - a.clients || b.won - a.won || a.source.localeCompare(b.source, "ru"));
}

export interface TeamRow extends OwnerRow {
  /** Задач выполнено в периоде (по `completed_at`). */
  tasksDone: number;
  /** Открытых задач с прошедшим сроком сейчас. */
  overdue: number;
  /** Звонков, писем, встреч и других событий, записанных в периоде (кроме служебных). */
  activities: number;
}

/** Показатели сотрудников: сделки (как `byOwner`), задачи по исполнителю, события по автору. */
export function team(deals: CrmRecord[], tasks: CrmRecord[], activities: CrmRecord[], pipelineId: string | null, from: Date | null, now: Date = new Date()): TeamRow[] {
  const rows = new Map<string | null, TeamRow>();
  const empty = (owner: string | null): TeamRow => ({ owner, open: 0, won: 0, lost: 0, wonSums: [], winRate: null, tasksDone: 0, overdue: 0, activities: 0 });
  const get = (owner: unknown) => {
    const k = typeof owner === "string" && owner ? owner : null;
    let r = rows.get(k);
    if (!r) rows.set(k, (r = empty(k)));
    return r;
  };
  for (const o of byOwner(deals, pipelineId, from)) rows.set(o.owner, { ...empty(o.owner), ...o });
  for (const t of tasks) {
    if (!live(t)) continue;
    if (t.status === "done" && t.completed_at && since(t.completed_at, from)) get(t.assignee_id).tasksDone += 1;
    if (t.status !== "done" && t.status !== "cancelled" && time(t.due_at) < now.getTime()) get(t.assignee_id).overdue += 1;
  }
  for (const a of activities) if (live(a) && a.type !== "system" && since(a.occurred_at, from)) get(a.created_by).activities += 1;
  return [...rows.values()]
    .filter((r) => r.open + r.won + r.lost + r.tasksDone + r.overdue + r.activities > 0)
    .sort((a, b) => b.won - a.won || b.open - a.open || b.tasksDone - a.tasksDone || (a.owner === null ? 1 : b.owner === null ? -1 : 0));
}
