// Пузырёк «Новое» в настройках: раздел или подраздел, где появились параметры, помечается, пока его не откроют.
// Что считается новым — список ниже; при добавлении параметров в этот список вписывают раздел и подраздел.
// Какие метки уже просмотрены, хранится на этом устройстве (localStorage).

import { useSyncExternalStore } from "react";

export interface NewSetting {
  /** Уникальный код метки; новый параметр — новый код. */
  id: string;
  section: string;
  /** Подраздел; без него метка у самого раздела. */
  sub?: string;
}

export const NEW_SETTINGS: NewSetting[] = [
  { id: "2026-11-gsearch", section: "system", sub: "gsearch" },
];

const KEY = "customers.settingsSeen";
const EVENT = "customers:settings-seen";

function load(): string[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

let seen = load();
let version = 0;

/** Пометить параметры раздела (и подраздела) просмотренными. */
export function markSettingsSeen(section: string, sub: string | null) {
  const add = NEW_SETTINGS.filter((n) => n.section === section && (n.sub ? n.sub === sub : true) && !seen.includes(n.id)).map((n) => n.id);
  if (!add.length) return;
  seen = [...seen, ...add];
  version++;
  try { localStorage.setItem(KEY, JSON.stringify(seen)); } catch { /* без хранилища метка вернётся при следующем запуске */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

/** Для тестов. */
export function resetSettingsSeen() {
  seen = [];
  version++;
  try { localStorage.removeItem(KEY); } catch { /* нет хранилища */ }
}

const subscribe = (f: () => void) => { window.addEventListener(EVENT, f); return () => window.removeEventListener(EVENT, f); };

/** Непросмотренные метки; перерисовка при каждом просмотре. */
export function useUnseenSettings(): NewSetting[] {
  useSyncExternalStore(subscribe, () => version);
  return NEW_SETTINGS.filter((n) => !seen.includes(n.id));
}

export const sectionIsNew = (list: NewSetting[], section: string) => list.some((n) => n.section === section);
export const subIsNew = (list: NewSetting[], section: string, sub: string) => list.some((n) => n.section === section && n.sub === sub);
