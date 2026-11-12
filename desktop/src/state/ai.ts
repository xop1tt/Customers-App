// Помощник Ai: разговор с локальной моделью и выполнение её действий в приложении.
// Модель видит только названия инструментов и их результаты; изменения проходят подтверждение по режиму из настроек.

import { useSyncExternalStore } from "react";
import { api } from "../api";
import type { AiToolCall } from "../api/types";
import type { SectionId } from "../lib/leads";
import { AI_TOOLS, type AiRisk, type AiTool, needsConfirm, parseArgs, systemPrompt, toolByName, toolSpecs, validateArgs } from "../lib/aiTools";
import { type AiConfig, hubApp, isMessenger } from "../lib/hub";
import { errText, getState, openSettings, patchDevice, setSection, toast } from "./store";
import { openMarket } from "./market";
import { getHub } from "./hub";
import type { SettingsSection } from "./store";
import type { DevicePrefs } from "../api/types";

export type ActionStatus = "pending" | "running" | "done" | "rejected" | "error";
export type ViewItem =
  | { id: number; kind: "user" | "assistant" | "error"; text: string }
  | { id: number; kind: "action"; tool: string; risk: AiRisk; summary: string; status: ActionStatus; result?: string; confirm: boolean };

interface Msg { role: "system" | "user" | "assistant" | "tool"; content?: string | null; tool_calls?: AiToolCall[]; tool_call_id?: string }

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

const cap = (text: string, max = 6000) => (text.length > max ? `${text.slice(0, max)}… (обрезано)` : text);

function context(): string {
  const st = getState();
  const leads = st.snap.leads;
  return `Сегодня ${new Date().toISOString().slice(0, 10)}. Сейчас открыт раздел «${st.section}». Лидов в базе: ${leads.length}.`;
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
      const table = ({ company: "companies", contact: "contacts", crm_lead: "crm_leads", deal: "deals", task: "tasks" } as Record<string, string>)[entity] ?? entity;
      const r = await api.wsList(table, { search: String(a.query ?? "") || null, limit: lim(a.limit) });
      return JSON.stringify(r.items.map((x) => ({ id: x.id, title: x.name ?? x.full_name ?? x.title ?? "", status: x.status ?? undefined, amount: x.amount ?? undefined, due_at: x.due_at ?? undefined })));
    }
    case "get_settings": {
      const d = st.device;
      return JSON.stringify({ theme: d.theme, uiScale: d.uiScale, compactRows: d.compactRows, animations: d.animations, language: d.language, sidebarCounts: d.sidebarCounts });
    }
    case "open_section": setSection(String(a.section) as SectionId); return `Открыт раздел «${String(a.section)}».`;
    case "open_settings": if (a.section === "ai") openSettings("ai" as SettingsSection); else openSettings(String(a.section) as SettingsSection); return `Открыты настройки «${String(a.section)}».`;
    case "open_integrations": openMarket(a.page === "installed" ? "installed" : "catalog"); return "Окно «Интеграции» открыто.";
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
    case "run_search": await api.runSearch(); return "Поиск запущен.";
    case "delete_leads": { const ids = asIds(); await api.deleteLeads(ids); return `Удалено лидов: ${ids.length}.`; }
    case "send_message": {
      const svc = String(a.service);
      if (!isMessenger(svc)) return "Неизвестная интеграция.";
      return api.hubSend(svc, String(a.text));
    }
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
  if (tool.name === "send_message") {
    const svc = String(args.service);
    const on = isMessenger(svc) && getHub().integrations[svc]?.enabled;
    if (!on) return `Интеграция «${hubApp(svc)?.name ?? svc}» не подключена.`;
  }
  const confirm = needsConfirm(cfg.mode, tool.risk);
  const id = push({ kind: "action", tool: tool.name, risk: tool.risk, summary: tool.summary(args), status: confirm ? "pending" : "running", confirm });
  if (confirm) {
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

export async function askAi(text: string): Promise<void> {
  const cfg = getHub().ai;
  const t = text.trim();
  if (!t || busy) return;
  if (!cfg.enabled || !cfg.baseUrl || !cfg.model) { toast("Подключите модель в «Настройки → Ai».", "error"); return; }
  const my = ++epoch;
  busy = true;
  push({ kind: "user", text: t });
  history.push({ role: "user", content: t });
  if (history.length > 40) history = history.slice(-40);
  try {
    for (let step = 0; step <= cfg.maxSteps; step++) {
      const tools = step < cfg.maxSteps ? toolSpecs(cfg.allow) : [];
      const reply = await api.aiChat(cfg.baseUrl, cfg.apiKey || undefined, {
        model: cfg.model, temperature: cfg.temperature,
        messages: [{ role: "system", content: systemPrompt(cfg, context()) }, ...history],
        ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      });
      if (my !== epoch) return;
      const msg = reply.choices?.[0]?.message;
      if (!msg) throw { message: "Модель вернула пустой ответ." };
      const calls = (msg.tool_calls ?? []).filter((c) => c?.function?.name);
      history.push({ role: "assistant", content: msg.content ?? "", ...(calls.length ? { tool_calls: calls.map((c, i) => ({ ...c, id: c.id ?? `call_${step}_${i}`, type: "function" })) } : {}) });
      if (msg.content?.trim()) push({ kind: "assistant", text: msg.content.trim() });
      if (!calls.length) break;
      for (const [i, c] of calls.entries()) {
        const out = await handleCall(c, cfg, my);
        if (my !== epoch) return;
        history.push({ role: "tool", tool_call_id: c.id ?? `call_${step}_${i}`, content: out });
      }
      if (step === cfg.maxSteps) push({ kind: "error", text: "Достигнут предел шагов. Напишите «продолжай», если нужно." });
    }
  } catch (e) {
    if (my === epoch) push({ kind: "error", text: errText(e) });
  } finally {
    if (my === epoch) { busy = false; emit(); }
  }
}

export { AI_TOOLS };
