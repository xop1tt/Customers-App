// Модули рейки слева (пакет C2, вариант B из C1): CRM и поиск клиентов. Ai — не модуль, а выдвижной чат у нижней кнопки рейки.
// Модуль «Команда» убран вместе с облаком (ADR-100).

import type { SectionId } from "./leads";

export type ModuleId = "crm" | "search";

export const MODULES: { id: ModuleId; title: string; short: string; icon: string; home: SectionId }[] = [
  { id: "crm", title: "CRM", short: "CRM", icon: "list", home: "today" },
  { id: "search", title: "Поиск клиентов", short: "Поиск", icon: "search", home: "home" },
];

const CRM: SectionId[] = ["today", "calendar", "deals", "reports", "collection", "trash", "journal"];

/** Модуль раздела: по нему рейка подсвечивает кнопку, а панель разделов показывает свои группы. */
export function moduleOf(section: SectionId): ModuleId {
  if (CRM.includes(section)) return "crm";
  return "search";
}

/** Разделы, которые можно открыть при запуске (последний открытый). Коллекция требует выбора — не восстанавливается. */
export const RESTORABLE: SectionId[] = ["home", "all", "new", "favorites", "archive", "excluded", "runs", "today", "calendar", "deals", "reports", "trash", "journal"];
