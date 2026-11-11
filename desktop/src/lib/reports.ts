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
