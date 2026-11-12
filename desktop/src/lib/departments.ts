// Справочник отделов поверх текстового поля профиля (department). Отдельной сущности в базе нет (ADR-076):
// отдел — это название, общее у нескольких участников. Переименование и слияние меняют это название у участников.

import type { TeamMember } from "../api/types";

export interface Department {
  /** Название; пустая строка — участники без отдела. */
  name: string;
  members: TeamMember[];
}

const key = (s: string) => s.trim().toLowerCase();

/** Отделы по алфавиту (регистр не важен), «Без отдела» в конце; руководители отдела — сначала по рангу. */
export function departmentsOf(team: TeamMember[]): Department[] {
  const map = new Map<string, Department>();
  for (const m of team) {
    const name = m.department.trim();
    const k = key(name);
    const d = map.get(k) ?? { name, members: [] };
    d.members.push(m);
    map.set(k, d);
  }
  const list = [...map.values()];
  for (const d of list) d.members.sort((a, b) => b.rank - a.rank || a.display_name.localeCompare(b.display_name, "ru"));
  return list.sort((a, b) => (a.name === "" ? 1 : b.name === "" ? -1 : a.name.localeCompare(b.name, "ru", { sensitivity: "base" })));
}

/** Участники, чей отдел нужно изменить, и сколько останется недоступно (нет права править профиль). */
export function renamePlan(dep: Department, to: string): { change: TeamMember[]; locked: number } {
  const next = to.trim();
  const rest = dep.members.filter((m) => m.department.trim() !== next);
  return { change: rest.filter((m) => m.can_edit), locked: rest.filter((m) => !m.can_edit).length };
}

/** Проверка нового названия: пусто, слишком длинно (в базе ≤120). */
export function departmentError(name: string): string | null {
  const v = name.trim();
  if (!v) return "Введите название отдела";
  if (v.length > 120) return "Не больше 120 знаков";
  return null;
}

/** «Моя команда» (прямые и косвенные подчинённые) и «мой отдел» — для фильтров, не для прав. */
export function teamOf(team: TeamMember[], me: string): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    for (const m of team) if (m.manager_id === id && !out.has(m.user_id) && m.user_id !== me) { out.add(m.user_id); walk(m.user_id); }
  };
  walk(me);
  return out;
}
export function sameDepartment(team: TeamMember[], me: string): Set<string> {
  const mine = team.find((m) => m.user_id === me)?.department.trim().toLowerCase();
  if (!mine) return new Set();
  return new Set(team.filter((m) => m.user_id !== me && m.department.trim().toLowerCase() === mine).map((m) => m.user_id));
}
