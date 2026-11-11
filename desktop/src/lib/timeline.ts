// Лента клиента (пакет B3): заметки, комментарии, события, задачи, смены этапов и создание записи в одном
// списке по времени. Для компании в ленту попадают и записи её сделок и контактов (с подписью источника).

import type { CrmRecord, WsCard } from "../api/types";
import { ENUMS } from "./crm";

export type TimelineKind = "note" | "comment" | "activity" | "task" | "task_done" | "stage" | "created";
export type TimelineFilter = "all" | "notes" | "events" | "tasks" | "stages";

export interface TimelineItem {
  key: string;
  at: string;
  kind: TimelineKind;
  icon: string;
  label: string;
  text: string;
  who: string | null;
  /** Откуда запись в ленте компании: «Сделка: …», «Контакт: …». Пусто — сама карточка. */
  source: string | null;
  /** Что открыть по щелчку: задача, сделка или контакт. */
  open: { table: string; id: string } | null;
}

export interface TimelineSource { card: WsCard; source: string | null; table: string }

const ACTIVITY_ICON: Record<string, string> = { call: "phone", email: "mail", meeting: "users", system: "info", payment: "tag", agreement: "file" };

/** Собрать ленту из карточки и (для компании) карточек её сделок и контактов. Новые события сверху. */
export function buildTimeline(sources: TimelineSource[], stageName: (id: string | null) => string): TimelineItem[] {
  const out: TimelineItem[] = [];
  const seen = new Set<string>();
  const push = (it: TimelineItem) => { if (!seen.has(it.key)) { seen.add(it.key); out.push(it); } };
  for (const { card, source, table } of sources) {
    const r = card.record;
    const self = source ? { table, id: r.id } : null;
    push({ key: `created:${r.id}`, at: r.created_at, kind: "created", icon: "plus", label: source ? "Создана запись" : "Запись создана", text: "", who: r.created_by ?? null, source, open: self });
    for (const n of card.notes ?? []) if (!n.deleted_at) push({ key: `note:${n.id}`, at: n.created_at, kind: "note", icon: "note", label: "Заметка", text: String(n.body ?? ""), who: n.created_by, source, open: self });
    for (const c of card.comments ?? []) if (!c.deleted_at) push({ key: `comment:${c.id}`, at: c.created_at, kind: "comment", icon: "chat", label: "Комментарий", text: String(c.body ?? ""), who: c.created_by, source, open: self });
    for (const a of card.activities ?? []) {
      if (a.deleted_at) continue;
      const type = String(a.type ?? "custom");
      push({ key: `activity:${a.id}`, at: String(a.occurred_at ?? a.created_at), kind: "activity", icon: ACTIVITY_ICON[type] ?? "dot", label: ENUMS["activities.type"]?.[type] ?? type, text: String(a.summary ?? ""), who: a.created_by, source, open: self });
    }
    for (const t of card.tasks ?? []) {
      if (t.deleted_at) continue;
      const open = { table: "tasks", id: t.id };
      push({ key: `task:${t.id}`, at: t.created_at, kind: "task", icon: "check", label: "Поставлена задача", text: String(t.title ?? ""), who: t.created_by, source, open });
      if (t.status === "done" && t.completed_at) push({ key: `done:${t.id}`, at: String(t.completed_at), kind: "task_done", icon: "check", label: "Задача выполнена", text: String(t.title ?? ""), who: (t.updated_by as string) ?? null, source, open });
    }
    for (const h of card.history ?? []) {
      push({ key: `stage:${r.id}:${h.changed_at}:${h.to_stage_id}`, at: h.changed_at, kind: "stage", icon: "chevronRight", label: "Этап сделки", text: `${stageName(h.from_stage_id)} → ${stageName(h.to_stage_id)}`, who: h.changed_by, source, open: self });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

const FILTER: Record<TimelineFilter, TimelineKind[] | null> = {
  all: null,
  notes: ["note", "comment"],
  events: ["activity"],
  tasks: ["task", "task_done"],
  stages: ["stage", "created"],
};

export function filterTimeline(items: TimelineItem[], f: TimelineFilter): TimelineItem[] {
  const kinds = FILTER[f];
  return kinds ? items.filter((i) => kinds.includes(i.kind)) : items;
}

/** Сделки и контакты компании, карточки которых добавляются в её ленту (не больше `limit`, свежие первыми). */
export function relatedForTimeline(card: WsCard, limit = 20): { table: string; rec: CrmRecord }[] {
  const live = (r: CrmRecord) => !r.deleted_at;
  const fresh = (a: CrmRecord, b: CrmRecord) => String(b.updated_at).localeCompare(String(a.updated_at));
  return [
    ...(card.deals ?? []).filter(live).sort(fresh).map((rec) => ({ table: "deals", rec })),
    ...(card.contacts ?? []).filter(live).sort(fresh).map((rec) => ({ table: "contacts", rec })),
  ].slice(0, limit);
}
