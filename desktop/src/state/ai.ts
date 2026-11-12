// Помощник Ai: разговор с локальной моделью и выполнение её действий в приложении.
// Модель видит только названия инструментов и их результаты; изменения проходят подтверждение по режиму из настроек.

import { useSyncExternalStore } from "react";
import { api } from "../api";
import type { AiToolCall } from "../api/types";
import type { SectionId } from "../lib/leads";
import { AI_TOOLS, type AiRisk, type AiTool, TABLES, needsConfirm, parseArgs, responsibleField, systemPrompt, toolByName, toolSpecs, validateArgs } from "../lib/aiTools";
import { type AiAttachment, type ContentPart, slimContent, userContent } from "../lib/aiFiles";
import { can, memberName } from "../lib/crm";
import type { AiConfig } from "../lib/hub";
import { errText, getState, openSettings, patchDevice, setSection, setState, toast } from "./store";
import { openMarket } from "./market";
import { getHub } from "./hub";
import type { SettingsSection } from "./store";
import type { DevicePrefs } from "../api/types";

export type ActionStatus = "pending" | "running" | "done" | "rejected" | "error";
export type ViewItem =
  | { id: number; kind: "assistant" | "error"; text: string }
  | { id: number; kind: "user"; text: string; files?: string[] }
  | { id: number; kind: "action"; tool: string; risk: AiRisk; summary: string; status: ActionStatus; result?: string; confirm: boolean };

interface Msg { role: "system" | "user" | "assistant" | "tool"; content?: string | ContentPart[] | null; tool_calls?: AiToolCall[]; tool_call_id?: string }

