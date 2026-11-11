// Быстрый поиск (пакет G5, docs/QUICK_SEARCH.md): действия окна Ctrl/Cmd+K и порядок результатов.

import type { CrmRecord } from "../api/types";
import { can, ENTITIES, type EntityType } from "./crm";
import type { SectionId } from "./leads";

/** Где искать и в каком порядке показывать группы. */
export const QUICK_TABLES: EntityType[] = ["company", "contact", "deal", "task", "crm_lead"];
/** Сколько записей показывать в группе. */
export const QUICK_LIMIT = 5;

export type QuickItem =
  | { kind: "record"; key: string; type: EntityType; record: CrmRecord; title: string; hint: string }
  | { kind: "create"; key: string; type: EntityType; title: string }
  | { kind: "go"; key: string; section: SectionId; title: string };

const CREATE: [EntityType, string][] = [["company", "Новая компания"], ["contact", "Новый контакт"], ["deal", "Новая сделка"], ["task", "Новая задача"], ["crm_lead", "Новая заявка"]];
const GO: [SectionId, string][] = [["today", "Перейти: Сегодня"], ["calendar", "Перейти: Календарь"], ["deals", "Перейти: Сделки"], ["reports", "Перейти: Отчёты"]];

const norm = (s: string) => s.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();

/** Подпись под названием записи: телефон, почта, сумма или срок — что есть. */
export function hintOf(type: EntityType, r: CrmRecord): string {
  const first = (v: unknown) => (Array.isArray(v) && v.length ? String(v[0]) : "");
  if (type === "company" || type === "contact") return [first(r.phones), first(r.emails)].filter(Boolean).join(" · ");
  if (type === "crm_lead") return String(r.company_name || r.person_name || "");
  if (type === "task" && typeof r.due_at === "string") return new Date(r.due_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  return "";
}

/** Действия окна: создание (по праву) и переходы. Пустой запрос — все, иначе — содержащие текст. */
export function quickActions(query: string, perms: string[]): QuickItem[] {
  const q = norm(query);
  const items: QuickItem[] = [
    ...(can(perms, "create") ? CREATE.map(([type, title]): QuickItem => ({ kind: "create", key: `new:${type}`, type, title })) : []),
    ...GO.map(([section, title]): QuickItem => ({ kind: "go", key: `go:${section}`, section, title })),
  ];
  return q ? items.filter((i) => norm(i.title).includes(q)) : items;
}

/** Результаты поиска по группам в порядке `QUICK_TABLES`. */
export function quickRecords(found: Partial<Record<EntityType, CrmRecord[]>>): QuickItem[] {
  return QUICK_TABLES.flatMap((type) =>
    (found[type] ?? []).slice(0, QUICK_LIMIT).map((record): QuickItem => ({ kind: "record", key: `${type}:${record.id}`, type, record, title: ENTITIES[type].title(record), hint: hintOf(type, record) })),
  );
}

/** Следующий выделенный пункт по стрелкам: по кругу. */
export const moveActive = (index: number, count: number, dir: 1 | -1) => (count ? (index + dir + count) % count : 0);
