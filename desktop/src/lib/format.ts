// Даты и числа по языку интерфейса. Часовой пояс — местный, как в прежних версиях.

import { getLanguage } from "./i18n";

const MONTHS_SHORT = ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];
const MONTHS_FULL = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

const MONTHS_SHORT_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const en = () => getLanguage() === "en";
/** «3 нояб.» / «Nov 3». */
export const dayShort = (d: Date) => (en() ? `${MONTHS_SHORT_EN[d.getMonth()]} ${d.getDate()}` : `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`);
const dayFull = (d: Date) => (en() ? `${MONTHS_FULL_EN[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : `${d.getDate()} ${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`);

const two = (n: number) => String(n).padStart(2, "0");

export function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** «14:05», «Вчера, 14:05», «3 нояб.», «3 нояб. 2025» — как в таблице лидов. */
export function shortRelative(iso: string | null | undefined, now: Date = new Date()): string {
  const d = parseDate(iso);
  if (!d) return "—";
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (sameDay(d, now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Вчера, ${time}`;
  const base = dayShort(d);
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** «5 ноября 2026, 09:42». */
export function fullRu(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return "—";
  return `${dayFull(d)}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function dateOnly(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return "—";
  return dayFull(d);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} ${en() ? "B" : "Б"}`;
  const units = en() ? ["KB", "MB", "GB", "TB"] : ["КБ", "МБ", "ГБ", "ТБ"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "")} ${units[i]}`.replace(".", en() ? "." : ",");
}

export function integer(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, en() ? "," : " ");
}

export function money(amount: number, currency?: string): string {
  const cur = !currency || currency === "RUB" ? "₽" : currency;
  return `${integer(amount)} ${cur}`;
}

/** «Каждый час», «Каждые 3 ч», «Раз в сутки», «Раз в 5 дн.». */
export function intervalTitle(hours: number): string {
  if (hours === 1) return "Каждый час";
  if (hours < 24) return `Каждые ${Math.round(hours)} ч`;
  if (hours === 24) return "Раз в сутки";
  return `Раз в ${Math.round(hours / 24)} дн.`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Домашняя папка в путях сокращается до «~» только для показа. */
export function shortenHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}
