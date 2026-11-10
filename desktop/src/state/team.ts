// Сотрудники и чат: справочник, опрос новых сообщений и уведомлений, переходы к обсуждению и профилю.

import { useEffect } from "react";
import { api } from "../api";
import type { ChatConversation, ChatPoll, TeamMember } from "../api/types";
import { attempt, getState, setState, toast, useStore } from "./store";

export const POLL_EVERY = 15_000;
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
export async function pollChat(): Promise<ChatPoll | null> {
  if (polling) return getState().chat;
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
  }
}

/** Окно в фокусе: новое показывается подсказкой (системное уведомление ядро показывает, только когда окно не в фокусе). */
function announce(chat: ChatPoll) {
  const st = getState();
  if (!st.account?.notifyMessages || typeof document === "undefined" || !document.hasFocus()) return;
  const viewing = st.section === "chat" ? st.chatOpen : null;
  for (const m of chat.fresh.filter((f) => f.conversation_id !== viewing).slice(0, 2)) {
    const where = m.kind === "group" ? ` в «${m.title ?? "обсуждении"}»` : "";
    toast(`${m.author_name}${where}: ${m.body}`);
  }
  for (const n of chat.freshNotifications.filter((x) => x.kind !== "mention").slice(0, 2)) {
    toast(n.kind === "added_to_group" ? `${n.actor_name} добавляет вас в обсуждение «${n.excerpt}»` : `${n.actor_name} упоминает вас: ${n.excerpt}`);
  }
}

/** Опрос, пока открыт облачный Workspace. Смена Workspace начинает заново. */
export function useChatPolling() {
  const cloud = useStore((s) => s.ws?.isCloud ?? false);
  const active = useStore((s) => s.ws?.active ?? null);
  useEffect(() => {
    setState({ chat: null, team: [] });
    void refreshTeam();
    if (!cloud || !active) return;
    let tick = 0;
    void pollChat();
    const t = setInterval(() => {
      void pollChat();
      if (++tick % TEAM_EVERY === 0) void refreshTeam();
    }, POLL_EVERY);
    return () => clearInterval(t);
  }, [cloud, active]);
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
