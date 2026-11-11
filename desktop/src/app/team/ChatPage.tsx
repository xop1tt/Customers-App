// «Сообщения»: личные диалоги и групповые обсуждения Workspace. Слева — список, справа — лента и поле ввода
// с подсказкой @упоминаний и карточками CRM. Новое приходит сразу через Realtime, а без него — опросом (state/team.ts).

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import type { ChatAttachment, ChatCardRef, ChatCardType, ChatConversation, ChatMessage, ChatPage as ChatPageData, CrmRecord, TeamMember } from "../../api/types";
import { ENTITIES } from "../../lib/crm";
import { dateOnly, shortRelative } from "../../lib/format";
import { insertMention, mentionMatches, mentionQuery, mentionedIds } from "../../lib/team";
import { Avatar, Button, Checkbox, EmptyState, Field, IconButton, Notice, Segmented, Spinner, Switch, Tag, TextInput } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { Dialog, type MenuItem, confirmDialog, showMenu } from "../../ui/overlay";
import { attempt, openProfile, useStore } from "../../state/store";
import { conversationTitle, memberName, messageMember, openChat, openCrmCard, pollChat, refreshTeam } from "../../state/team";
import { PersonAvatar } from "./PeoplePage";

const PAGE = 50;

export function ChatPage() {
  const ws = useStore((s) => s.ws);
  const team = useStore((s) => s.team);
  const chat = useStore((s) => s.chat);
  const open = useStore((s) => s.chatOpen);
  const [list, setList] = useState<ChatConversation[] | null>(null);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<"group" | "direct" | null>(null);
  const cloud = ws?.workspaces.find((w) => w.id === ws.active)?.remote ?? false;
  const perms = ws?.permissions ?? [];
  const me = ws?.me;

  const reload = async () => { const l = await attempt(() => api.wsChat<ChatConversation[]>("chat_list")); if (l) setList(l); };
  useEffect(() => { void refreshTeam(); }, [ws?.active]);
  // Список перечитывается при каждом новом курсоре опроса (новые сообщения, обсуждения).
  useEffect(() => { void reload(); }, [ws?.active, chat?.cursor]);

  if (!cloud) {
    return (
      <div className="page center-fill">
        <EmptyState icon="chat" title="Сообщения работают в облачном рабочем пространстве">
          Войдите в облачную учётную запись, создайте общее рабочее пространство и пригласите коллег в «Рабочем пространстве» — тогда здесь появятся личные сообщения и обсуждения.
        </EmptyState>
      </div>
    );
  }
  if (chat?.missing) {
    return <div className="page scroll"><div className="profile"><Notice tone="warn">На сервере ещё нет таблиц чата. Владельцу проекта Supabase нужно применить миграцию 20261110170000_team_chat.sql.</Notice></div></div>;
  }
  const q = filter.trim().toLowerCase();
  const shown = (list ?? []).filter((c) => !q || conversationTitle(c, team, me).toLowerCase().includes(q));
  const current = (list ?? []).find((c) => c.id === open) ?? null;

  return (
    <div className="page chat">
      <aside className="chat-list" aria-label="Обсуждения">
        <div className="chat-list-bar">
          <TextInput value={filter} onChange={setFilter} icon="search" placeholder="Поиск" aria-label="Поиск обсуждений" wrapClass="grow" />
          <IconButton icon="plus" tip="Новое сообщение или обсуждение" onClick={(e) => showMenu([
            { label: "Личное сообщение", icon: "user", onSelect: () => setCreating("direct") },
            { label: "Групповое обсуждение", icon: "users", disabled: !perms.includes("records.create"), onSelect: () => setCreating("group") },
          ], e.currentTarget.getBoundingClientRect(), "bottom-end")} />
        </div>
        {list === null ? <div className="center-fill"><Spinner /></div> : shown.length === 0 ? (
          <div className="chat-empty faint">{q ? "Ничего не нашлось." : "Пока нет сообщений. Напишите коллеге из «Сотрудников» или создайте обсуждение."}</div>
        ) : (
          <ul className="chat-items">
            {shown.map((c) => <ConversationRow key={c.id} c={c} active={c.id === open} team={team} me={me} />)}
          </ul>
        )}
      </aside>
      <section className="chat-main">
        {current ? <Conversation key={current.id} c={current} onChanged={reload} /> : (
          <div className="center-fill"><EmptyState icon="chat" title="Выберите обсуждение">Или начните новое кнопкой «+».</EmptyState></div>
        )}
      </section>
      {creating === "group" && <NewGroupDialog team={team} me={me} onClose={() => setCreating(null)} onCreated={(id) => { setCreating(null); void reload(); openChat(id); }} />}
      {creating === "direct" && <PickPersonDialog title="Личное сообщение" team={team.filter((m) => m.user_id !== me)} onClose={() => setCreating(null)} onPick={(id) => { setCreating(null); void messageMember(id).then(reload); }} />}
    </div>
  );
}

