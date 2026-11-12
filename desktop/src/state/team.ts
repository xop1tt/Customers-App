// Сотрудники и чат: справочник, опрос новых сообщений и уведомлений, переходы к обсуждению и профилю.

import { useEffect } from "react";
import { api } from "../api";
import { on } from "../api/backend";
import type { ChatConversation, ChatPoll, TeamMember } from "../api/types";
import { loadPrefs, shouldToast } from "../lib/notifyPrefs";
import { attempt, getState, openCollection, openRecord, setState, toast, useStore } from "./store";

export const POLL_EVERY = 15_000;
/** Пока открыт канал Realtime, новое приходит сразу; опрос остаётся для статуса «в сети» и как подстраховка. */
export const LIVE_POLL_EVERY = 60_000;
/** Справочник (статус «в сети») обновляется реже, чем чат. */
const TEAM_EVERY = 4;

export async function refreshTeam(): Promise<TeamMember[]> {
  try {
    const team = await api.wsTeam();
    setState({ team });
    return team;
  } catch {
    return getState().team;
  }
}

/** Всего непрочитанных сообщений. */
export const unreadTotal = (c: ChatPoll | null) => Object.values(c?.unread ?? {}).reduce((n, x) => n + x, 0);
export const unreadNotifications = (c: ChatPoll | null) => (c?.notifications ?? []).filter((n) => !n.read).length;

let polling = false;
let again = false;
export async function pollChat(): Promise<ChatPoll | null> {
  // Событие Realtime во время опроса не теряется: опрос повторится сразу после текущего.
  if (polling) { again = true; return getState().chat; }
  polling = true;
  try {
    const chat = await api.wsChatPoll();
    setState({ chat });
    announce(chat);
    return chat;
  } catch {
    return null;
  } finally {
    polling = false;
    if (again) { again = false; void pollChat(); }
  }
}

/** Окно в фокусе: новое показывается подсказкой (системное уведомление ядро показывает, только когда окно не в фокусе). */
function announce(chat: ChatPoll) {
  const st = getState();
  if (!st.account?.notifyMessages || typeof document === "undefined" || !document.hasFocus()) return;
  const viewing = st.section === "chat" ? st.chatOpen : null;
  const prefs = loadPrefs();
  for (const m of chat.fresh.filter((f) => f.conversation_id !== viewing && shouldToast("message", prefs)).slice(0, 2)) {
    const where = m.kind === "group" ? ` в «${m.title ?? "обсуждении"}»` : "";
    toast(`${m.author_name}${where}: ${m.body}`);
  }
  for (const n of chat.freshNotifications.filter((x) => x.kind !== "mention" && shouldToast("group", prefs)).slice(0, 2)) {
    toast(n.kind === "added_to_group" ? `${n.actor_name} добавляет вас в обсуждение «${n.excerpt}»` : `${n.actor_name} упоминает вас: ${n.excerpt}`);
  }
}

/** Опрос, пока открыт облачное рабочее пространство. Смена Workspace начинает заново. */
export function useChatPolling() {
  const cloud = useStore((s) => s.ws?.isCloud ?? false);
  const active = useStore((s) => s.ws?.active ?? null);
  useEffect(() => {
    setState({ chat: null, team: [] });
    void refreshTeam();
    if (!cloud || !active) return;
    let tick = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        void pollChat().finally(loop);
        if (++tick % TEAM_EVERY === 0) void refreshTeam();
      }, getState().chat?.live ? LIVE_POLL_EVERY : POLL_EVERY);
    };
    void pollChat().finally(loop);
    // Realtime: сервер сообщает только «что-то изменилось», содержимое забирается обычным запросом.
    let unlisten: (() => void) | undefined;
    void on<{ event: string }>("chat-live", (e) => {
      if (e.event === "offline") {
        const chat = getState().chat;
        if (chat?.live) setState({ chat: { ...chat, live: false } });
        return;
      }
      void pollChat();
    }).then((u) => { if (stopped) u(); else unlisten = u; });
    return () => { stopped = true; clearTimeout(timer); unlisten?.(); };
  }, [cloud, active]);
}

const CARD_TABLE: Record<string, string> = { company: "companies", contact: "contacts", crm_lead: "crm_leads", deal: "deals" };

/** Открыть карточку CRM (из уведомления или сообщения) через подходящую коллекцию. */
export function openCrmCard(type: string, id: string) {
  const all = getState().collections;
  const c = all.find((x) => x.entity_type === type && !x.config.filters?.length) ?? all.find((x) => x.entity_type === type);
  const table = CARD_TABLE[type];
  if (c && table) { openCollection(c.id); openRecord(table, id); return; }
  toast("Карточка недоступна: нет коллекции такого типа.", "error");
}

export function openChat(id: string | null) {
  setState({ section: "chat", chatOpen: id, collectionId: null, record: null, selection: [], anchor: null, navPeek: false });
}

/** «Написать сообщение»: личный диалог с сотрудником. */
export async function messageMember(userId: string) {
  const c = await attempt(() => api.wsChat<ChatConversation>("chat_open_direct", { user: userId }));
  if (c) openChat(c.id);
}

export const memberName = (team: TeamMember[], id: string | null | undefined) => team.find((m) => m.user_id === id)?.display_name ?? "Участник";

/** Название обсуждения: у личного — имя собеседника. */
export function conversationTitle(c: Pick<ChatConversation, "kind" | "title" | "participants">, team: TeamMember[], me: string | undefined): string {
  if (c.kind === "group") return c.title ?? "Обсуждение";
  const other = c.participants.find((p) => p.user_id !== me);
  return other ? memberName(team, other.user_id) : "Личные сообщения";
}

/** Запрос руководству (ADR-079): личное сообщение каждому адресату с упоминанием, чтобы пришло уведомление. */
export async function sendRequest(recipients: TeamMember[], body: string): Promise<boolean> {
  if (!recipients.length) { toast("Некому отправить: в рабочем пространстве нет владельца или заместителя, который может одобрить.", "error"); return false; }
  for (const m of recipients) {
    const c = await attempt(() => api.wsChat<ChatConversation>("chat_open_direct", { user: m.user_id }));
    if (!c) return false;
    if (!(await attempt(() => api.wsChat("chat_send", { conversation: c.id, body, mentions: [m.user_id] })))) return false;
  }
  toast(recipients.length > 1 ? "Запрос отправлен руководству" : `Запрос отправлен: ${recipients[0]!.display_name}`, "success");
  return true;
}
