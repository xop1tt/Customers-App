// Коммуникации в карточке CRM (G6, ADR-059): куда звонить и писать, шаблоны писем и «следующее действие» сделки.
// Чистая логика без вызовов ядра: схема базы не меняется, звонки и письма записываются обычными событиями (activities).

import type { CrmRecord } from "../api/types";
import { t } from "./i18n";

/** Телефон или адрес с подписью, чей он: «ООО Ромашка» или «Иван Петров». */
export interface ContactPoint { value: string; owner: string }

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);

const nameOf = (r: CrmRecord): string => {
  const full = typeof r.full_name === "string" && r.full_name.trim() ? r.full_name.trim() : [r.first_name, r.last_name].filter((x) => typeof x === "string" && x.trim()).join(" ");
  return full || (typeof r.name === "string" ? r.name : "");
};

/** Телефоны и адреса записей по порядку, без повторов (повтор остаётся за первой записью). */
export function contactPoints(records: CrmRecord[], field: "phones" | "emails"): ContactPoint[] {
  const seen = new Set<string>();
  const out: ContactPoint[] = [];
  for (const r of records) {
    for (const value of list(r[field])) {
      const key = field === "emails" ? value.toLowerCase() : value.replace(/[^\d+]/g, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ value, owner: nameOf(r) });
    }
  }
  return out;
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

// ---------------------------------------------------------------- шаблоны писем

export type TemplateId = "intro" | "offer" | "after_meeting" | "follow_up" | "thanks" | "blank";

export interface MailTemplate { id: TemplateId; title: string; subject: string; body: string }

/** Встроенные шаблоны. Подстановки: {name} — к кому обращаемся, {company} — компания, {deal} — сделка. */
export const TEMPLATES: MailTemplate[] = [
  { id: "intro", title: "Знакомство", subject: "Знакомство: {company}", body: "Здравствуйте, {name}!\n\nМеня зовут …, я пишу вам по поводу сотрудничества с {company}. Мы помогаем компаниям …\n\nБуду рад коротко созвониться на этой неделе. Когда вам удобно?" },
  { id: "offer", title: "Коммерческое предложение", subject: "Предложение для {company}", body: "Здравствуйте, {name}!\n\nКак договаривались, отправляю предложение по «{deal}». Коротко: …\n\nСрок действия предложения — …. Если есть вопросы, отвечу письмом или по телефону." },
  { id: "after_meeting", title: "После встречи", subject: "Итоги встречи: {deal}", body: "Здравствуйте, {name}!\n\nСпасибо за встречу. Фиксирую, о чём договорились:\n— …\n— …\n\nСледующий шаг: …" },
  { id: "follow_up", title: "Напоминание", subject: "Напоминаю о «{deal}»", body: "Здравствуйте, {name}!\n\nНапоминаю о нашем разговоре по «{deal}». Удалось ли посмотреть предложение? Если удобно, созвонимся в ближайшие дни." },
  { id: "thanks", title: "Благодарность", subject: "Спасибо за сотрудничество", body: "Здравствуйте, {name}!\n\nСпасибо, что выбрали нас. Если понадобится помощь, пишите в ответ на это письмо." },
  { id: "blank", title: "Пустое письмо", subject: "", body: "Здравствуйте, {name}!\n\n" },
];

export interface TemplateContext { name: string; company: string; deal: string; signature: string }

/** Подставляет значения в шаблон; пустые подстановки убираются аккуратно (без «, !» и пустых кавычек). */
export function fillTemplate(tpl: MailTemplate, ctx: TemplateContext): { subject: string; body: string } {
  const sub = (s: string) => t(s)
    .replace(/\{name\}/g, ctx.name.trim())
    .replace(/\{company\}/g, ctx.company.trim())
    .replace(/\{deal\}/g, ctx.deal.trim())
    .replace(/«»|“”/g, "")
    .replace(/,\s*!/g, "!")
    .replace(/ {2,}/g, " ")
    .replace(/ +([!,.:])/g, "$1");
  const sign = ctx.signature.trim() ? `\n\n${ctx.signature.trim()}` : "";
  return {
    subject: sub(tpl.subject).replace(/^[\s:—-]+|[\s:—-]+$/g, "").slice(0, 160),
    body: sub(tpl.body).trimEnd() + sign,
  };
}

// ---------------------------------------------------------------- следующее действие

export interface NextAction { task: CrmRecord; overdue: boolean; dated: boolean }

export const isOpenTask = (task: CrmRecord) => !task.deleted_at && task.status !== "done" && task.status !== "cancelled";

/** Ближайшая открытая задача: сначала со сроком (по сроку), затем без срока (по времени создания). */
export function nextAction(tasks: CrmRecord[], now: Date = new Date()): NextAction | null {
  const open = tasks.filter(isOpenTask);
  if (!open.length) return null;
  const due = (x: CrmRecord) => (typeof x.due_at === "string" && x.due_at ? x.due_at : null);
  open.sort((a, b) => {
    const da = due(a), db = due(b);
    if (da && db) return da < db ? -1 : da > db ? 1 : 0;
    if (da) return -1;
    if (db) return 1;
    return String(a.created_at ?? "") < String(b.created_at ?? "") ? -1 : 1;
  });
  const task = open[0]!;
  const d = due(task);
  return { task, dated: !!d, overdue: !!d && new Date(d).getTime() < now.getTime() };
}

/** Следующее действие по каждой сделке из общего списка задач (задачи, привязанные к сделкам). */
export function nextActions(tasks: CrmRecord[], now: Date = new Date()): Map<string, NextAction> {
  const byDeal = new Map<string, CrmRecord[]>();
  for (const task of tasks) {
    if (task.entity_type !== "deal" || typeof task.entity_id !== "string") continue;
    const arr = byDeal.get(task.entity_id) ?? [];
    arr.push(task);
    byDeal.set(task.entity_id, arr);
  }
  const out = new Map<string, NextAction>();
  for (const [id, arr] of byDeal) {
    const n = nextAction(arr, now);
    if (n) out.set(id, n);
  }
  return out;
}

/** Быстрые сроки для «Запланировать»: через день — в 10:00 местного времени и т. п. */
export function quickDue(kind: "today" | "tomorrow" | "week", now: Date = new Date()): Date {
  const d = new Date(now);
  if (kind === "today") {
    d.setHours(Math.max(d.getHours() + 2, 10), 0, 0, 0);
    if (d.getDate() !== now.getDate()) { d.setTime(now.getTime()); d.setHours(23, 59, 0, 0); }
    return d;
  }
  d.setDate(d.getDate() + (kind === "tomorrow" ? 1 : 7));
  d.setHours(10, 0, 0, 0);
  return d;
}