let view: ViewItem[] = [];
let history: Msg[] = [];
let busy = false;
let nextId = 1;
let epoch = 0;
const waiting = new Map<number, (ok: boolean) => void>();
const subs = new Set<() => void>();
const snapshot = () => ({ view, busy });
let snap = snapshot();
const emit = () => { snap = snapshot(); subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useAi = () => useSyncExternalStore(subscribe, () => snap);

type NewItem = ViewItem extends infer V ? (V extends ViewItem ? Omit<V, "id"> : never) : never;
const push = (item: NewItem): number => {
  const id = nextId++;
  view = [...view, { ...item, id } as ViewItem];
  emit();
  return id;
};
const patch = (id: number, p: Partial<Extract<ViewItem, { kind: "action" }>>) => {
  view = view.map((v) => (v.id === id && v.kind === "action" ? { ...v, ...p } : v));
  emit();
};

/** Пользователь отвечает на карточку подтверждения. */
export function answerAction(id: number, ok: boolean) {
  const r = waiting.get(id);
  waiting.delete(id);
  r?.(ok);
}

export function clearChat() {
  epoch++;
  for (const r of waiting.values()) r(false);
  waiting.clear();
  view = [];
  history = [];
  busy = false;
  emit();
}

export function stopChat() {
  epoch++;
  for (const r of waiting.values()) r(false);
  waiting.clear();
  busy = false;
  emit();
}

/** Сообщить, что модель закончила или ждёт ответа — если пользователь сейчас не смотрит в чат Ai. */
function attention(title: string, body: string) {
  if (!getHub().ai.enabled || !getHub().ai.notify || typeof document === "undefined") return;
  const focused = document.hasFocus();
  if (focused && getState().aiOpen) return;
  if (focused) toast(`${title}: ${body}`);
  else void api.aiNotify(title, body).catch(() => {});
}

const brief = (t: string, n = 140) => { const x = t.replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };

/** Индекс последнего сообщения пользователя с вложением: только в нём изображения и звук отправляются повторно. */
const lastHeavy = () => history.map((m, i) => (m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p.type !== "text") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);

const cap = (text: string, max = 6000) => (text.length > max ? `${text.slice(0, max)}… (обрезано)` : text);

function context(): string {
  const st = getState();
  const leads = st.snap.leads;
  const people = st.ws?.active ? st.ws.members.slice(0, 40).map((m) => `${m.displayName} (${m.userId}, ${m.roleName})`).join("; ") : "";
  const me = st.ws?.members.find((m) => m.userId === st.ws?.me)?.displayName;
  return `Сегодня ${new Date().toISOString().slice(0, 10)}. Сейчас открыт раздел «${st.section}». Лидов в базе: ${leads.length}.${people ? ` Сотрудники: ${people}.${me ? ` Пользователь — ${me}.` : ""}` : ""}`;
}

// ------------------------------------------------------------------ инструменты

async function runTool(tool: AiTool, a: Record<string, unknown>): Promise<string> {
  const st = getState();
  const leads = st.snap.leads;
  const lim = (n: unknown) => Math.min(20, Math.max(1, typeof n === "number" ? n : 10));
  const asIds = () => (a.ids as string[]).filter((id) => leads.some((l) => l.id === id));
  switch (tool.name) {
    case "get_overview":
      return JSON.stringify({ leads: leads.length, new: leads.filter((l) => !l.seen && !l.archived).length, favorites: leads.filter((l) => l.favorite).length, archived: leads.filter((l) => l.archived).length, lastSearchAt: st.snap.lastSearchAt, searchRunning: st.search.running });
    case "search_leads": {
      const q = String(a.query ?? "").toLowerCase().trim();
      const only = a.only as string | undefined;
      const found = leads.filter((l) => {
        if (only === "new" && (l.seen || l.archived)) return false;
        if (only === "favorites" && !l.favorite) return false;
        if (only === "archived" ? !l.archived : l.archived) return false;
        return !q || [l.data.title, l.data.description, l.data.region, l.data.source, l.data.customer_name, l.data.category].some((x) => (x ?? "").toLowerCase().includes(q));
      }).slice(0, lim(a.limit));
      return JSON.stringify(found.map((l) => ({ id: l.id, title: l.data.title, source: l.data.source, score: Math.round(l.data.score), favorite: l.favorite, archived: l.archived, region: l.data.region ?? null, phone: l.phones[0] ?? null })));
    }
    case "search_crm": {
      if (!st.ws?.active) return "Рабочее пространство CRM не открыто.";
      const entity = String(a.entity);
      const table = TABLES[entity] ?? entity;
      const members = st.ws.members;
      const when = entity === "task" ? "due_at" : entity === "activity" ? "occurred_at" : null;
      const filters = when ? [...(a.from ? [{ field: when, op: "gte", value: String(a.from) }] : []), ...(a.to ? [{ field: when, op: "lt", value: String(a.to) }] : [])] : [];
      const r = await api.wsList(table, { search: String(a.query ?? "") || null, limit: lim(a.limit), ...(filters.length ? { filters } : {}), ...(when ? { sort: [{ field: when, dir: "asc" as const }] } : {}) });
      return JSON.stringify(r.items.map((x) => ({
        id: x.id, title: x.name ?? x.full_name ?? x.title ?? x.summary ?? "", status: x.status ?? undefined, amount: x.amount ?? undefined,
        due_at: x.due_at ?? undefined, at: x.occurred_at ?? undefined, type: entity === "activity" ? x.type : undefined,
        responsible: x[responsibleField(entity)] ? memberName(members, x[responsibleField(entity)]) : undefined,
      })));
    }
    case "get_settings": {
      const d = st.device;
      return JSON.stringify({ theme: d.theme, uiScale: d.uiScale, compactRows: d.compactRows, animations: d.animations, language: d.language, sidebarCounts: d.sidebarCounts });
    }
    case "open_section": setSection(String(a.section) as SectionId); return `Открыт раздел «${String(a.section)}».`;
    case "open_settings": if (a.section === "ai") openSettings("ai" as SettingsSection); else openSettings(String(a.section) as SettingsSection); return `Открыты настройки «${String(a.section)}».`;
    case "open_connectors": openMarket(a.page === "installed" ? "installed" : a.page === "review" ? "review" : "catalog"); return "Окно «Коннекторы» открыто.";
    case "set_setting": await patchDevice({ [String(a.key)]: a.value } as Partial<DevicePrefs>); return `Настройка «${String(a.key)}» изменена.`;
    case "set_favorite": { const ids = asIds(); await api.setFavorite(ids, a.on === true); return `Готово: лидов ${ids.length}.`; }
    case "archive_leads": { const ids = asIds(); await api.setArchived(ids, a.on === true); return `Готово: лидов ${ids.length}.`; }
    case "add_note": {
      const lead = leads.find((l) => l.id === a.id);
      if (!lead) return "Лид с таким id не найден.";
      await api.setNote(lead.id, lead.note ? `${lead.note}\n${String(a.text)}` : String(a.text));
      return "Заметка добавлена.";
    }
    case "create_task": {
      if (!st.ws?.active) return "Рабочее пространство CRM не открыто: задачу создать негде.";
      const r = await api.wsSave("tasks", null, { title: String(a.title), ...(a.description ? { description: String(a.description) } : {}), ...(a.due_at ? { due_at: String(a.due_at) } : {}) });
      return `Задача создана (id ${r.id}).`;
    }
    case "update_event": {
      if (!st.ws?.active) return "Рабочее пространство CRM не открыто.";
      const table = TABLES[String(a.entity)]!;
      const rec = (await api.wsCard(table, String(a.id)).catch(() => null))?.record;
      if (!rec) return "Запись с таким id не найдена.";
      if (!can(st.ws.permissions, "edit", rec, st.ws.me)) return "Отказано: у пользователя нет прав менять эту запись.";
      const task = a.entity === "task";
      const f: Record<string, unknown> = {};
      if (a.title !== undefined) f[task ? "title" : "summary"] = String(a.title);
      if (a.at !== undefined) f[task ? "due_at" : "occurred_at"] = new Date(String(a.at)).toISOString();
      if (a.description !== undefined) f.description = String(a.description);
      if (a.status !== undefined) f.status = a.status;
      if (a.priority !== undefined) f.priority = a.priority;
      if (a.type !== undefined) f.type = a.type;
      if (!task && rec.type === "system") return "Системные записи истории менять нельзя.";
      await api.wsSave(table, rec.id, f);
      setState((s) => ({ wsVersion: s.wsVersion + 1 }));
      return `${task ? "Задача" : "Событие"} изменено.`;
    }
    case "set_responsible": {
      if (!st.ws?.active) return "Рабочее пространство CRM не открыто.";
      const table = TABLES[String(a.entity)]!;
      const rec = (await api.wsCard(table, String(a.id)).catch(() => null))?.record;
      if (!rec) return "Запись с таким id не найдена.";
      // Назначать и снимать ответственных может только тот, кто вправе менять чужие записи (records.edit); «только свои» недостаточно.
      if (!st.ws.permissions.includes("records.edit") || !can(st.ws.permissions, "edit", rec, st.ws.me)) return "Отказано: назначать и снимать ответственных могут только сотрудники с правом менять записи.";
      let who: string | null = null;
      if (a.unassign !== true) {
        const q = String(a.member).trim().toLowerCase();
        const hits = st.ws.members.filter((m) => m.userId === a.member || m.displayName.toLowerCase() === q);
        const found = hits.length ? hits : st.ws.members.filter((m) => m.displayName.toLowerCase().includes(q));
        if (found.length !== 1) return found.length ? `Под «${String(a.member)}» подходит несколько сотрудников: ${found.map((m) => m.displayName).join(", ")}. Уточните.` : "Такого сотрудника нет в рабочем пространстве (список — в контексте).";
        who = found[0]!.userId;
      }
      await api.wsSave(table, rec.id, { [responsibleField(String(a.entity))]: who });
      setState((s) => ({ wsVersion: s.wsVersion + 1 }));
      return who ? `Ответственный назначен: ${memberName(st.ws.members, who)}.` : "Ответственный снят.";
    }
    case "run_search": await api.runSearch(); return "Поиск запущен.";
    case "delete_leads": { const ids = asIds(); await api.deleteLeads(ids); return `Удалено лидов: ${ids.length}.`; }
    default: return "Неизвестный инструмент.";
  }
}

/** Выполняет один вызов инструмента с проверкой разрешений, аргументов и подтверждением. Всегда возвращает текст для модели. */
async function handleCall(call: AiToolCall, cfg: AiConfig, my: number): Promise<string> {
  const tool = toolByName(call.function.name);
  if (!tool || !cfg.allow.includes(tool.group)) return `Инструмент «${call.function.name}» недоступен.`;
  const args = parseArgs(call.function.arguments);
  if (!args) return "Аргументы должны быть JSON-объектом.";
  const bad = validateArgs(tool, args);
  if (bad) return bad;
  const confirm = needsConfirm(cfg.mode, tool.risk);
  const id = push({ kind: "action", tool: tool.name, risk: tool.risk, summary: tool.summary(args), status: confirm ? "pending" : "running", confirm });
  if (confirm) {
    attention("Ai ждёт ответа", brief(tool.summary(args)));
    const ok = await new Promise<boolean>((resolve) => waiting.set(id, resolve));
    if (my !== epoch) return "Отменено.";
    if (!ok) { patch(id, { status: "rejected" }); return "Пользователь отклонил это действие."; }
    patch(id, { status: "running" });
  }
  try {
    const out = cap(await runTool(tool, args));
    if (my === epoch) patch(id, { status: "done", result: out.length > 240 ? `${out.slice(0, 240)}…` : out });
    return out;
  } catch (e) {
    const m = errText(e);
    if (my === epoch) patch(id, { status: "error", result: m });
    return `Ошибка: ${m}`;
  }
}

export async function askAi(text: string, files: AiAttachment[] = []): Promise<void> {
  const cfg = getHub().ai;
  if (!cfg.enabled) return;
  const t = text.trim();
  if (!t || busy) return;
  if (!cfg.enabled || !cfg.baseUrl || !cfg.model) { toast("Подключите модель в «Настройки → Ai».", "error"); return; }
  const my = ++epoch;
  busy = true;
  push({ kind: "user", text: t, ...(files.length ? { files: files.map((f) => f.name) } : {}) });
  history.push({ role: "user", content: userContent(t, files) });
  if (history.length > 40) history = history.slice(-40);
  let outcome = "";
  let failed = false;
  try {
    for (let step = 0; step <= cfg.maxSteps; step++) {
      const tools = step < cfg.maxSteps ? toolSpecs(cfg.allow) : [];
      const reply = await api.aiChat(cfg.baseUrl, cfg.apiKey || undefined, {
        model: cfg.model, temperature: cfg.temperature,
        messages: [{ role: "system", content: systemPrompt(cfg, context()) }, ...history.map((m, i) => (m.role === "user" ? { ...m, content: slimContent(m.content, i === lastHeavy()) } : m))],
        ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      });
      if (my !== epoch) return;
      const msg = reply.choices?.[0]?.message;
      if (!msg) throw { message: "Модель вернула пустой ответ." };
      const calls = (msg.tool_calls ?? []).filter((c) => c?.function?.name);
      history.push({ role: "assistant", content: msg.content ?? "", ...(calls.length ? { tool_calls: calls.map((c, i) => ({ ...c, id: c.id ?? `call_${step}_${i}`, type: "function" })) } : {}) });
      if (msg.content?.trim()) { push({ kind: "assistant", text: msg.content.trim() }); outcome = msg.content.trim(); }
      if (!calls.length) break;
      for (const [i, c] of calls.entries()) {
        const out = await handleCall(c, cfg, my);
        if (my !== epoch) return;
        history.push({ role: "tool", tool_call_id: c.id ?? `call_${step}_${i}`, content: out });
      }
      if (step === cfg.maxSteps) push({ kind: "error", text: "Достигнут предел шагов. Напишите «продолжай», если нужно." });
    }
  } catch (e) {
    if (my === epoch) { push({ kind: "error", text: errText(e) }); failed = true; outcome = errText(e); }
  } finally {
    if (my === epoch) {
      busy = false;
      emit();
      attention(failed ? "Ai не смог ответить" : "Ai закончил", brief(outcome || "Готово."));
    }
  }
}

export { AI_TOOLS };
