// Уведомления у колокольчика: @упоминания в обсуждениях, заметках и комментариях, добавление в обсуждения.
// Окно всплывает рядом с колокольчиком; отдельного экрана «Входящие» нет.

import { api } from "../../api";
import type { AppNotification } from "../../api/types";
import { shortRelative } from "../../lib/format";
import { notificationText } from "../../lib/team";
import { Avatar, Button, EmptyState, Notice } from "../../ui/kit";
import { Popover } from "../../ui/overlay";
import { attempt, openSettings, setState, useStore } from "../../state/store";
import { openChat, openCrmCard, pollChat } from "../../state/team";

/** Перейти к источнику: обсуждение или карточка CRM. */
export function openNotification(n: AppNotification) {
  void attempt(() => api.wsChat("notifications_mark_read", { ids: [n.id] })).then(() => pollChat());
  setState({ bellOpen: false });
  if (n.conversation_id) return openChat(n.conversation_id);
  if (n.entity_type && n.entity_id) openCrmCard(n.entity_type, n.entity_id);
}

/** Всплывающее окно уведомлений, прикреплённое к кнопке-колокольчику. */
export function NotificationsPopover({ anchor, ignore }: { anchor: DOMRect; ignore?: HTMLElement | null }) {
  const chat = useStore((s) => s.chat);
  const team = useStore((s) => s.team);
  const cloud = useStore((s) => s.ws?.workspaces.find((w) => w.id === s.ws?.active)?.remote ?? false);
  const list = chat?.notifications ?? [];
  const unread = list.filter((n) => !n.read).length;
  return (
    <Popover anchor={anchor} onClose={() => setState({ bellOpen: false })} ignore={ignore} placement="top-start" minWidth={380} className="notif-pop" role="dialog">
      <div className="notif-pop-body" aria-label="Уведомления">
        {!cloud ? (
          <EmptyState icon="bell" title="Уведомления работают в облачном рабочем пространстве">Здесь будут @упоминания и приглашения в обсуждения от коллег.</EmptyState>
        ) : chat?.missing ? (
          <Notice tone="warn">На сервере ещё нет таблиц чата. Владельцу проекта Supabase нужно применить миграцию 20261110170000_team_chat.sql.</Notice>
        ) : (
          <>
            <div className="row notif-pop-head">
              <strong className="grow">Уведомления</strong>
              <span className="faint">{unread ? `Новых: ${unread}` : "Всё прочитано"}</span>
              <Button small variant="ghost" icon="settings" aria-label="Настроить уведомления" onClick={() => { setState({ bellOpen: false }); openSettings("notifications"); }} />
              <Button small icon="check" disabled={!unread} onClick={() => void attempt(() => api.wsChat("notifications_mark_read", { ids: null })).then(() => pollChat())}>Прочитать все</Button>
            </div>
            {list.length === 0 ? (
              <EmptyState icon="bell" title="Уведомлений нет">Когда вас упомянут через @имя или по адресу почты в обсуждении, заметке или комментарии, это появится здесь.</EmptyState>
            ) : (
              <ul className="notif-list" aria-label="Уведомления">
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
    </Popover>
  );
}
