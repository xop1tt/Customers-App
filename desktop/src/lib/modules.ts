// Модули рейки слева (пакет C2, вариант B из C1): CRM, поиск клиентов, команда.

import type { SectionId } from "./leads";

export type ModuleId = "crm" | "search" | "team";

export const MODULES: { id: ModuleId; title: string; short: string; icon: string; home: SectionId }[] = [
  { id: "crm", title: "CRM", short: "CRM", icon: "list", home: "today" },
  { id: "search", title: "Поиск клиентов", short: "Поиск", icon: "search", home: "home" },
  { id: "team", title: "Команда", short: "Команда", icon: "chat", home: "chat" },
];

const CRM: SectionId[] = ["today", "calendar", "deals", "reports", "collection"];
const TEAM: SectionId[] = ["chat", "people", "notifications", "profile"];

/** Модуль раздела: по нему рейка подсвечивает кнопку, а панель разделов показывает свои группы. */
export function moduleOf(section: SectionId): ModuleId {
  if (CRM.includes(section)) return "crm";
  if (TEAM.includes(section)) return "team";
  return "search";
}

/** Разделы, которые можно открыть при запуске (последний открытый). Коллекция и профиль требуют выбора — не восстанавливаются. */
export const RESTORABLE: SectionId[] = ["home", "all", "new", "favorites", "archive", "excluded", "sources", "runs", "today", "calendar", "deals", "reports", "chat", "people", "notifications"];
