// Демо-реализация справочника сотрудников, чата и уведомлений (ws_team, ws_update_member, ws_chat, ws_chat_poll).
// Повторяет правила сервера (миграция 20261110170000_team_chat.sql), которые видны в интерфейсе: права на группы,
// упоминания по имени и почте, непрочитанное, курсор опроса. Без `?team` — локальный Workspace: только вы, чата нет.

import type { AppNotification, ChatConversation, ChatMessage, TeamMember, WsMember, ChatAttachment } from "./types";

export interface TeamCtx { team: boolean; me: string; myName: string; myAvatar: string | null; wsId: string; members: WsMember[]; perms: string[] }

interface Profile { title: string; department: string; manager_id: string | null; hired_on: string | null }
interface Conv { id: string; ws: string; kind: "direct" | "group"; title: string | null; members_can_add: boolean; created_by: string; created_at: string; last_message_at: string; parts: Map<string, { role: "owner" | "admin" | "member"; last_read: number; muted: boolean }> }
interface Msg extends ChatMessage { conversation_id: string }

let seq = 100;
let idn = 1;
const nid = () => `c0000000-0000-4000-8000-${String(idn++).padStart(12, "0")}`;
const iso = (minAgo = 0) => new Date(Date.now() - minAgo * 60_000).toISOString();
const fail = (message: string, code = ""): never => { throw { code, message }; };

const profiles = new Map<string, Profile>();
const convs: Conv[] = [];
const msgs: Msg[] = [];
const notes: (AppNotification & { user: string; ws: string })[] = [];
let seeded = "";

const B = "00000000-0000-4000-8000-000000000002";
const V = "00000000-0000-4000-8000-000000000003";
const G = "00000000-0000-4000-8000-000000000004";

/** Сбросить демо-данные (тесты). */
export function resetChatMock() {
  profiles.clear(); convs.length = 0; msgs.length = 0; notes.length = 0; seeded = ""; seq = 100;
}

function nameOf(ctx: TeamCtx, id: string | null): string {
  if (id === ctx.me) return ctx.myName;
  return ctx.members.find((m) => m.userId === id)?.displayName ?? "Участник";
}
const LOGINS: Record<string, string> = { "2": "boris", "3": "vera", "4": "gleb", "5": "dina", "6": "egor" };
const emailOf = (ctx: TeamCtx, id: string) => (id === ctx.me ? "anna@example.com" : `${LOGINS[String(Number(id.slice(-4)))] ?? `user${id.slice(-4)}`}@example.com`);

function seed(ctx: TeamCtx) {
  if (seeded === ctx.wsId) return;
  seeded = ctx.wsId;
  const year = (y: string) => `${y}-02-01`;
  profiles.set(B, { title: "Глава отдела продаж", department: "Продажи", manager_id: null, hired_on: year("2019") });
  profiles.set(ctx.me, { title: "Руководитель группы", department: "Продажи", manager_id: B, hired_on: year("2021") });
  profiles.set(V, { title: "Менеджер по продажам", department: "Продажи", manager_id: ctx.me, hired_on: year("2023") });
  profiles.set(G, { title: "Менеджер по продажам", department: "Продажи", manager_id: ctx.me, hired_on: year("2024") });
  const direct = conv(ctx, "direct", null, [ctx.me, B], B, 90);
  post(direct, B, "Анна, привет! Как дела со сделкой «Северный ветер»?", 60);
  post(direct, ctx.me, "Отправила предложение, жду ответа.", 50);
  post(direct, B, "Отлично, держи в курсе.", 5);
  const group = conv(ctx, "group", "Отдел продаж", [ctx.me, B, V, G], B, 300);
  group.parts.get(ctx.me)!.role = "admin";
  post(group, B, "Коллеги, в пятницу планёрка в 11:00.", 120);
  const m = post(group, V, `@${ctx.myName}, подскажи, где шаблон договора?`, 10, [ctx.me]);
  notes.push({ user: ctx.me, ws: ctx.wsId, id: nid(), seq: ++seq, kind: "mention", actor_id: V, actor_name: nameOf(ctx, V), conversation_id: group.id, message_id: m.id, entity_type: null, entity_id: null, excerpt: m.body, created_at: m.created_at, read: false });
  notes.push({ user: ctx.me, ws: ctx.wsId, id: nid(), seq: ++seq, kind: "note_mention", actor_id: G, actor_name: nameOf(ctx, G), conversation_id: null, message_id: null, entity_type: "company", entity_id: null, excerpt: `@${ctx.myName} проверь счёт перед отправкой`, created_at: iso(30), read: false });
  for (const p of convs) p.parts.forEach((v, k) => { if (k !== ctx.me) v.last_read = seq; });
}

