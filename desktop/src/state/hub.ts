// Настройки локальной модели («Ai»): загрузка и сохранение.

import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api";
import { type AiConfig, type HubConfig, defaultAi, normalizeHub } from "../lib/hub";
import { attempt, useStore } from "./store";

let cfg: HubConfig = { ai: defaultAi() };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export const getHub = (): HubConfig => cfg;
export const useHub = (): HubConfig => useSyncExternalStore(subscribe, getHub);

export async function loadHub(): Promise<void> {
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

/** Загружает настройки при входе. Вызывается один раз из оболочки. */
export function useHubSync(): void {
  const user = useStore((s) => s.session?.id ?? null);
  useEffect(() => {
    if (!user) return;
    void loadHub();
  }, [user]);
}
