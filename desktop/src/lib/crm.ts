// Описание CRM-сущностей для интерфейса: подписи полей, столбцы таблиц, значения перечислений.
// Те же имена полей, что в ядре (workspace/schema.rs) и в миграциях Supabase.

import type { CrmRecord, WsMember } from "../api/types";
import { dateOnly, money, shortRelative } from "./format";

export type EntityType = "company" | "contact" | "crm_lead" | "deal" | "task";
export type FieldKind = "text" | "long" | "list" | "money" | "currency" | "date" | "datetime" | "member" | "enum" | "company" | "stage" | "pipeline" | "number";

export interface FieldMeta { name: string; label: string; kind: FieldKind; required?: boolean }
export interface EntityMeta {
  type: EntityType;
  table: string;
  one: string;
  many: string;
  emoji: string;
  title: (r: CrmRecord) => string;
  /** Столбцы таблицы коллекции по умолчанию. */
  columns: string[];
  fields: FieldMeta[];
}

export const ENUMS: Record<string, Record<string, string>> = {
  "crm_leads.status": { new: "Новый", in_progress: "В работе", qualified: "Квалифицирован", disqualified: "Отклонён", converted: "Переведён" },
  "tasks.priority": { low: "Низкий", normal: "Обычный", high: "Высокий", urgent: "Срочный" },
  "tasks.status": { todo: "К выполнению", in_progress: "В работе", done: "Готово", cancelled: "Отменена" },
  "deals.status": { open: "Открыта", won: "Успешна", lost: "Потеряна" },
  "activities.type": {
    call: "Звонок", email: "Письмо", meeting: "Встреча", follow_up: "Повторный контакт", reminder: "Напоминание", agreement: "Договорённость",
    payment: "Оплата", custom: "Событие", system: "Система",
  },
};

export const CURRENCIES = ["RUB", "USD", "EUR", "KZT", "BYN", "CNY"];

const text = (r: CrmRecord, f: string) => (typeof r[f] === "string" ? (r[f] as string) : "");

export const ENTITIES: Record<EntityType, EntityMeta> = {
  company: {
    type: "company", table: "companies", one: "Компания", many: "Компании", emoji: "🏢",
    title: (r) => text(r, "name") || "Без названия",
    columns: ["name", "phones", "emails", "industry", "owner_id", "updated_at"],
    fields: [
      { name: "name", label: "Название", kind: "text", required: true },
      { name: "legal_name", label: "Юр. название", kind: "text" },
      { name: "inn", label: "ИНН", kind: "text" },
      { name: "website", label: "Сайт", kind: "text" },
      { name: "domain", label: "Домен", kind: "text" },
      { name: "phones", label: "Телефоны", kind: "list" },
      { name: "emails", label: "Почта", kind: "list" },
      { name: "address", label: "Адрес", kind: "text" },
      { name: "industry", label: "Отрасль", kind: "text" },
      { name: "size_range", label: "Размер", kind: "text" },
      { name: "owner_id", label: "Ответственный", kind: "member" },
    ],
  },
  contact: {
    type: "contact", table: "contacts", one: "Контакт", many: "Контакты", emoji: "👤",
    title: (r) => text(r, "full_name") || "Без имени",
    columns: ["full_name", "position", "phones", "emails", "owner_id", "updated_at"],
    fields: [
      { name: "first_name", label: "Имя", kind: "text" },
      { name: "last_name", label: "Фамилия", kind: "text" },
      { name: "position", label: "Должность", kind: "text" },
      { name: "company_id", label: "Компания", kind: "company" },
      { name: "phones", label: "Телефоны", kind: "list" },
      { name: "emails", label: "Почта", kind: "list" },
      { name: "owner_id", label: "Ответственный", kind: "member" },
    ],
  },
  crm_lead: {
    type: "crm_lead", table: "crm_leads", one: "Лид", many: "Лиды CRM", emoji: "🌱",
    title: (r) => text(r, "title") || "Без названия",
    columns: ["title", "company_name", "status", "source", "owner_id", "created_at"],
    fields: [
      { name: "title", label: "Название", kind: "text", required: true },
      { name: "person_name", label: "Человек", kind: "text" },
      { name: "company_name", label: "Компания", kind: "text" },
      { name: "phones", label: "Телефоны", kind: "list" },
      { name: "emails", label: "Почта", kind: "list" },
      { name: "status", label: "Статус", kind: "enum" },
      { name: "source", label: "Источник", kind: "text" },
      { name: "owner_id", label: "Ответственный", kind: "member" },
    ],
  },
  deal: {
    type: "deal", table: "deals", one: "Сделка", many: "Сделки", emoji: "💼",
    title: (r) => text(r, "title") || "Без названия",
    columns: ["title", "stage_id", "amount", "expected_close_date", "owner_id", "updated_at"],
    fields: [
      { name: "title", label: "Название", kind: "text", required: true },
      { name: "pipeline_id", label: "Воронка", kind: "pipeline", required: true },
      { name: "stage_id", label: "Этап", kind: "stage", required: true },
      { name: "amount", label: "Сумма", kind: "money" },
      { name: "currency", label: "Валюта", kind: "currency" },
      { name: "expected_close_date", label: "Закрытие", kind: "date" },
      { name: "company_id", label: "Компания", kind: "company" },
      { name: "lost_reason", label: "Причина проигрыша", kind: "long" },
      { name: "owner_id", label: "Ответственный", kind: "member" },
    ],
  },
  task: {
    type: "task", table: "tasks", one: "Задача", many: "Задачи", emoji: "📋",
    title: (r) => text(r, "title") || "Без названия",
    columns: ["title", "status", "priority", "due_at", "assignee_id", "updated_at"],
    fields: [
      { name: "title", label: "Задача", kind: "text", required: true },
      { name: "description", label: "Описание", kind: "long" },
      { name: "status", label: "Статус", kind: "enum" },
      { name: "priority", label: "Приоритет", kind: "enum" },
      { name: "due_at", label: "Срок", kind: "datetime" },
      { name: "remind_at", label: "Напомнить", kind: "datetime" },
      { name: "assignee_id", label: "Исполнитель", kind: "member" },
    ],
  },
};

