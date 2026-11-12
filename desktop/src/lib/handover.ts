// Передача записей: что числится за сотрудником и как перекинуть это коллеге (уход, отпуск, смена зоны).
// Только приложение: записи меняются обычным сохранением поля «Ответственный» / «Исполнитель» (права проверяет ядро).

import { api } from "../api";
import type { WsFilter } from "../api/types";
import type { EntityType } from "./crm";

export interface HandoverKind {
  type: EntityType;
  table: string;
  /** Поле, где хранится ответственный. */
  field: "owner_id" | "assignee_id";
  /** Подпись счётчика («3 сделки»). */
  label: string;
  /** Чьи записи передаём: законченные (выигранные сделки, выполненные задачи) остаются за прежним ответственным ради истории и отчётов. */
  open: WsFilter | null;
}

export const HANDOVER: HandoverKind[] = [
  { type: "company", table: "companies", field: "owner_id", label: "Компании", open: null },
  { type: "contact", table: "contacts", field: "owner_id", label: "Контакты", open: null },
  { type: "crm_lead", table: "crm_leads", field: "owner_id", label: "Заявки в работе", open: { field: "status", op: "in", value: ["new", "in_progress", "qualified"] } },
  { type: "deal", table: "deals", field: "owner_id", label: "Открытые сделки", open: { field: "status", op: "eq", value: "open" } },
  { type: "task", table: "tasks", field: "assignee_id", label: "Невыполненные задачи", open: { field: "status", op: "in", value: ["todo", "in_progress"] } },
];

const filtersFor = (k: HandoverKind, user: string): WsFilter[] => [{ field: k.field, op: "eq", value: user }, ...(k.open ? [k.open] : [])];

export type HandoverCounts = Record<string, number>;

/** Сколько записей числится за сотрудником (по таблицам). */
export async function countOwned(user: string): Promise<HandoverCounts> {
  const out: HandoverCounts = {};
  for (const k of HANDOVER) {
    const r = await api.wsList(k.table, { filters: filtersFor(k, user), limit: 1 });
    out[k.table] = r.total;
  }
  return out;
}

export const totalOf = (c: HandoverCounts) => Object.values(c).reduce((a, b) => a + b, 0);

export interface HandoverResult { moved: number; failed: number }

/** Передать выбранные таблицы от одного сотрудника другому. Ошибка одной записи не останавливает остальные. */
export async function transferOwned(from: string, to: string, tables: string[], progress?: (done: number, total: number) => void): Promise<HandoverResult> {
  const jobs: { k: HandoverKind; id: string }[] = [];
  for (const k of HANDOVER.filter((x) => tables.includes(x.table))) {
    const r = await api.wsList(k.table, { filters: filtersFor(k, from), limit: 5000 });
    for (const rec of r.items) jobs.push({ k, id: rec.id });
  }
  let moved = 0, failed = 0;
  for (const j of jobs) {
    try { await api.wsSave(j.k.table, j.id, { [j.k.field]: to }); moved += 1; } catch { failed += 1; }
    progress?.(moved + failed, jobs.length);
  }
  return { moved, failed };
}

/** «3 сделки, 2 задачи» для текста подтверждения. */
export function describeCounts(c: HandoverCounts): string {
  return HANDOVER.filter((k) => (c[k.table] ?? 0) > 0).map((k) => `${k.label.toLowerCase()}: ${c[k.table]}`).join(", ");
}