function conv(ctx: TeamCtx, kind: "direct" | "group", title: string | null, people: string[], by: string, minAgo = 0): Conv {
  const c: Conv = { id: nid(), ws: ctx.wsId, kind, title, members_can_add: true, created_by: by, created_at: iso(minAgo), last_message_at: iso(minAgo), parts: new Map() };
  for (const p of people) c.parts.set(p, { role: kind === "group" && p === by ? "owner" : "member", last_read: 0, muted: false });
  convs.push(c);
  return c;
}

function post(c: Conv, author: string, body: string, minAgo = 0, mentions: string[] = [], kind: "text" | "system" = "text"): Msg {
  const m: Msg = { id: nid(), seq: ++seq, conversation_id: c.id, author_id: author, kind, body, mentions, created_at: iso(minAgo), edited_at: null, deleted: false };
  msgs.push(m);
  c.last_message_at = m.created_at;
  const me = c.parts.get(author);
  if (me) me.last_read = m.seq;
  return m;
}

function view(ctx: TeamCtx, c: Conv): ChatConversation {
  const me = c.parts.get(ctx.me)!;
  const list = msgs.filter((m) => m.conversation_id === c.id);
  const last = list[list.length - 1];
  return {
    id: c.id, kind: c.kind, title: c.title, members_can_add: c.members_can_add, created_by: c.created_by, created_at: c.created_at, last_message_at: c.last_message_at,
    my_role: me.role, muted: me.muted, last_read_seq: me.last_read,
    participants: [...c.parts].map(([user_id, p]) => ({ user_id, role: p.role, active: user_id === ctx.me || ctx.members.some((m) => m.userId === user_id) })),
    last: last ? { seq: last.seq, author_id: last.author_id, kind: last.kind, body: last.deleted ? "" : last.body.slice(0, 200), deleted: last.deleted, created_at: last.created_at } : null,
    unread: list.filter((m) => m.seq > me.last_read && !m.deleted && m.author_id !== ctx.me).length,
  };
}

function mine(ctx: TeamCtx, id: unknown): Conv {
  const c = convs.find((x) => x.id === id && x.ws === ctx.wsId && x.parts.has(ctx.me));
  return c ?? fail("Обсуждение не найдено.");
}

/** Упоминания: «@Имя» или почта участника. */
export function mentionedIn(text: string, people: { id: string; name: string; email: string }[]): string[] {
  const low = text.toLowerCase();
  return people.filter((p) => low.includes(p.email.toLowerCase()) || (p.name.trim().length >= 2 && low.includes(`@${p.name.trim().toLowerCase()}`))).map((p) => p.id);
}

function directory(ctx: TeamCtx): TeamMember[] {
  if (!ctx.team) {
    return [{ user_id: ctx.me, display_name: ctx.myName, avatar: ctx.myAvatar, email: null, role: "owner", role_name: "Владелец", rank: 100, joined_at: null, title: "", department: "", manager_id: null, hired_on: null, last_seen: null, online: true, can_edit: false }];
  }
  seed(ctx);
  const myRank = ctx.members.find((m) => m.userId === ctx.me)?.rank ?? 0;
  return ctx.members.map((m, i) => {
    const p = profiles.get(m.userId) ?? { title: "", department: "", manager_id: null, hired_on: null };
    const online = m.userId === ctx.me || i % 2 === 1;
    return {
      user_id: m.userId, display_name: m.userId === ctx.me ? ctx.myName : m.displayName, avatar: m.userId === ctx.me ? ctx.myAvatar : null, email: emailOf(ctx, m.userId),
      role: m.role, role_name: m.roleName, rank: m.rank, joined_at: "2024-01-15T09:00:00Z", title: p.title, department: p.department, manager_id: p.manager_id,
      hired_on: p.hired_on ?? "2024-01-15", last_seen: online ? iso(0) : iso(180), online,
      can_edit: (ctx.perms.includes("members.manage") || ctx.perms.includes("invitations.manage")) && (m.rank < myRank || (m.userId === ctx.me && ctx.perms.includes("members.manage"))),
    };
  });
}

