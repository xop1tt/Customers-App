// Чистые помощники для сотрудников и чата: стаж, дерево подчинения, упоминания в поле ввода, подписи.

import type { AppNotification, TeamMember } from "../api/types";
import { plural } from "./format";

/** «2 года 3 месяца», «5 месяцев», «меньше месяца». */
export function tenure(hiredOn: string | null | undefined, now: Date = new Date()): string {
  if (!hiredOn) return "";
  const [y, m, d] = hiredOn.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  let months = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
  if (now.getDate() < d) months -= 1;
  if (months < 1) return "меньше месяца";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const parts: string[] = [];
  if (years) parts.push(`${years} ${plural(years, "год", "года", "лет")}`);
  if (rest) parts.push(`${rest} ${plural(rest, "месяц", "месяца", "месяцев")}`);
  return parts.join(" ");
}

export interface TreeNode { member: TeamMember; children: TreeNode[] }

/** Дерево «руководитель → подчинённые». Без руководителя (или он не в рабочем пространстве) — верхний уровень; циклы разрываются. */
export function buildTree(team: TeamMember[]): TreeNode[] {
  const ids = new Set(team.map((m) => m.user_id));
  const kids = new Map<string, TeamMember[]>();
  const roots: TeamMember[] = [];
  for (const m of team) {
    if (m.manager_id && ids.has(m.manager_id) && m.manager_id !== m.user_id) kids.set(m.manager_id, [...(kids.get(m.manager_id) ?? []), m]);
    else roots.push(m);
  }
  const seen = new Set<string>();
  const node = (m: TeamMember): TreeNode => {
    seen.add(m.user_id);
    return { member: m, children: (kids.get(m.user_id) ?? []).filter((k) => !seen.has(k.user_id)).map(node) };
  };
  const out = roots.map(node);
  // Сотрудники, попавшие в цикл, не достижимы от корней — показываем их сверху.
  for (const m of team) if (!seen.has(m.user_id)) out.push(node(m));
  return out;
}

/** Прямые подчинённые. */
export const reportsOf = (team: TeamMember[], id: string) => team.filter((m) => m.manager_id === id && m.user_id !== id);

/** Набираемое упоминание перед курсором: «… @Ве|» → { start, query: "Ве" }. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s|\(/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (query.length > 30 || /[\n@]/.test(query) || /\s\s/.test(query)) return null;
  return { start: at, query };
}

export function mentionMatches(team: TeamMember[], query: string, exclude: string[] = []): TeamMember[] {
  const q = query.trim().toLowerCase();
  return team
    .filter((m) => !exclude.includes(m.user_id))
    .filter((m) => !q || m.display_name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || m.display_name.toLowerCase().startsWith(q) || (m.email ?? "").toLowerCase().startsWith(q))
    .slice(0, 6);
}

/** Вставить «@Имя » вместо набранного запроса. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}

/** Кто упомянут в тексте (по «@Имя» или почте) — для подсветки и списка упоминаний при отправке. */
export function mentionedIds(text: string, team: TeamMember[]): string[] {
  const low = text.toLowerCase();
  return team.filter((m) => (m.email && low.includes(m.email.toLowerCase())) || (m.display_name.trim().length >= 2 && low.includes(`@${m.display_name.trim().toLowerCase()}`))).map((m) => m.user_id);
}

export function notificationText(n: Pick<AppNotification, "kind" | "actor_name">): string {
  switch (n.kind) {
    case "mention": return `${n.actor_name} упоминает вас в обсуждении`;
    case "added_to_group": return `${n.actor_name} добавляет вас в обсуждение`;
    case "note_mention": return `${n.actor_name} упоминает вас в заметке`;
    case "comment_mention": return `${n.actor_name} упоминает вас в комментарии`;
  }
}

/** «в сети», «был(а) в сети 14:05», «не в сети». */
export function presenceText(m: Pick<TeamMember, "online" | "last_seen" | "offline">, short: (iso: string) => string): string {
  if (m.offline) return "Нет связи с облаком";
  if (m.online) return "В сети";
  return m.last_seen ? `Был(а) в сети: ${short(m.last_seen)}` : "Не в сети";
}

/** Ответ на сообщение хранится первой строкой текста «↪ Имя: цитата», без изменений сервера. */
export const REPLY_MARK = "↪ ";
export interface ReplyQuote { name: string; text: string }

export function replyLine(name: string, text: string): string {
  const flat = parseReply(text).rest.replace(/\s+/g, " ").trim();
  const cut = flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
  return `${REPLY_MARK}${name.replace(/[\n:]/g, " ").trim()}: ${cut || "вложение"}`;
}

/** Делит тело на цитату (если есть) и сам текст. */
export function parseReply(body: string): { quote: ReplyQuote | null; rest: string; line: string } {
  if (!body.startsWith(REPLY_MARK)) return { quote: null, rest: body, line: "" };
  const nl = body.indexOf("\n");
  const first = nl < 0 ? body : body.slice(0, nl);
  const m = /^↪ ([^:]{1,60}): (.*)$/.exec(first);
  if (!m) return { quote: null, rest: body, line: "" };
  return { quote: { name: m[1]!, text: m[2]! }, rest: nl < 0 ? "" : body.slice(nl + 1), line: first };
}
