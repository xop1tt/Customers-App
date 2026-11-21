// Настройки локальной модели («Ai»): загрузка и сохранение.

import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import type { AiCaps } from "../api/types";
import { type AiConfig, type HubConfig, defaultAi, normalizeHub } from "../lib/hub";
import { attempt, useStore } from "./store";

let cfg: HubConfig = { ai: defaultAi() };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export const getHub = (): HubConfig => cfg;
export const useHub = (): HubConfig => useSyncExternalStore(subscribe, getHub);

export async function loadHub(): Promise<void> {
  capsCache.clear();
  try {
    cfg = normalizeHub(await api.hubLoad());
  } catch {
    cfg = { ai: defaultAi() };
  }
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

// ---------------------------------------------------------------- что понимает модель

export const UNKNOWN_CAPS: AiCaps = { vision: null, audio: null };
const capsCache = new Map<string, Promise<AiCaps>>();

/** Понимает ли модель изображения и звук: спрашивает ядро один раз на адрес и модель. Ошибка — «неизвестно», без повторов до перезапуска. */
export function aiCaps(ai: Pick<AiConfig, "baseUrl" | "apiKey" | "model">): Promise<AiCaps> {
  if (!ai.baseUrl.trim() || !ai.model.trim()) return Promise.resolve(UNKNOWN_CAPS);
  const key = `${ai.baseUrl.trim()}\n${ai.model.trim()}`;
  let p = capsCache.get(key);
  if (!p) {
    p = api.aiCapabilities(ai.baseUrl.trim(), ai.apiKey || undefined, ai.model.trim()).catch(() => UNKNOWN_CAPS);
    capsCache.set(key, p);
  }
  return p;
}

/** Возможности текущей модели; пока ответ не пришёл — «неизвестно». */
export function useAiCaps(): AiCaps {
  const { ai } = useHub();
  const [caps, setCaps] = useState<{ key: string; caps: AiCaps } | null>(null);
  const key = `${ai.baseUrl}\n${ai.model}`;
  useEffect(() => {
    let live = true;
    void aiCaps(ai).then((c) => { if (live) setCaps({ key, caps: c }); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return caps?.key === key ? caps.caps : UNKNOWN_CAPS;
}

/** Загружает настройки при входе. Вызывается один раз из оболочки. */
export function useHubSync(): void {
  const user = useStore((s) => s.session?.id ?? null);
  useEffect(() => {
    if (!user) return;
    void loadHub();
  }, [user]);
}
