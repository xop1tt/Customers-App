// Действия над лидами, общие для таблицы, контекстного меню, инспектора и панели выбранного.

import { api } from "../api";
import type { Lead } from "../api/types";
import { copyText } from "../lib/platform";
import { plural } from "../lib/format";
import { confirmDialog } from "../ui/overlay";
import { attempt, getState, refreshSnapshot, select, setState, toast } from "./store";

const leadsById = (ids: string[]) => {
  const set = new Set(ids);
  return getState().snap.leads.filter((l) => set.has(l.id));
};

export async function setFavorite(ids: string[], on: boolean) {
  await attempt(() => api.setFavorite(ids, on));
  await refreshSnapshot();
}
export async function setArchived(ids: string[], on: boolean) {
  await attempt(() => api.setArchived(ids, on));
  select(getState().selection.filter((id) => !ids.includes(id)));
  await refreshSnapshot();
  toast(on ? `В архиве: ${ids.length}` : `Возвращено из архива: ${ids.length}`);
}
export async function markSeen(ids: string[]) {
  const fresh = leadsById(ids).filter((l) => !l.seen).map((l) => l.id);
  if (fresh.length === 0) return;
  await attempt(() => api.markSeen(fresh));
}
export async function markAllSeen() {
  await attempt(() => api.markAllSeen());
  await refreshSnapshot();
}

export async function deleteLeads(ids: string[]) {
  const n = ids.length;
  const ok = await confirmDialog({
    title: n === 1 ? "Удалить лид?" : `Удалить ${n} ${plural(n, "лид", "лида", "лидов")}?`,
    message: "Лиды будут удалены из базы и с остальных устройств. Если такой лид найдётся при следующем поиске, он появится снова.",
    confirm: "Удалить",
    danger: true,
  });
  if (!ok) return;
  await attempt(() => api.deleteLeads(ids));
  select([]);
  await refreshSnapshot();
}

/** Значение для исключения: сайт организации, затем почта, телефон и название. */
export function excludeValue(l: Lead): { value: string; kind: "domain" | "email" | "phone" | "name" } {
  const d = l.data;
  if (d.kind === "organization") {
    const site = d.website || d.url;
    try {
      const host = new URL(/^https?:\/\//.test(site ?? "") ? (site as string) : `https://${site}`).hostname.replace(/^www\./, "");
      if (site && host.includes(".") && host !== "openstreetmap.org" && !host.endsWith(".openstreetmap.org")) return { value: host, kind: "domain" };
    } catch { /* не адрес */ }
    const email = l.emails[0];
    if (email) return { value: email, kind: "email" };
    const phone = l.phones[0];
    if (phone) return { value: phone, kind: "phone" };
  }
  return { value: d.customer_name || d.title, kind: "name" };
}

export async function excludeLeads(ids: string[]) {
  const list = leadsById(ids);
  const values = [...new Map(list.map((l) => excludeValue(l)).map((v) => [`${v.kind}:${v.value}`, v])).values()];
  const ok = await confirmDialog({
    title: "Исключить из поиска?",
    message: `Будут исключены: ${values.slice(0, 5).map((v) => v.value).join(", ")}${values.length > 5 ? ` и ещё ${values.length - 5}` : ""}. Подходящие лиды уйдут в «Исключённые», новые такие лиды не будут добавляться. Убрать исключение можно в настройках.`,
    confirm: "Исключить",
    danger: true,
  });
  if (!ok) return;
  for (const v of values) await attempt(() => api.exclude(v.value, v.kind));
  select([]);
  await refreshSnapshot();
  toast(`Исключено: ${values.length}`);
}

export async function copyToClipboard(text: string, what = "Скопировано") {
  await copyText(text);
  toast(what);
}

export async function openLink(url: string) {
  await attempt(() => api.openUrl(url));
}

export function openExport(ids?: string[]) {
  if (ids) select(ids);
  setState({ exportOpen: true });
}

export async function startSearch(only?: string[]) {
  if (getState().search.running) return;
  await attempt(() => api.runSearch(only));
}
export async function stopSearch() {
  await attempt(() => api.stopSearch());
}