export const ENTITY_TYPES = Object.keys(ENTITIES) as EntityType[];
export const byTable = (table: string): EntityMeta | undefined => Object.values(ENTITIES).find((e) => e.table === table);

const COLUMN_LABELS: Record<string, string> = {
  updated_at: "Изменено", created_at: "Создано", full_name: "Имя", status: "Статус", source: "Источник", closed_at: "Закрыта",
};
export function columnLabel(e: EntityMeta, col: string): string {
  return e.fields.find((f) => f.name === col)?.label ?? COLUMN_LABELS[col] ?? col;
}

export interface Lookup { members: WsMember[]; stages: Map<string, CrmRecord>; companies: Map<string, CrmRecord>; pipelines: Map<string, CrmRecord> }

export const memberName = (members: WsMember[], id: unknown) => (typeof id === "string" ? members.find((m) => m.userId === id)?.displayName ?? "Участник" : "");

/** Значение ячейки таблицы как текст. */
export function cellText(e: EntityMeta, r: CrmRecord, col: string, lk: Lookup): string {
  const v = r[col];
  if (v === null || v === undefined || v === "") return "";
  const kind = e.fields.find((f) => f.name === col)?.kind;
  if (Array.isArray(v)) return v.join(", ");
  if (col.endsWith("_at") && typeof v === "string") return shortRelative(v);
  if (col === "owner_id" || col === "assignee_id" || col === "created_by") return memberName(lk.members, v);
  if (col === "stage_id") return text(lk.stages.get(String(v)) ?? ({} as CrmRecord), "name");
  if (col === "company_id") return text(lk.companies.get(String(v)) ?? ({} as CrmRecord), "name");
  if (col === "pipeline_id") return text(lk.pipelines.get(String(v)) ?? ({} as CrmRecord), "name");
  if (kind === "money" && typeof v === "number") return money(v, typeof r.currency === "string" ? r.currency : "RUB");
  if (kind === "date" && typeof v === "string") return dateOnly(v);
  const en = ENUMS[`${e.table}.${col}`];
  if (en && typeof v === "string") return en[v] ?? v;
  return String(v);
}

/** Текст поля ввода → значение для ядра (пустое поле — null, список — массив без пустых строк). */
export function fromInput(kind: FieldKind, raw: string): unknown {
  const t = raw.trim();
  if (kind === "list") return t ? t.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean) : [];
  if (!t) return null;
  if (kind === "money" || kind === "number") {
    const n = Number(t.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : t;
  }
  if (kind === "datetime") {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? t : d.toISOString();
  }
  return t;
}

export function toInput(kind: FieldKind, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (kind === "datetime" && typeof v === "string") {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return String(v);
}

/** Право на действие по таблице разрешений Workspace (то же решает сервер; здесь — чтобы не показывать лишнего). */
export function can(perms: string[], action: "view" | "create" | "edit" | "delete" | "export" | "collections" | "pipelines" | "invite" | "members" | "workspace", record?: CrmRecord | null, me?: string): boolean {
  const has = (p: string) => perms.includes(p);
  switch (action) {
    case "view": return has("records.view");
    case "create": return has("records.create");
    case "delete": return has("records.delete");
    case "export": return has("records.export");
    case "collections": return has("collections.manage");
    case "pipelines": return has("pipelines.manage");
    case "invite": return has("invitations.manage");
    case "members": return has("members.manage");
    case "workspace": return has("workspace.manage");
    case "edit":
      if (has("records.edit")) return true;
      if (!has("records.edit_own") || !record || !me) return false;
      return record.created_by === me || record.owner_id === me || record.assignee_id === me;
  }
}

/** Эмодзи для выбора иконки коллекции: 48 штук, без внешних библиотек. */
export const COLLECTION_EMOJI = [
  "🤝", "⭐", "🌱", "📅", "⏰", "🏆", "🥀", "🏢", "👤", "💼", "📋", "📊",
  "🔥", "💎", "🚀", "🎯", "📈", "📉", "💰", "🧾", "📦", "🛒", "🏭", "🏗️",
  "🏥", "🎓", "🍽️", "🚚", "✈️", "🏠", "💡", "🔧", "🧪", "🎨", "📣", "📞",
  "✉️", "🗂️", "📌", "🔖", "🟢", "🟡", "🔴", "🔵", "🟣", "⚪", "❤️", "👑",
];

export const STATUS_TONE: Record<string, "gray" | "green" | "red" | "blue" | "orange" | "purple"> = {
  open: "blue", won: "green", lost: "red", todo: "gray", in_progress: "blue", done: "green", cancelled: "gray",
  new: "purple", qualified: "green", disqualified: "red", converted: "green", urgent: "red", high: "orange", normal: "gray", low: "gray",
};
