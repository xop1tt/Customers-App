// Должности как справочник с правами (ADR-079). Должность — не свободный текст, а запись справочника: она задаёт роль
// (набор прав на сервере), уровень подчинения и особые полномочия (руководящая, отдел кадров, заместитель владельца).
// В базе по-прежнему лежит текст `member_profiles.title`: в нём хранится название должности из справочника.
// Всё, что ниже, — правила интерфейса; настоящая защита от прямых вызовов сервера появится вместе с новой базой.

import type { TeamMember, WsRole } from "../api/types";

export interface Position {
  key: string;
  /** Название; именно оно хранится в профиле. */
  name: string;
  /** Желаемая роль (ключ системной роли); если такой роли в Workspace нет, берётся ближайшая ниже по рангу. */
  role: string;
  rank: number;
  /** Руководящая: старшая по должности, может создавать и закрывать отделы. */
  lead?: boolean;
  /** Отдел кадров: приём, увольнение, смена должностей — только запросом владельцу или заместителю. */
  hr?: boolean;
  /** Заместитель владельца: назначает только владелец; одобряет запросы вместе с ним. */
  deputy?: boolean;
  /** Что даёт должность, простыми словами (подсказка в выпадающем списке). */
  hint: string;
}

export const POSITIONS: Position[] = [
  { key: "deputy", name: "Заместитель владельца", role: "admin", rank: 80, lead: true, deputy: true, hint: "Управляет рабочим пространством, одобряет запросы отдела кадров" },
  { key: "head", name: "Глава отдела", role: "head_of_sales", rank: 75, lead: true, hint: "Ведёт отдел, видит отчёты, управляет сотрудниками ниже" },
  { key: "lead", name: "Руководитель", role: "team_lead", rank: 70, lead: true, hint: "Ведёт группу, создаёт отделы и назначает сотрудников" },
  { key: "hr_head", name: "Руководитель отдела кадров", role: "team_lead", rank: 70, lead: true, hr: true, hint: "Оформляет приём и увольнение — с разрешения владельца" },
  { key: "hr", name: "Специалист отдела кадров", role: "manager", rank: 60, hr: true, hint: "Готовит приём и увольнение — с разрешения владельца" },
  { key: "manager", name: "Менеджер", role: "manager", rank: 60, hint: "Работает с клиентами и сделками" },
  { key: "employee", name: "Сотрудник", role: "employee", rank: 40, hint: "Работает со своими записями" },
  { key: "viewer", name: "Наблюдатель", role: "viewer", rank: 20, hint: "Только просмотр" },
];

export const OWNER_TITLE = "Владелец";

const norm = (s: string) => s.trim().toLowerCase().replace(/ё/g, "е");

/** Должность из справочника по названию в профиле; прежний свободный текст — null. */
export function positionOf(title: string | null | undefined): Position | null {
  const t = norm(title ?? "");
  return t ? POSITIONS.find((p) => norm(p.name) === t) ?? null : null;
}

/** Роль, которую выдаёт должность, среди ролей Workspace: точное совпадение или ближайшая ниже по рангу (владельца не выдаём). */
export function roleFor(p: Position, roles: Pick<WsRole, "key" | "rank">[]): string | null {
  if (!roles.length) return p.role;
  const usable = roles.filter((r) => r.key !== "owner");
  const exact = usable.find((r) => r.key === p.role);
  if (exact) return exact.key;
  const below = usable.filter((r) => r.rank <= p.rank).sort((a, b) => b.rank - a.rank)[0];
  return below?.key ?? null;
}

type Who = Pick<TeamMember, "role" | "rank" | "title">;

/** Владелец или заместитель (роль «Администратор»): одобряют запросы, назначают заместителей и руководителей. */
export const isApprover = (m: Who | null | undefined): boolean => !!m && (m.role === "owner" || m.role === "admin");
export const isOwner = (m: Who | null | undefined): boolean => !!m && m.role === "owner";

/** Сотрудник отдела кадров без полномочий владельца: все его кадровые действия идут запросом. */
export const isHr = (m: Who | null | undefined): boolean => !!m && !isApprover(m) && !!positionOf(m.title)?.hr;

/** Старший по должности: владелец, заместитель или руководитель (ранг от 70). */
export const isSenior = (m: Who | null | undefined): boolean => !!m && (isApprover(m) || m.rank >= 70);

/** Открывать, закрывать, переименовывать отделы и распределять по ним сотрудников. Рядовому сотруднику нельзя. */
export const canManageDepartments = (m: Who | null | undefined): boolean => isSenior(m) && !isHr(m);

/** Должности, которые `actor` вправе назначить `target` сам: строго ниже своего ранга; заместителя назначает только владелец; кадровик не назначает. */
export function assignable(actor: Who | null | undefined, target?: Who | null): Position[] {
  if (!actor || isHr(actor) || !isSenior(actor)) return [];
  if (target && target.rank >= actor.rank) return [];
  return POSITIONS.filter((p) => p.rank < actor.rank && (!p.deputy || isOwner(actor)));
}

/** Кому адресуются запросы кадровика, смены имени и т. п.: владелец и заместители (кроме автора). */
export const approversOf = (team: TeamMember[], exceptId?: string): TeamMember[] => team.filter((m) => isApprover(m) && m.user_id !== exceptId);

/** Имя профиля задают при оформлении; сотрудник сам его не меняет (владелец и заместитель — могут). */
export const nameLocked = (m: Who | null | undefined): boolean => !!m && !isApprover(m);

export type RequestKind = "hire" | "position" | "access" | "name";

export interface RequestInput { kind: RequestKind; author: string; target?: string; position?: string; email?: string; name?: string; reason?: string }

const clip = (s: string | undefined, n: number) => (s ?? "").trim().replace(/\s+/g, " ").slice(0, n);

/** Текст запроса — обычное сообщение в личном чате: так запрос виден в приложении и без базы. */
export function requestText(r: RequestInput): string {
  const reason = clip(r.reason, 400);
  const tail = reason ? ` Причина: ${reason}` : "";
  switch (r.kind) {
    case "hire": return `Запрос на оформление: прошу создать учётную запись${r.email ? ` для ${clip(r.email, 120)}` : ""}${r.name ? `, имя профиля «${clip(r.name, 40)}»` : ""}${r.position ? `, должность «${clip(r.position, 80)}»` : ""}.${tail}`;
    case "position": return `Запрос на смену должности: ${clip(r.target, 80)} → «${clip(r.position, 80)}».${tail}`;
    case "access": return `Запрос на закрытие доступа: ${clip(r.target, 80)}.${tail}`;
    case "name": return `Запрос на смену имени профиля: «${clip(r.name, 40)}».${tail}`;
  }
}

/** Для адресации запроса на смену имени: руководитель сотрудника (если есть) и все, кто может одобрить. */
export function nameRequestRecipients(team: TeamMember[], me: TeamMember): TeamMember[] {
  const boss = team.find((m) => m.user_id === me.manager_id && m.user_id !== me.user_id);
  const out = [...(boss ? [boss] : []), ...approversOf(team, me.user_id)];
  return out.filter((m, i) => out.findIndex((x) => x.user_id === m.user_id) === i);
}

export function nameError(name: string, current: string): string | null {
  const v = name.trim();
  if (!v) return "Введите имя";
  if (v.length > 40) return "Не больше 40 знаков";
  if (v === current.trim()) return "Это имя уже стоит в профиле";
  return null;
}