function ConversationRow({ c, active, team, me }: { c: ChatConversation; active: boolean; team: TeamMember[]; me: string | undefined }) {
  const unread = useStore((s) => s.chat?.unread[c.id] ?? c.unread);
  const other = c.kind === "direct" ? team.find((m) => m.user_id === c.participants.find((p) => p.user_id !== me)?.user_id) : undefined;
  const title = conversationTitle(c, team, me);
  const last = c.last;
  const preview = !last ? "Нет сообщений" : last.deleted ? "Сообщение удалено" : last.kind === "system" ? last.body : `${last.author_id === me ? "Вы" : memberName(team, last.author_id).split(" ")[0]}: ${last.body || "📎 Карточка CRM"}`;
  return (
    <li>
      <button type="button" className={`chat-item${active ? " active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => openChat(c.id)}>
        {other ? <PersonAvatar m={other} size={34} /> : <span className="chat-group-ico"><Icon name={c.kind === "group" ? "users" : "user"} size={16} /></span>}
        <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <span className="row" style={{ gap: 6 }}>
            <span className={`ellipsis grow chat-item-title${unread ? " strong" : ""}`}>{title}</span>
            {c.muted && <Icon name="bellOff" size={12} className="faint" />}
            <span className="faint chat-time">{shortRelative(c.last_message_at)}</span>
          </span>
          <span className="row" style={{ gap: 6 }}>
            <span className="ellipsis grow faint chat-preview">{preview}</span>
            {unread > 0 && <span className="nav-count accent num" aria-label={`Непрочитанных: ${unread}`}>{unread}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

function Conversation({ c, onChanged }: { c: ChatConversation; onChanged: () => Promise<void> }) {
  const team = useStore((s) => s.team);
  const ws = useStore((s) => s.ws)!;
  const cursor = useStore((s) => s.chat?.cursor ?? 0);
  const me = ws.me;
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [view, setView] = useState<ChatConversation>(c);
  const [more, setMore] = useState(false);
  const [members, setMembers] = useState(false);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const apply = (page: ChatPageData, mode: "replace" | "append" | "prepend") => {
    setView(page.conversation);
    setMessages((cur) => {
      if (mode === "replace" || !cur) return page.messages;
      const known = new Map(cur.map((m) => [m.id, m]));
      for (const m of page.messages) known.set(m.id, m);
      return [...known.values()].sort((a, b) => a.seq - b.seq);
    });
  };

  useEffect(() => {
    let live = true;
    void attempt(() => api.wsChat<ChatPageData>("chat_messages", { conversation: c.id, limit: PAGE })).then((p) => {
      if (!live || !p) return;
      apply(p, "replace");
      setMore(p.messages.length >= PAGE);
      void pollChat();
    });
    return () => { live = false; };
  }, [c.id]);

  // Новые сообщения по опросу: дочитываем после последнего известного.
  useEffect(() => {
    if (!messages) return;
    const last = messages[messages.length - 1]?.seq ?? 0;
    void api.wsChat<ChatPageData>("chat_messages", { conversation: c.id, after: last, limit: 200 }).then((p) => { if (p.messages.length) apply(p, "append"); else setView(p.conversation); }, () => {});
  }, [cursor]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);

  const older = async () => {
    const first = messages?.[0]?.seq;
    if (!first) return;
    const el = scroller.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    stick.current = false;
    const p = await attempt(() => api.wsChat<ChatPageData>("chat_messages", { conversation: c.id, before: first, limit: PAGE, mark_read: false }));
    if (!p) return;
    apply(p, "prepend");
    setMore(p.messages.length >= PAGE);
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - before; });
  };

  const send = async (body: string, mentions: string[], cards: ChatCardRef[]) => {
    stick.current = true;
    if (editing) {
      const m = await attempt(() => api.wsChat<ChatMessage>("chat_edit", { message: editing.id, body }));
      if (m) { setMessages((cur) => cur?.map((x) => (x.id === m.id ? m : x)) ?? cur); setEditing(null); }
      return !!m;
    }
    // Без карточек — прежняя chat_send: так текстовый чат работает и на сервере без новой миграции.
    const m = await attempt(() => cards.length
      ? api.wsChat<ChatMessage>("chat_post", { conversation: c.id, body, mentions, attachments: cards.map(({ type, id }) => ({ type, id })) })
      : api.wsChat<ChatMessage>("chat_send", { conversation: c.id, body, mentions }));
    if (m) { setMessages((cur) => [...(cur ?? []), m]); void onChanged(); }
    return !!m;
  };

  const participants = view.participants.map((p) => p.user_id);
  const people = team.filter((m) => participants.includes(m.user_id));
  const title = conversationTitle(view, team, me);
  const other = view.kind === "direct" ? team.find((m) => m.user_id === participants.find((p) => p !== me)) : undefined;
  const isAdmin = view.my_role !== "member" || ws.permissions.includes("members.manage");

  const menu = (): MenuItem[] => [
    ...(view.kind === "group" ? [{ label: "Участники и настройки", icon: "users", onSelect: () => setMembers(true) }] : []),
    ...(other ? [{ label: "Профиль собеседника", icon: "user", onSelect: () => openProfile(other.user_id) }] : []),
    { label: view.muted ? "Включить уведомления" : "Без уведомлений", icon: view.muted ? "bell" : "bellOff",
      onSelect: () => void attempt(() => api.wsChat<ChatConversation>("chat_set_muted", { conversation: c.id, muted: !view.muted })).then((v) => { if (v) { setView(v); void onChanged(); } }) },
    ...(view.kind === "group" ? [{ separator: true } as MenuItem, { label: "Выйти из обсуждения", icon: "logout", danger: true, onSelect: () => void leave() }] : []),
  ];

  const leave = async () => {
    if (!(await confirmDialog({ title: `Выйти из «${title}»?`, message: "Вы перестанете получать сообщения. Вернуть вас сможет участник обсуждения.", confirm: "Выйти", danger: true }))) return;
    if (await attempt(() => api.wsChat("chat_remove_member", { conversation: c.id, user: me }))) { openChat(null); void onChanged(); }
  };

  const messageMenu = (m: ChatMessage): MenuItem[] => [
    { label: "Изменить", icon: "edit", disabled: m.author_id !== me, onSelect: () => setEditing(m) },
    { label: "Удалить", icon: "trash", danger: true, disabled: m.author_id !== me && !isAdmin,
      onSelect: async () => {
        if (!(await confirmDialog({ title: "Удалить сообщение?", message: "Текст сотрётся у всех участников.", confirm: "Удалить", danger: true }))) return;
        if ((await attempt(() => api.wsChat("chat_delete", { message: m.id }))) !== undefined) setMessages((cur) => cur?.map((x) => (x.id === m.id ? { ...x, deleted: true, body: "", attachments: [] } : x)) ?? cur);
      } },
  ];

  return (
    <>
      <header className="chat-head">
        {other ? <button type="button" className="chat-head-who" onClick={() => openProfile(other.user_id)}><PersonAvatar m={other} size={30} /></button> : <span className="chat-group-ico"><Icon name="users" size={16} /></span>}
        <div className="col grow" style={{ gap: 0, minWidth: 0 }}>
          <h2 className="ellipsis">{title}</h2>
          <span className="faint ellipsis" style={{ fontSize: "var(--fs-sm)" }}>
            {view.kind === "group" ? `Участников: ${view.participants.length}` : other ? (other.online ? "В сети" : [other.title, other.department].filter(Boolean).join(" · ") || "Личные сообщения") : ""}
          </span>
        </div>
        {view.kind === "group" && <Button small icon="users" onClick={() => setMembers(true)}>Участники</Button>}
        <IconButton icon="more" tip="Ещё" onClick={(e) => showMenu(menu(), e.currentTarget.getBoundingClientRect(), "bottom-end")} />
      </header>
      <div className="chat-feed" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
        {messages === null ? <div className="center-fill"><Spinner /></div> : (
          <>
            {more && <div className="chat-more"><Button small onClick={() => void older()}>Показать ранние</Button></div>}
            {messages.length === 0 && <div className="chat-empty faint">Напишите первое сообщение.</div>}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const day = !prev || dateOnly(prev.created_at) !== dateOnly(m.created_at);
              const grouped = !day && prev && prev.kind === "text" && m.kind === "text" && prev.author_id === m.author_id && Date.parse(m.created_at) - Date.parse(prev.created_at) < 5 * 60_000;
              return (
                <div key={m.id}>
                  {day && <div className="chat-day"><span>{dateOnly(m.created_at)}</span></div>}
                  {m.kind === "system" ? <div className="chat-system">{m.body}</div> : (
                    <MessageRow m={m} me={me} team={team} grouped={!!grouped} onMenu={(e) => showMenu(messageMenu(m), { x: e.clientX, y: e.clientY })} />
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
      <Composer people={people.filter((p) => p.user_id !== me)} team={team} editing={editing} onCancelEdit={() => setEditing(null)} onSend={send}
        disabled={view.kind === "direct" && view.participants.some((p) => !p.active) ? "Собеседник больше не участник рабочего пространства." : null} />
      {members && <MembersDialog view={view} team={team} me={me} perms={ws.permissions} onClose={() => setMembers(false)} onChanged={(v) => { if (v) setView(v); void onChanged(); }} />}
    </>
  );
}

/** Текст сообщения с подсветкой упоминаний «@Имя» и адресов почты сотрудников. */
export function MessageText({ text, team }: { text: string; team: TeamMember[] }) {
  const tokens = useMemo(() => {
    const names = team.flatMap((m) => [`@${m.display_name}`, ...(m.email ? [m.email] : [])]).filter((x) => x.length > 2).sort((a, b) => b.length - a.length);
    if (!names.length) return [text];
    const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return text.split(new RegExp(`(${esc.join("|")})`, "gi"));
  }, [text, team]);
  return <>{tokens.map((t, i) => (i % 2 === 1 ? <span key={i} className="mention">{t}</span> : <span key={i}>{t}</span>))}</>;
}

function MessageRow({ m, me, team, grouped, onMenu }: { m: ChatMessage; me: string; team: TeamMember[]; grouped: boolean; onMenu: (e: React.MouseEvent) => void }) {
  const author = team.find((x) => x.user_id === m.author_id);
  const name = m.author_id === me ? "Вы" : author?.display_name ?? "Участник";
  const mine = m.author_id === me;
  return (
    <div className={`chat-msg${grouped ? " grouped" : ""}${mine ? " mine" : ""}${m.mentions.includes(me) ? " mentioned" : ""}`} onContextMenu={(e) => { if (!m.deleted) { e.preventDefault(); onMenu(e); } }}>
      <span className="chat-msg-ava">{!grouped && <button type="button" className="chat-ava-btn" aria-label={`Профиль: ${name}`} onClick={() => m.author_id && openProfile(m.author_id === me ? null : m.author_id)}><Avatar name={author?.display_name ?? name} src={author?.avatar} size={30} /></button>}</span>
      <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
        {!grouped && <div className="row" style={{ gap: 8 }}><span className="chat-author">{name}</span><span className="faint chat-time">{shortRelative(m.created_at)}</span></div>}
        <div className={`chat-body selectable${m.deleted ? " faint" : ""}`}>
          {m.deleted ? "Сообщение удалено" : m.body ? <MessageText text={m.body} team={team} /> : null}
          {m.edited_at && !m.deleted && <span className="faint chat-edited"> (изменено)</span>}
        </div>
        {!m.deleted && !!m.attachments?.length && <div className="chat-cards">{m.attachments.map((a) => <CardChip key={`${a.type}:${a.id}`} card={a} />)}</div>}
      </div>
      {!m.deleted && <IconButton icon="more" tip="Действия" className="chat-msg-act" onClick={(e) => onMenu(e)} />}
    </div>
  );
}

function Composer({ people, team, editing, onCancelEdit, onSend, disabled }: {
  people: TeamMember[]; team: TeamMember[]; editing: ChatMessage | null; onCancelEdit: () => void; onSend: (body: string, mentions: string[], cards: ChatAttachment[]) => Promise<boolean>; disabled: string | null;
}) {
  const [text, setText] = useState("");
  const [cards, setCards] = useState<ChatAttachment[]>([]);
  const [picking, setPicking] = useState(false);
  const canAttach = useStore((s) => s.ws?.permissions.includes("records.view") ?? false);
  const [picked, setPicked] = useState<string[]>([]);
  const [suggest, setSuggest] = useState<{ start: number; query: string } | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) { setText(editing.body); area.current?.focus(); } }, [editing]);
  const matches = suggest ? mentionMatches(people, suggest.query) : [];

  const update = (v: string) => {
    setText(v);
    const caret = area.current?.selectionStart ?? v.length;
    setSuggest(mentionQuery(v, caret));
    setIndex(0);
  };
  const choose = (m: TeamMember) => {
    if (!suggest) return;
    const caret = area.current?.selectionStart ?? text.length;
    const r = insertMention(text, suggest.start, caret, m.display_name);
    setText(r.text);
    setPicked((p) => [...new Set([...p, m.user_id])]);
    setSuggest(null);
    requestAnimationFrame(() => { area.current?.focus(); area.current?.setSelectionRange(r.caret, r.caret); });
  };
  const submit = async () => {
    const body = text.trim();
    const withCards = editing ? [] : cards;
    if ((!body && !withCards.length && !(editing?.attachments?.length)) || busy) return;
    setBusy(true);
    const mentions = [...new Set([...picked.filter((id) => text.includes(`@${team.find((m) => m.user_id === id)?.display_name ?? "\u0000"}`)), ...mentionedIds(body, people)])];
    const ok = await onSend(body, mentions, withCards);
    setBusy(false);
    if (ok) { setText(""); setPicked([]); setSuggest(null); setCards([]); }
  };

  if (disabled) return <div className="chat-compose"><Notice>{disabled}</Notice></div>;
  return (
    <div className="chat-compose">
      {editing && <div className="row chat-editing"><Icon name="edit" size={13} /><span className="grow">Изменение сообщения</span><Button small variant="ghost" onClick={() => { onCancelEdit(); setText(""); }}>Отмена</Button></div>}
      {!editing && cards.length > 0 && (
        <div className="chat-cards compose" aria-label="Карточки в сообщении">
          {cards.map((c) => <CardChip key={`${c.type}:${c.id}`} card={c} onRemove={() => setCards((cur) => cur.filter((x) => x !== c))} />)}
        </div>
      )}
      {suggest && matches.length > 0 && (
        <ul className="mention-list" role="listbox" aria-label="Упомянуть">
          {matches.map((m, i) => (
            <li key={m.user_id}>
              <button type="button" role="option" aria-selected={i === index} className={`mention-opt${i === index ? " on" : ""}`} onMouseDown={(e) => { e.preventDefault(); choose(m); }}>
                <Avatar name={m.display_name} src={m.avatar} size={20} /><span className="ellipsis grow">{m.display_name}</span><span className="faint ellipsis">{m.title || m.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row chat-compose-row">
        <textarea
          ref={area}
          className="textarea chat-input"
          value={text}
          rows={1}
          maxLength={4000}
          placeholder="Сообщение. @ — упомянуть коллегу, Shift+Enter — новая строка"
          aria-label="Сообщение"
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            if (suggest && matches.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => (i + 1) % matches.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => (i - 1 + matches.length) % matches.length); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(matches[index]!); return; }
              if (e.key === "Escape") { e.preventDefault(); setSuggest(null); return; }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
            if (e.key === "Escape" && editing) { onCancelEdit(); setText(""); }
          }}
        />
        <IconButton icon="at" tip="Упомянуть" onClick={() => { const caret = area.current?.selectionStart ?? text.length; const pre = caret > 0 && !/\s/.test(text[caret - 1]!) ? " @" : "@"; update(text.slice(0, caret) + pre + text.slice(caret)); area.current?.focus(); }} />
        {!editing && canAttach && <IconButton icon="paperclip" tip="Прикрепить карточку CRM" disabled={cards.length >= 10} onClick={() => setPicking(true)} />}
        <Button variant="primary" icon="send" busy={busy} disabled={!text.trim() && !(editing ? editing.attachments?.length : cards.length)} onClick={() => void submit()}>{editing ? "Сохранить" : "Отправить"}</Button>
      </div>
      {picking && <AttachCardDialog taken={cards} onClose={() => setPicking(false)} onPick={(c) => { setCards((cur) => (cur.some((x) => x.type === c.type && x.id === c.id) ? cur : [...cur, c].slice(0, 10))); setPicking(false); requestAnimationFrame(() => area.current?.focus()); }} />}
    </div>
  );
}

const CARD_TYPES: ChatCardType[] = ["crm_lead", "company", "contact", "deal"];

/** Карточка CRM в сообщении: открывается по нажатию; без права просмотра — «Нет доступа». */
function CardChip({ card, onRemove }: { card: ChatAttachment; onRemove?: () => void }) {
  const meta = ENTITIES[card.type];
  const body = (
    <>
      <span className="chat-card-emoji" aria-hidden><Icon name={meta.icon} size={16} /></span>
      <span className="col grow" style={{ gap: 0, minWidth: 0 }}>
        <span className="ellipsis chat-card-title">{card.available ? card.title || "Без названия" : "Нет доступа к карточке"}</span>
        <span className="ellipsis faint chat-card-sub">{[meta.one, card.available ? card.subtitle : ""].filter(Boolean).join(" · ")}</span>
      </span>
    </>
  );
  if (onRemove) {
    return <span className="chat-card">{body}<IconButton icon="x" tip="Убрать" onClick={onRemove} /></span>;
  }
  return (
    <button type="button" className="chat-card" disabled={!card.available} onClick={() => openCrmCard(card.type, card.id)}>
      {body}
      {card.available && <Icon name="chevronRight" size={14} className="faint" />}
    </button>
  );
}

function cardSubtitle(type: ChatCardType, r: CrmRecord): string {
  const v = (k: string) => (typeof (r as Record<string, unknown>)[k] === "string" ? String((r as Record<string, unknown>)[k]) : "");
  if (type === "company") return v("legal_name");
  if (type === "contact") return v("position");
  if (type === "crm_lead") return [v("person_name"), v("company_name")].filter(Boolean).join(" · ");
  const amount = (r as Record<string, unknown>).amount;
  return amount != null ? `${amount} ${v("currency") || "RUB"}` : "";
}

/** Выбор карточки из CRM этого рабочего пространства: лиды, компании, контакты, сделки. */
function AttachCardDialog({ taken, onClose, onPick }: { taken: ChatAttachment[]; onClose: () => void; onPick: (c: ChatAttachment) => void }) {
  const [type, setType] = useState<ChatCardType>("crm_lead");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<CrmRecord[] | null>(null);
  const meta = ENTITIES[type];
  useEffect(() => {
    let live = true;
    setItems(null);
    const t = setTimeout(() => {
      void api.wsList(meta.table, { search: q.trim() || null, limit: 30 }).then((r) => { if (live) setItems(r.items); }, () => { if (live) setItems([]); });
    }, q ? 200 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [type, q]);
  return (
    <Dialog title="Прикрепить карточку" onClose={onClose} width={520}>
      <div className="col" style={{ gap: 10, alignItems: "stretch" }}>
        <Segmented small value={type} onChange={(v) => setType(v)} options={CARD_TYPES.map((t) => ({ value: t, label: ENTITIES[t].many }))} />
        <TextInput value={q} onChange={setQ} icon="search" placeholder={`Поиск: ${ENTITIES[type].many.toLowerCase()}`} aria-label="Поиск карточки" autoFocus />
        {items === null ? <div className="center-fill" style={{ minHeight: 120 }}><Spinner /></div> : items.length === 0 ? (
          <div className="faint" style={{ padding: "16px 4px" }}>Ничего не нашлось.</div>
        ) : (
          <ul className="pick-list" aria-label="Карточки">
            {items.map((r) => {
              const used = taken.some((x) => x.type === type && x.id === r.id);
              const sub = cardSubtitle(type, r);
              return (
                <li key={r.id}>
                  <button type="button" className="pick-row" disabled={used} onClick={() => onPick({ type, id: r.id, title: meta.title(r), subtitle: sub, available: true })}>
                    <span aria-hidden><Icon name={meta.icon} size={16} /></span>
                    <span className="col grow" style={{ gap: 0, minWidth: 0 }}>
                      <span className="ellipsis">{meta.title(r)}</span>
                      {sub && <span className="ellipsis faint" style={{ fontSize: "var(--fs-sm)" }}>{sub}</span>}
                    </span>
                    {used && <Icon name="check" size={14} className="faint" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function PickPersonDialog({ title, team, onClose, onPick }: { title: string; team: TeamMember[]; onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const shown = team.filter((m) => !q.trim() || `${m.display_name} ${m.email ?? ""} ${m.title}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Dialog title={title} onClose={onClose} width={420}>
      <div className="col" style={{ gap: 10, alignItems: "stretch" }}>
        <TextInput value={q} onChange={setQ} icon="search" placeholder="Имя или почта" autoFocus aria-label="Поиск сотрудника" />
        <ul className="pick-list">
          {shown.map((m) => (
            <li key={m.user_id}><button type="button" className="pick-row" onClick={() => onPick(m.user_id)}>
              <PersonAvatar m={m} size={28} /><span className="col grow" style={{ gap: 0, minWidth: 0 }}><span className="ellipsis">{m.display_name}</span><span className="faint ellipsis" style={{ fontSize: "var(--fs-sm)" }}>{m.title || m.email}</span></span>
            </button></li>
          ))}
          {!shown.length && <li className="faint chat-empty">Никого не нашлось.</li>}
        </ul>
      </div>
    </Dialog>
  );
}

function NewGroupDialog({ team, me, onClose, onCreated }: { team: TeamMember[]; me: string | undefined; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const others = team.filter((m) => m.user_id !== me);
  const create = async () => {
    setBusy(true);
    const c = await attempt(() => api.wsChat<ChatConversation>("chat_create_group", { title: title.trim(), members: chosen }));
    setBusy(false);
    if (c) onCreated(c.id);
  };
  return (
    <Dialog title="Новое обсуждение" onClose={onClose} width={460} footer={
      <>
        <span className="grow faint">Выбрано: {chosen.length}</span>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" busy={busy} disabled={!title.trim()} onClick={() => void create()}>Создать</Button>
      </>
    }>
      <div className="col" style={{ gap: 12, alignItems: "stretch" }}>
        <Field label="Название"><TextInput value={title} onChange={setTitle} maxLength={120} placeholder="Например, Сделка «Северный ветер»" autoFocus /></Field>
        <Field label="Участники" hint="Позже участники смогут добавлять коллег сами (это можно выключить в настройках обсуждения).">
          <ul className="pick-list">
            {others.map((m) => (
              <li key={m.user_id} className="pick-row">
                <Checkbox checked={chosen.includes(m.user_id)} onChange={(v) => setChosen((c) => (v ? [...c, m.user_id] : c.filter((x) => x !== m.user_id)))} label={m.display_name} />
                <span className="faint ellipsis grow" style={{ textAlign: "right" }}>{m.title || m.role_name}</span>
              </li>
            ))}
          </ul>
        </Field>
      </div>
    </Dialog>
  );
}

function MembersDialog({ view, team, me, perms, onClose, onChanged }: { view: ChatConversation; team: TeamMember[]; me: string; perms: string[]; onClose: () => void; onChanged: (v: ChatConversation | null) => void }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState(view.title ?? "");
  const manage = perms.includes("members.manage");
  const admin = view.my_role !== "member" || manage;
  const canAdd = admin || view.members_can_add;
  const run = async (p: Promise<unknown>) => { const r = await attempt(() => p); if (r !== undefined) onChanged((r as ChatConversation) ?? null); return r; };
  const inside = new Set(view.participants.map((p) => p.user_id));
  const roleText = { owner: "Владелец", admin: "Администратор", member: "Участник" } as const;
  return (
    <Dialog title="Участники и настройки" onClose={onClose} width={520}>
      <div className="col" style={{ gap: 14, alignItems: "stretch" }}>
        {admin && (
          <Field label="Название">
            <div className="row" style={{ gap: 6 }}>
              <TextInput value={title} onChange={setTitle} maxLength={120} wrapClass="grow" aria-label="Название обсуждения" />
              <Button small disabled={!title.trim() || title.trim() === view.title} onClick={() => void run(api.wsChat("chat_update", { conversation: view.id, title: title.trim() }))}>Сохранить</Button>
            </div>
          </Field>
        )}
        {admin && (
          <label className="row" style={{ gap: 10 }}>
            <span className="grow">Участники могут добавлять коллег</span>
            <Switch checked={view.members_can_add} onChange={(v) => void run(api.wsChat("chat_update", { conversation: view.id, members_can_add: v }))} />
          </label>
        )}
        <ul className="pick-list" aria-label="Участники обсуждения">
          {view.participants.map((p) => {
            const m = team.find((x) => x.user_id === p.user_id);
            const name = p.user_id === me ? "Вы" : m?.display_name ?? "Бывший участник";
            const canRemove = p.user_id !== me && (view.my_role === "owner" || (view.my_role === "admin" && p.role === "member") || (manage && p.role !== "owner"));
            const canRole = p.role !== "owner" && (view.my_role === "owner" || manage);
            return (
              <li key={p.user_id} className="pick-row">
                {m ? <PersonAvatar m={m} size={26} /> : <Avatar name={name} size={26} />}
                <span className="ellipsis grow">{name}{!p.active && <span className="faint"> · не в рабочем пространстве</span>}</span>
                <Tag tone={p.role === "member" ? "gray" : "blue"}>{roleText[p.role]}</Tag>
                {canRole && <IconButton icon="shield" tip={p.role === "admin" ? "Сделать участником" : "Сделать администратором"} onClick={() => void run(api.wsChat("chat_set_role", { conversation: view.id, user: p.user_id, role: p.role === "admin" ? "member" : "admin" }))} />}
                {canRemove && <IconButton icon="x" tip="Удалить из обсуждения" onClick={async () => {
                  if (await confirmDialog({ title: `Удалить ${name} из обсуждения?`, message: "Участник перестанет видеть сообщения.", confirm: "Удалить", danger: true }))
                    await run(api.wsChat("chat_remove_member", { conversation: view.id, user: p.user_id }).then(() => api.wsChat<ChatPageData>("chat_messages", { conversation: view.id, limit: 1, mark_read: false })).then((x) => x.conversation));
                }} />}
              </li>
            );
          })}
        </ul>
        {canAdd ? <div><Button icon="plus" onClick={() => setAdding(true)}>Добавить участников</Button></div> : <span className="faint">Добавлять участников может владелец или администратор обсуждения.</span>}
      </div>
      {adding && <PickPersonDialog title="Добавить в обсуждение" team={team.filter((m) => !inside.has(m.user_id))} onClose={() => setAdding(false)}
        onPick={(id) => { setAdding(false); void run(api.wsChat<ChatConversation>("chat_add_members", { conversation: view.id, users: [id] })); }} />}
    </Dialog>
  );
}
