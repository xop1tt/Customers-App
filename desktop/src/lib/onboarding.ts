// Первый запуск CRM (пакет G7, ADR-063): шаблоны воронки, план изменения этапов и карточка «Начало работы».
// Чистая логика: этапы меняются обычными ws_save/ws_delete, схема базы не меняется.

import type { CrmRecord } from "../api/types";

export type TemplateId = "services" | "goods" | "projects";

export interface PipelineTemplate {
  id: TemplateId;
  title: string;
  hint: string;
  /** Открытые этапы по порядку и название выигрышного этапа. */
  open: string[];
  won: string;
}

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  { id: "services", title: "Услуги", hint: "Агентства, студии, подрядчики", open: ["Новый", "Квалификация", "Предложение", "Переговоры", "Счёт"], won: "Успех" },
  { id: "goods", title: "Товары", hint: "Продажи и поставки", open: ["Заявка", "Счёт выставлен", "Оплачено", "Отгрузка"], won: "Получено" },
  { id: "projects", title: "Проекты", hint: "Длинные сделки с оценкой и договором", open: ["Заявка", "Оценка", "Договор", "В работе"], won: "Сдано" },
];

/** Вероятности открытых этапов по порядку: от 10 до 80 % равными шагами (для прогноза, ADR-056). */
export function probabilities(n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [50];
  return Array.from({ length: n }, (_, i) => Math.round(10 + (70 * i) / (n - 1)));
}

export interface StagePlan {
  update: { id: string; patch: Record<string, unknown> }[];
  create: Record<string, unknown>[];
  remove: string[];
}

const COLORS = ["#6b7280", "#3b82f6", "#8b5cf6", "#f59e0b", "#ec4899", "#14b8a6", "#0ea5e9", "#84cc16"];
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

/**
 * Как привести этапы воронки к шаблону: открытые этапы переименовываются по порядку, недостающие создаются,
 * лишние удаляются; выигрышный этап получает название шаблона, проигрышный не меняется. Позиции идут подряд:
 * открытые, затем выигрыш и проигрыш.
 */
export function planStages(stages: CrmRecord[], pipelineId: string, tpl: PipelineTemplate): StagePlan {
  const mine = stages.filter((s) => s.pipeline_id === pipelineId && !s.deleted_at).sort((a, b) => num(a.position) - num(b.position));
  const open = mine.filter((s) => (s.kind ?? "open") === "open");
  const won = mine.find((s) => s.kind === "won");
  const lost = mine.find((s) => s.kind === "lost");
  const prob = probabilities(tpl.open.length);
  const plan: StagePlan = { update: [], create: [], remove: [] };
  tpl.open.forEach((name, i) => {
    const fields = { name, position: i + 1, probability: prob[i]!, kind: "open" };
    const cur = open[i];
    if (cur) plan.update.push({ id: cur.id, patch: fields });
    else plan.create.push({ ...fields, pipeline_id: pipelineId, color: COLORS[i % COLORS.length] });
  });
  plan.remove = open.slice(tpl.open.length).map((s) => s.id);
  const after = tpl.open.length;
  if (won) plan.update.push({ id: won.id, patch: { name: tpl.won, position: after + 1, probability: 100 } });
  else plan.create.push({ name: tpl.won, position: after + 1, probability: 100, kind: "won", pipeline_id: pipelineId, color: "#22c55e" });
  if (lost) plan.update.push({ id: lost.id, patch: { position: after + 2 } });
  return plan;
}

// ---------------------------------------------------------------- «Начало работы» на «Сегодня»

export type StartItemId = "workspace" | "clients" | "deal" | "task" | "backup";

export interface StartFacts {
  /** Мастер пройден (воронка и Workspace настроены или пропущены осознанно). */
  wizardDone: boolean;
  companies: number;
  deals: number;
  tasks: number;
  /** Есть хотя бы одна резервная копия или включены автоматические копии. */
  backup: boolean;
}

export interface StartItem { id: StartItemId; title: string; done: boolean }

export function startChecklist(f: StartFacts): StartItem[] {
  return [
    { id: "workspace", title: "Создать Workspace и воронку", done: f.wizardDone },
    { id: "clients", title: "Добавить клиентов", done: f.companies > 0 },
    { id: "deal", title: "Создать первую сделку", done: f.deals > 0 },
    { id: "task", title: "Запланировать задачу или встречу", done: f.tasks > 0 },
    { id: "backup", title: "Настроить резервную копию", done: f.backup },
  ];
}

/** Карточка видна, пока не всё сделано и её не скрыли. */
export const showChecklist = (items: StartItem[], hidden: boolean) => !hidden && items.some((i) => !i.done);
