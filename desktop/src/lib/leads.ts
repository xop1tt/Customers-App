// Разделы, фильтры, сортировка и подписи таблицы лидов (порт AppModel/LeadsView).

import type { Lead, LeadKind } from "../api/types";
import { integer, money } from "./format";

export type SectionId = "home" | "all" | "new" | "favorites" | "archive" | "excluded" | "sources" | "runs";

export const SECTIONS: Record<SectionId, { title: string; icon: string }> = {
  home: { title: "Главная", icon: "home" },
  all: { title: "Все лиды", icon: "inbox" },
  new: { title: "Новые", icon: "sparkles" },
  favorites: { title: "Избранное", icon: "star" },
  archive: { title: "Архив", icon: "archive" },
  excluded: { title: "Исключённые", icon: "ban" },
  sources: { title: "Источники", icon: "database" },
  runs: { title: "Журнал поиска", icon: "history" },
};

export const isLeadList = (s: SectionId) => ["all", "new", "favorites", "archive", "excluded"].includes(s);

export interface LeadFilter {
  search: string;
  kind: LeadKind | null;
  source: string | null;
  minScore: number;
  hideRejected: boolean;
  region: string | null;
}

export const emptyFilter = (search = ""): LeadFilter => ({ search, kind: null, source: null, minScore: 0, hideRejected: true, region: null });

export const filterIsDefault = (f: LeadFilter) => f.kind === null && f.source === null && f.minScore === 0 && f.hideRejected && f.region === null;

export function matchesSection(l: Lead, s: SectionId): boolean {
  switch (s) {
    case "all":
      return !l.archived && !l.excluded;
    case "new":
      return !l.seen && !l.archived && !l.excluded;
    case "favorites":
      return l.favorite && !l.excluded;
    case "archive":
      return l.archived && !l.excluded;
    case "excluded":
      return l.excluded;
    default:
      return false;
  }
}

export function count(leads: Lead[], s: SectionId, hideRejected: boolean): number {
  let n = 0;
  for (const l of leads) if (matchesSection(l, s) && (s === "excluded" || !(hideRejected && l.data.relevance === "rejected"))) n++;
  return n;
}

const has = (text: string | undefined | null, q: string) => !!text && text.toLowerCase().includes(q);

export function matchesSearch(l: Lead, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const d = l.data;
  return (
    has(d.title, q) || has(d.description, q) || has(d.address, q) || has(d.phone, q) || has(d.website, q) || has(d.region, q) ||
    has(d.category, q) || has(d.customer_name, q) || has(l.note, q) || Object.values(d.contacts).some((v) => has(v, q))
  );
}

export function visibleLeads(leads: Lead[], section: SectionId, f: LeadFilter): Lead[] {
  return leads.filter((l) => {
    if (!matchesSection(l, section)) return false;
    if (f.hideRejected && section !== "excluded" && l.data.relevance === "rejected") return false;
    if (f.kind && l.data.kind !== f.kind) return false;
    if (f.source && l.data.source !== f.source) return false;
    if (f.region && l.data.region !== f.region) return false;
    if (l.data.score < f.minScore) return false;
    return matchesSearch(l, f.search);
  });
}

export type SortKey = "title" | "kind" | "source" | "score" | "discovered";

export function sortLeads(leads: Lead[], key: SortKey, descending: boolean): Lead[] {
  const value = (l: Lead): string | number => {
    switch (key) {
      case "title":
        return l.data.title.toLowerCase();
      case "kind":
        return l.data.kind;
      case "source":
        return l.data.source;
      case "score":
        return l.data.score;
      default:
        return Date.parse(l.discoveredAt) || 0;
    }
  };
  const dir = descending ? -1 : 1;
  return [...leads].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ru");
    return c !== 0 ? c * dir : a.id.localeCompare(b.id);
  });
}

export const allSources = (leads: Lead[]): string[] => [...new Set(leads.map((l) => l.data.source))].sort();
export const allRegions = (leads: Lead[]): string[] => [...new Set(leads.map((l) => l.data.region).filter((r): r is string => !!r))].sort((a, b) => a.localeCompare(b, "ru"));

export const isNew = (l: Lead) => !l.seen && !l.archived && !l.excluded;

/** Вторая строка под названием: бюджет, адрес, регион или начало описания. */
export function subtitle(l: Lead): string {
  const d = l.data;
  const parts: string[] = [];
  if (d.budget !== undefined) parts.push(money(d.budget, d.currency));
  if (d.address) parts.push(d.address);
  if (d.region && !(d.address ?? "").includes(d.region)) parts.push(d.region);
  if (parts.length === 0 && d.description) parts.push([...d.description].slice(0, 120).join(""));
  return parts.join(" · ");
}

export type Tone = "red" | "orange" | "green" | "purple";

/** До двух коротких меток о лиде: что с сайтом, есть ли бюджет, срочность. */
export function signals(l: Lead): { text: string; tone: Tone }[] {
  const d = l.data;
  const out: { text: string; tone: Tone }[] = [];
  const facts = d.facts.join(" ").toLowerCase();
  if (d.kind === "organization") {
    if (!d.website) out.push({ text: "Нет сайта", tone: "red" });
    if (facts.includes("не открылся")) out.push({ text: "Сайт не открылся", tone: "red" });
    if (facts.includes("viewport")) out.push({ text: "Нет моб. версии", tone: "orange" });
    if (facts.includes("https") && facts.includes("нет")) out.push({ text: "Нет HTTPS", tone: "orange" });
  } else {
    if (d.budget !== undefined) out.push({ text: "Бюджет", tone: "green" });
    if (d.score_reasons.some((r) => r.includes("явный запрос"))) out.push({ text: "Явный запрос", tone: "green" });
    if (d.score_reasons.some((r) => r.includes("срочно"))) out.push({ text: "Срочно", tone: "orange" });
  }
  if (d.external_results.length > 0) out.push({ text: "Анализ", tone: "purple" });
  return out.slice(0, 2);
}

export const KIND_TITLE: Record<LeadKind, string> = { order: "Заказ", organization: "Организация" };
export const RELEVANCE_TITLE = { high: "Высокая", medium: "Средняя", low: "Низкая", rejected: "Не подходит" } as const;

export function scoreTone(score: number): "good" | "mid" | "low" {
  return score >= 70 ? "good" : score >= 45 ? "mid" : "low";
}

/** Строка о причине оценки: минус или плюс. */
export const isNegativeReason = (r: string) => r.includes("(-") || r.includes("ниже") || r.includes("похоже");

export interface DayPoint {
  day: Date;
  organizations: number;
  orders: number;
}

/** Новые лиды по дням за последние `days` дней (для графика на главной). */
export function dailyCounts(leads: Lead[], days: number, now: Date = new Date()): DayPoint[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const points: DayPoint[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    const next = new Date(day);
    next.setDate(day.getDate() + 1);
    const items = leads.filter((l) => {
      const t = Date.parse(l.discoveredAt);
      return t >= day.getTime() && t < next.getTime();
    });
    points.push({ day, organizations: items.filter((l) => l.data.kind === "organization").length, orders: items.filter((l) => l.data.kind === "order").length });
  }
  return points;
}

export const countText = (n: number) => integer(n);