export function teamCall(cmd: string, args: Record<string, unknown>, ctx: TeamCtx): unknown {
  if (cmd === "ws_team") return directory(ctx);
  if (cmd === "ws_chat_poll") {
    if (!ctx.team) return { cursor: 0, unread: {}, fresh: [], notifications: [], freshNotifications: [], available: false };
    seed(ctx);
    const unread: Record<string, number> = {};
    for (const c of convs.filter((x) => x.ws === ctx.wsId && x.parts.has(ctx.me))) { const n = view(ctx, c).unread; if (n) unread[c.id] = n; }
    const list = notes.filter((n) => n.user === ctx.me && n.ws === ctx.wsId).sort((a, b) => b.seq - a.seq).map(({ user: _u, ws: _w, ...n }) => n);
    return { cursor: seq, unread, fresh: [], notifications: list, freshNotifications: [], available: true };
  }
  if (cmd === "ws_update_member") {
    if (!ctx.team) return fail("Участники и приглашения доступны в облачной учётной записи.");
    const target = directory(ctx).find((m) => m.user_id === args.user) ?? fail("Участник не найден.");
    if (!target.can_edit) fail("Нет прав на карточку сотрудника.");
    const f = args.fields as { title?: string; department?: string; managerId?: string | null; hiredOn?: string | null };
    const cur = profiles.get(target.user_id) ?? { title: "", department: "", manager_id: null, hired_on: null };
    if (f.managerId === target.user_id) fail("Сотрудник не может быть своим руководителем.");
    for (let w = f.managerId ?? null, i = 0; w && i < 100; w = profiles.get(w)?.manager_id ?? null, i++) if (w === target.user_id) fail("Так получится замкнутый круг руководителей.");
    profiles.set(target.user_id, {
      title: f.title?.trim() ?? cur.title, department: f.department?.trim() ?? cur.department,
      manager_id: f.managerId === undefined ? cur.manager_id : f.managerId, hired_on: f.hiredOn === undefined ? cur.hired_on : f.hiredOn,
    });
    return directory(ctx).find((m) => m.user_id === target.user_id);
  }
  // ws_chat
  const action = String(args.action);
  const a = (args.args ?? {}) as Record<string, unknown>;
  if (!ctx.team) {
    if (action === "chat_list") return [];
    return fail("Сообщения доступны в облачном Workspace: войдите в облачную учётную запись и выберите общий Workspace.", "localWorkspace");
  }
  seed(ctx);
  const people = () => directory(ctx).map((m) => ({ id: m.user_id, name: m.display_name, email: m.email ?? "" }));
  switch (action) {
    case "chat_list":
      return convs.filter((c) => c.ws === ctx.wsId && c.parts.has(ctx.me)).map((c) => view(ctx, c)).sort((x, y) => y.last_message_at.localeCompare(x.last_message_at));
    case "chat_open_direct": {
      if (a.user === ctx.me || !ctx.members.some((m) => m.userId === a.user)) fail("Получатель — другой участник Workspace.");
      const found = convs.find((c) => c.ws === ctx.wsId && c.kind === "direct" && c.parts.has(ctx.me) && c.parts.has(String(a.user)));
      return view(ctx, found ?? conv(ctx, "direct", null, [ctx.me, String(a.user)], ctx.me));
    }
    case "chat_create_group": {
      if (!ctx.perms.includes("records.create")) fail("Нет прав на создание обсуждений.");
      const title = String(a.title ?? "").trim();
      if (!title || title.length > 120) fail("Название — от 1 до 120 символов.");
      const c = conv(ctx, "group", title, [ctx.me, ...((a.members as string[]) ?? []).filter((x) => x !== ctx.me)], ctx.me);
      post(c, ctx.me, `${ctx.myName} создаёт обсуждение «${title}»`, 0, [], "system");
      return view(ctx, c);
    }
    case "chat_add_members": {
      const c = mine(ctx, a.conversation);
      if (c.kind !== "group") fail("Участников добавляют только в групповые обсуждения.");
      if (!(c.parts.get(ctx.me)!.role !== "member" || c.members_can_add || ctx.perms.includes("members.manage"))) fail("Нет прав добавлять участников.");
      const fresh = ((a.users as string[]) ?? []).filter((u) => !c.parts.has(u));
      fresh.forEach((u) => c.parts.set(u, { role: "member", last_read: 0, muted: false }));
      if (fresh.length) post(c, ctx.me, `${ctx.myName} добавляет: ${fresh.map((u) => nameOf(ctx, u)).join(", ")}`, 0, [], "system");
      return view(ctx, c);
    }
    case "chat_remove_member": {
      const c = mine(ctx, a.conversation);
      const myRole = c.parts.get(ctx.me)!.role;
      const theirs = c.parts.get(String(a.user))?.role ?? fail("Не участник обсуждения.");
      if (a.user !== ctx.me && !(myRole === "owner" || (myRole === "admin" && theirs === "member") || (ctx.perms.includes("members.manage") && theirs !== "owner"))) fail("Нет прав удалить участника.");
      c.parts.delete(String(a.user));
      if (!c.parts.size) convs.splice(convs.indexOf(c), 1);
      else {
        if (theirs === "owner") { const heir = [...c.parts.keys()][0]!; c.parts.get(heir)!.role = "owner"; }
        post(c, ctx.me, a.user === ctx.me ? `${ctx.myName} выходит из обсуждения` : `${ctx.myName} удаляет из обсуждения: ${nameOf(ctx, String(a.user))}`, 0, [], "system");
      }
      return null;
    }
    case "chat_update": {
      const c = mine(ctx, a.conversation);
      if (c.parts.get(ctx.me)!.role === "member" && !ctx.perms.includes("members.manage")) fail("Нет прав на настройки обсуждения.");
      if (typeof a.title === "string" && a.title.trim() !== c.title) { c.title = a.title.trim(); post(c, ctx.me, `${ctx.myName} переименовывает обсуждение в «${c.title}»`, 0, [], "system"); }
      if (typeof a.members_can_add === "boolean") c.members_can_add = a.members_can_add;
      return view(ctx, c);
    }
    case "chat_set_role": {
      const c = mine(ctx, a.conversation);
      if (c.parts.get(ctx.me)!.role !== "owner" && !ctx.perms.includes("members.manage")) fail("Роли в обсуждении назначает его владелец.");
      const p = c.parts.get(String(a.user));
      if (!p || p.role === "owner") fail("Нельзя изменить роль владельца.");
      p!.role = a.role === "admin" ? "admin" : "member";
      return view(ctx, c);
    }
    case "chat_set_muted": {
      const c = mine(ctx, a.conversation);
      c.parts.get(ctx.me)!.muted = Boolean(a.muted);
      return view(ctx, c);
    }
    case "chat_messages": {
      const c = mine(ctx, a.conversation);
      let list = msgs.filter((m) => m.conversation_id === c.id);
      if (typeof a.before === "number") list = list.filter((m) => m.seq < (a.before as number));
      if (typeof a.after === "number") list = list.filter((m) => m.seq > (a.after as number));
      const limit = Number(a.limit ?? 50);
      list = typeof a.after === "number" ? list.slice(0, limit) : list.slice(-limit);
      if (a.mark_read !== false) {
        c.parts.get(ctx.me)!.last_read = Math.max(c.parts.get(ctx.me)!.last_read, ...msgs.filter((m) => m.conversation_id === c.id).map((m) => m.seq), 0);
        notes.forEach((n) => { if (n.conversation_id === c.id && n.user === ctx.me) n.read = true; });
      }
      return { conversation: view(ctx, c), messages: list.map(({ conversation_id: _c, ...m }) => ({ ...m, body: m.deleted ? "" : m.body })) };
    }
    case "chat_send": {
      const c = mine(ctx, a.conversation);
      const body = String(a.body ?? "").trim();
      if (!body || body.length > 4000) fail("Сообщение — от 1 до 4000 символов.");
      const mentions = [...new Set([...((a.mentions as string[]) ?? []), ...mentionedIn(body, people())])].filter((u) => u !== ctx.me && c.parts.has(u));
      const { conversation_id: _c, ...m } = post(c, ctx.me, body, 0, mentions);
      return m;
    }
    case "chat_post": {
      const c = mine(ctx, a.conversation);
      const body = String(a.body ?? "").trim();
      const cards = (a.attachments as ChatAttachment[] | undefined) ?? [];
      if (body.length > 4000 || (!body && !cards.length)) fail("Сообщение — от 1 до 4000 символов.");
      if (cards.length > 10) fail("В сообщение можно добавить до 10 карточек.");
      const mentions = [...new Set([...((a.mentions as string[]) ?? []), ...mentionedIn(body, people())])].filter((u) => u !== ctx.me && c.parts.has(u));
      const m = post(c, ctx.me, body, 0, mentions);
      m.attachments = cards;
      const { conversation_id: _c, ...out } = m;
      return out;
    }
    case "chat_edit": {
      const m = msgs.find((x) => x.id === a.message) ?? fail("Сообщение не найдено.");
      if (m.author_id !== ctx.me || m.deleted) fail("Изменить сообщение может только автор.");
      m.body = String(a.body ?? "").trim();
      if (!m.body && !m.attachments?.length) fail("Сообщение — от 1 до 4000 символов.");
      m.edited_at = iso();
      const { conversation_id: _c, ...out } = m;
      return out;
    }
    case "chat_delete": {
      const m = msgs.find((x) => x.id === a.message) ?? fail("Сообщение не найдено.");
      const c = mine(ctx, m.conversation_id);
      if (m.author_id !== ctx.me && c.parts.get(ctx.me)!.role === "member" && !ctx.perms.includes("members.manage")) fail("Нет прав удалить сообщение.");
      m.deleted = true;
      m.attachments = [];
      return null;
    }
    case "notifications_mark_read": {
      const ids = a.ids as string[] | null | undefined;
      let n = 0;
      notes.forEach((x) => { if (x.user === ctx.me && !x.read && (!ids || ids.includes(x.id))) { x.read = true; n++; } });
      return n;
    }
    default:
      return fail("Неизвестное действие чата.");
  }
}
