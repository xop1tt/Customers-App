// Настройки встроенных интеграций и локальной модели («Интеграции», «Ai»): загрузка, сохранение, рассылка событий.

import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api";
import { on } from "../api/backend";
import { type AiConfig, type HubApp, type HubConfig, type HubEvent, type HubIntegration, type Messenger, MESSENGERS, defaultAi, hubApp, isConfigured, normalizeHub } from "../lib/hub";
import { attempt, toast, useStore } from "./store";

let cfg: HubConfig = { integrations: {}, ai: defaultAi() };
let loaded = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export const getHub = (): HubConfig => cfg;
export const useHub = (): HubConfig => useSyncExternalStore(subscribe, getHub);

export async function loadHub(): Promise<void> {
  try {
    cfg = normalizeHub(await api.hubLoad());
  } catch {
    cfg = { integrations: {}, ai: defaultAi() };
  }
  loaded = true;
  emit();
}

async function persist(next: HubConfig): Promise<boolean> {
  const prev = cfg;
  cfg = next;
  emit();
  if ((await attempt(() => api.hubSave(next))) === undefined) { cfg = prev; emit(); return false; }
  return true;
}

export const saveAi = (patch: Partial<AiConfig>) => persist({ ...cfg, ai: { ...cfg.ai, ...patch } });

/** Установка и изменение интеграции. */
export const saveIntegration = (id: string, patch: Partial<HubIntegration>) => {
  const old = cfg.integrations[id] ?? { enabled: true, installedAt: new Date().toISOString(), events: [] };
  return persist({ ...cfg, integrations: { ...cfg.integrations, [id]: { ...old, ...patch } } });
};

export const removeIntegration = (id: string) => {
  const { [id]: _gone, ...rest } = cfg.integrations;
  return persist({ ...cfg, integrations: rest });
};

/** Подключённые мессенджеры, у которых включены и заполнены настройки. */
export function activeMessengers(c: HubConfig = cfg): Messenger[] {
  return MESSENGERS.filter((m) => { const a = hubApp(m) as HubApp; const v = c.integrations[m]; return !!v?.enabled && isConfigured(a, v); });
}

/** Отправляет текст всем мессенджерам, которым нужно это событие. Ошибки не прерывают работу приложения: только уведомление. */
export async function notifyEvent(event: HubEvent, text: string): Promise<void> {
  const targets = activeMessengers().filter((m) => cfg.integrations[m]!.events.includes(event));
  await Promise.all(targets.map(async (m) => {
    try { await api.hubSend(m, text); } catch (e) { toast(`${hubApp(m)?.name ?? m}: ${(e as { message?: string })?.message ?? "не удалось отправить сообщение"}`, "error"); }
  }));
}

/** Загружает настройки при входе и слушает события приложения. Вызывается один раз из оболочки. */
export function useHubSync(): void {
  const user = useStore((s) => s.session?.id ?? null);
  useEffect(() => {
    if (!user) return;
    void loadHub();
  }, [user]);
  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    void on<{ summary: string; failed: boolean }>("search-finished", (r) => {
      if (!loaded || r.failed) return;
      void notifyEvent("search.finished", `Customers: ${r.summary}`);
    }).then((f) => { if (dead) f(); else off = f; });
    return () => { dead = true; off?.(); };
  }, []);
}
