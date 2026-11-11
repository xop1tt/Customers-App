// Чистая логика экранов продаж (пакет B2): колонки канбана сделок и группы экрана «Сегодня».

import type { CrmRecord } from "../api/types";

export interface BoardColumn {
  stage: CrmRecord;
  deals: CrmRecord[];
  /** Суммы по валютам: «RUB» → 180 000. Сделки без суммы не считаются. */
  totals: [string, number][];
}

const live = (r: CrmRecord) => !r.deleted_at && !r.archived_at;

/** Колонки доски: этапы воронки по порядку, в каждой — её сделки, новые изменения сверху. */
export function boardColumns(stages: CrmRecord[], deals: CrmRecord[], pipelineId: string): BoardColumn[] {
  const own = stages.filter((s) => s.pipeline_id === pipelineId && !s.deleted_at).sort((a, b) => Number(a.position) - Number(b.position));
  return own.map((stage) => {
    const list = deals
      .filter((d) => live(d) && d.stage_id === stage.id)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const sums = new Map<string, number>();
    for (const d of list) {
      if (typeof d.amount !== "number") continue;
      const cur = String(d.currency || "RUB");
      sums.set(cur, (sums.get(cur) ?? 0) + d.amount);
    }
    return { stage, deals: list, totals: [...sums.entries()].sort((a, b) => b[1] - a[1]) };
  });
}

/** Можно ли перенести сделку в этап: другой этап той же воронки. */
export function canMove(deal: CrmRecord, stage: CrmRecord): boolean {
  return deal.stage_id !== stage.id && deal.pipeline_id === stage.pipeline_id;
}

export const STALE_DAYS = 7;

export interface TodayGroups {
  overdue: CrmRecord[];
  today: CrmRecord[];
  /** Открытые сделки без изменений STALE_DAYS дней и дольше, самые старые сверху. */
  stale: { deal: CrmRecord; days: number }[];
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const open = (t: CrmRecord) => live(t) && t.status !== "done" && t.status !== "cancelled";

/** Группы экрана «Сегодня» по местному времени. `mine` — только задачи, назначенные этому участнику (или без исполнителя). */
export function todayGroups(tasks: CrmRecord[], deals: CrmRecord[], now: Date, mine?: string): TodayGroups {
  const from = startOfDay(now).getTime();
  const to = from + 86_400_000;
  const due = (t: CrmRecord) => (t.due_at ? Date.parse(String(t.due_at)) : NaN);
  const forMe = (t: CrmRecord) => !mine || !t.assignee_id || t.assignee_id === mine;
  const active = tasks.filter((t) => open(t) && forMe(t) && !Number.isNaN(due(t))).sort((a, b) => due(a) - due(b));
  const stale = deals
    .filter((d) => live(d) && d.status === "open" && (!mine || !d.owner_id || d.owner_id === mine))
    .map((deal) => ({ deal, days: Math.floor((now.getTime() - Date.parse(String(deal.updated_at))) / 86_400_000) }))
    .filter((x) => x.days >= STALE_DAYS)
    .sort((a, b) => b.days - a.days);
  return {
    overdue: active.filter((t) => due(t) < from),
    today: active.filter((t) => due(t) >= from && due(t) < to),
    stale,
  };
}
