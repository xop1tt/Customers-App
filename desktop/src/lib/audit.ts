// Журнал действий Workspace: понятные подписи действий и записей. Данные пишет база (triggers), здесь только показ.

import type { WsAuditItem, WsMember } from "../api/types";
import { memberName } from "./crm";

const ACTIONS: Record<string, string> = {
  delete: "удалил(а) запись",
  restore: "восстановил(а) запись",
  owner_change: "сменил(а) ответственного",
  member_join: "вошёл(а) в рабочее пространство",
  member_removed: "удалён(а) из рабочего пространства",
  member_left: "вышел(а) из рабочего пространства",
  member_role: "изменена роль",
  "chat.message_deleted": "удалено сообщение в чате",
  "chat.member_removed": "убран участник из обсуждения",
  "market.installed": "установлена интеграция",
  "market.uninstalled": "удалена интеграция",
};

/** Действия, по которым можно отобрать журнал. */
export const AUDIT_ACTIONS = Object.keys(ACTIONS);

export const actionText = (a: string) => ACTIONS[a] ?? a;

const ENTITY: Record<string, string> = {
  companies: "компания", contacts: "контакт", crm_leads: "заявка", deals: "сделка", tasks: "задача", notes: "заметка", comments: "комментарий", activities: "событие",
  collections: "коллекция", member: "участник", chat_message: "сообщение", chat_conversation: "обсуждение", market_app: "интеграция",
};

export const entityText = (t: string | null) => (t ? ENTITY[t] ?? t : "");

/** Подробности: «Иванов → Петров» для смены ответственного, роль для ролей. */
export function detailText(i: WsAuditItem, members: WsMember[]): string {
  const d = i.details ?? {};
  if (i.action === "owner_change") {
    const a = typeof d.from === "string" ? memberName(members, d.from) : "никого";
    const b = typeof d.to === "string" ? memberName(members, d.to) : "никого";
    return `${a} → ${b}`;
  }
  if (i.action.startsWith("member_") && i.entity_id) {
    const who = memberName(members, i.entity_id);
    return typeof d.role === "string" ? `${who}, роль: ${d.role}` : who;
  }
  return "";
}
