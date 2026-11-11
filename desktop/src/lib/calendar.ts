// Календарь CRM (пакет G2, docs/CALENDAR.md): задачи по сроку и события по времени на сетке месяца и недели.
// Чистая логика без React: дни сетки, раскладка записей по местным дням, перенос срока на другой день.

import type { CrmRecord } from "../api/types";
import { ENUMS } from "./crm";
import { getLanguage } from "./i18n";

export type CalendarView = "month" | "week";

export interface CalendarItem {
  /** `task:<id>` или `activity:<id>` — ключ в списках и при перетаскивании. */
  key: string;
  kind: "task" | "activity";
  /** Срок задачи или время события. */
  at: Date;
  title: string;
  record: CrmRecord;
  /** Задача выполнена или отменена; событие уже состоялось. */
  done: boolean;
  /** Открытая задача, срок которой прошёл. */
  overdue: boolean;
}

const two = (n: number) => String(n).padStart(2, "0");

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Местный день как `2026-11-11`: ключ раскладки и перетаскивания. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
export const timeText = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;

/** Понедельник недели, в которую попадает день. */
export function weekStart(d: Date): Date {
  return addDays(d, -((d.getDay() + 6) % 7));
}

/** Дни на экране: неделя (7) или месяц целыми неделями с понедельника (35 или 42). */
export function visibleDays(view: CalendarView, anchor: Date): Date[] {
  if (view === "week") {
    const from = weekStart(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(from, i));
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const from = weekStart(first);
  const weeks = Math.ceil((Math.round((startOfDay(last).getTime() - from.getTime()) / 86_400_000) + 1) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(from, i));
}

/** Предыдущий или следующий месяц (первое число) либо неделя. */
export function shift(view: CalendarView, anchor: Date, dir: -1 | 1): Date {
  return view === "week" ? addDays(anchor, 7 * dir) : new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
}

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const MONTHS_OF = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const WEEKDAYS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Короткие названия дней недели с понедельника на языке интерфейса. */
export const weekdays = (): string[] => (getLanguage() === "en" ? WEEKDAYS_EN : WEEKDAYS);

/** Заголовок периода: «Ноябрь 2026», «9–15 ноября 2026», «30 ноября – 6 декабря 2026». */
export function periodTitle(view: CalendarView, anchor: Date): string {
  const en = getLanguage() === "en";
  if (view === "month") return `${(en ? MONTHS_EN : MONTHS)[anchor.getMonth()]} ${anchor.getFullYear()}`;
  const from = weekStart(anchor);
  const to = addDays(from, 6);
  const year = from.getFullYear() === to.getFullYear() ? "" : ` ${from.getFullYear()}`;
  if (en) {
    const left = `${MONTHS_SHORT_EN[from.getMonth()]} ${from.getDate()}${year ? `,${year}` : ""}`;
    const right = from.getMonth() === to.getMonth() && !year ? `${to.getDate()}` : `${MONTHS_SHORT_EN[to.getMonth()]} ${to.getDate()}`;
    return `${left} – ${right}, ${to.getFullYear()}`;
  }
  if (from.getMonth() === to.getMonth()) return `${from.getDate()}–${to.getDate()} ${MONTHS_OF[to.getMonth()]} ${to.getFullYear()}`;
  return `${from.getDate()} ${MONTHS_OF[from.getMonth()]}${year} – ${to.getDate()} ${MONTHS_OF[to.getMonth()]} ${to.getFullYear()}`;
}

/** Полная дата для подписи дня: «среда, 11 ноября». */
export function dayTitle(d: Date): string {
  return d.toLocaleDateString(getLanguage() === "en" ? "en-US" : "ru-RU", { weekday: "long", day: "numeric", month: "long" });
}

const live = (r: CrmRecord) => !r.deleted_at && !r.archived_at;
const parse = (v: unknown): Date | null => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Записи календаря: задачи со сроком и события (кроме служебных). `mine` — только свои: задачи участника
 *  или без исполнителя (как на экране «Сегодня») и события, которые он записал. */
export function calendarItems(tasks: CrmRecord[], activities: CrmRecord[], now: Date, mine?: string): CalendarItem[] {
  const out: CalendarItem[] = [];
  for (const t of tasks) {
    const at = parse(t.due_at);
    if (!at || !live(t)) continue;
    if (mine && t.assignee_id && t.assignee_id !== mine) continue;
    const done = t.status === "done" || t.status === "cancelled";
    out.push({ key: `task:${t.id}`, kind: "task", at, title: String(t.title || "Без названия"), record: t, done, overdue: !done && at.getTime() < now.getTime() });
  }
  for (const a of activities) {
    const at = parse(a.occurred_at);
    if (!at || !live(a) || a.type === "system") continue;
    if (mine && a.created_by && a.created_by !== mine) continue;
    const label = ENUMS["activities.type"]?.[String(a.type)] ?? "Событие";
    const summary = typeof a.summary === "string" ? a.summary.trim() : "";
    out.push({ key: `activity:${a.id}`, kind: "activity", at, title: summary ? `${label}: ${summary}` : label, record: a, done: at.getTime() < now.getTime(), overdue: false });
  }
  return out.sort((x, y) => x.at.getTime() - y.at.getTime() || x.key.localeCompare(y.key));
}

/** Записи по местным дням (`dayKey`), внутри дня — по времени. */
export function byDay(items: CalendarItem[]): Map<string, CalendarItem[]> {
  const map = new Map<string, CalendarItem[]>();
  for (const it of items) {
    const k = dayKey(it.at);
    const list = map.get(k);
    if (list) list.push(it); else map.set(k, [it]);
  }
  return map;
}

/** Новый срок: тот же час и минута по местному времени, другой день. Возвращает null, если день тот же. */
export function moveToDay(iso: string, day: Date): string | null {
  const at = parse(iso);
  if (!at || dayKey(at) === dayKey(day)) return null;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()).toISOString();
}

/** Срок новой задачи, созданной щелчком по дню: 10:00 этого дня. */
export function defaultDue(day: Date): string {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10, 0, 0).toISOString();
}

/** Границы запроса к ядру: видимые дни с запасом в сутки (значения в базе — в UTC). */
export function queryRange(days: Date[]): { from: string; to: string } {
  const first = days[0] ?? new Date();
  const last = days[days.length - 1] ?? first;
  return { from: addDays(first, -1).toISOString(), to: addDays(last, 2).toISOString() };
}
