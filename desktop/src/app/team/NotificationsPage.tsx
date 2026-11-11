// «Уведомления»: @упоминания в обсуждениях, заметках и комментариях и добавление в обсуждения.

import { api } from "../../api";
import type { AppNotification } from "../../api/types";
import { shortRelative } from "../../lib/format";
import { notificationText } from "../../lib/team";
import { Avatar, Button, EmptyState, Notice } from "../../ui/kit";
import { attempt, useStore } from "../../state/store";
import { openChat, openCrmCard, pollChat } from "../../state/team";

/** Перейти к источнику: обсуждение или карточка CRM. */
export function openNotification(n: AppNotification) {
  void attempt(() => api.wsChat("notifications_mark_read", { ids: [n.id] })).then(() => pollChat());
  if (n.conversation_id) return openChat(n.conversation_id);
  if (n.entity_type && n.entity_id) openCrmCard(n.entity_type, n.entity_id);
}

export function NotificationsPage() {
  const chat = useStore((s) => s.chat);
  const team = useStore((s) => s.team);
  const cloud = useStore((s) => s.ws?.workspaces.find((w) => w.id === s.ws?.active)?.remote ?? false);
  const list = chat?.notifications ?? [];
  const unread = list.filter((n) => !n.read).length;
  return (
    <div className="page scroll">
      <div className="profile">
        {!cloud ? (
          <EmptyState icon="bell" title="Уведомления работают в облачном рабочем пространстве">Здесь будут @упоминания и приглашения в обсуждения от коллег.</EmptyState>
        ) : chat?.missing ? (
          <Notice tone="warn">На сервере ещё нет таблиц чата. Владельцу проекта Supabase нужно применить миграцию 20261110170000_team_chat.sql.</Notice>
        ) : (
          <>
            <div className="row" style={{ gap: 8 }}>
              <span className="grow faint">{unread ? `Непрочитанных: ${unread}` : "Всё прочитано"} · хранятся 90 дней</span>
              <Button small icon="check" disabled={!unread} onClick={() => void attempt(() => api.wsChat("notifications_mark_read", { ids: null })).then(() => pollChat())}>Прочитать все</Button>
            </div>
            {list.length === 0 ? (
              <EmptyState icon="bell" title="Уведомлений нет">Когда вас упомянут через @имя или по адресу почты в обсуждении, заметке или комментарии, это появится здесь.</EmptyState>
            ) : (
              <ul className="notif-list" aria-label="Входящие">
                {list.map((n) => {
                  const actor = team.find((m) => m.user_id === n.actor_id);
                  return (
                    <li key={n.id}>
                      <button type="button" className={`notif${n.read ? "" : " unread"}`} onClick={() => openNotification(n)}>
                        <Avatar name={n.actor_name} src={actor?.avatar} size={30} />
                        <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                          <span className="ellipsis notif-title">{notificationText(n)}</span>
                          {n.excerpt && <span className="faint notif-excerpt">{n.excerpt}</span>}
                        </span>
                        <span className="faint chat-time">{shortRelative(n.created_at)}</span>
                        {!n.read && <span className="notif-dot" aria-label="Не прочитано" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
