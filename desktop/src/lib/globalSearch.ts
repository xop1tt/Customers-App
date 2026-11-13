// Настройки глобального поиска в шапке: какие группы показывать в выпадающем списке и сколько результатов в группе.
// Хранятся на этом устройстве (localStorage), как и прочие локальные подсказки интерфейса.

import { useSyncExternalStore } from "react";

export interface GlobalSearchPrefs {
  enabled: boolean;
  leads: boolean;
  company: boolean;
  contact: boolean;
  deal: boolean;
  task: boolean;
  crm_lead: boolean;
  actions: boolean;
  /** Сколько результатов в каждой группе. */
  limit: number;
}

export const DEFAULT_GLOBAL_SEARCH: GlobalSearchPrefs = { enabled: true, leads: true, company: true, contact: true, deal: true, task: true, crm_lead: true, actions: true, limit: 4 };
export const GLOBAL_SEARCH_LIMITS = [3, 4, 5, 8];
const KEY = "customers.globalSearch";
const EVENT = "customers:global-search-prefs";

export function loadGlobalSearch(): GlobalSearchPrefs {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const p = raw ? { ...DEFAULT_GLOBAL_SEARCH, ...(JSON.parse(raw) as Partial<GlobalSearchPrefs>) } : { ...DEFAULT_GLOBAL_SEARCH };
    return GLOBAL_SEARCH_LIMITS.includes(p.limit) ? p : { ...p, limit: DEFAULT_GLOBAL_SEARCH.limit };
  } catch {
    return { ...DEFAULT_GLOBAL_SEARCH };
  }
}

let cache = loadGlobalSearch();
let raw = JSON.stringify(cache);

export function saveGlobalSearch(patch: Partial<GlobalSearchPrefs>) {
  cache = { ...cache, ...patch };
  raw = JSON.stringify(cache);
  try { localStorage.setItem(KEY, raw); } catch { /* без хранилища настройка живёт до закрытия окна */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/** Для тестов: вернуть настройки по умолчанию. */
export function resetGlobalSearch() {
  try { localStorage.removeItem(KEY); } catch { /* нет хранилища */ }
  cache = { ...DEFAULT_GLOBAL_SEARCH };
  raw = JSON.stringify(cache);
}

const subscribe = (f: () => void) => { window.addEventListener(EVENT, f); return () => window.removeEventListener(EVENT, f); };

export function useGlobalSearchPrefs(): GlobalSearchPrefs {
  useSyncExternalStore(subscribe, () => raw);
  return cache;
}
