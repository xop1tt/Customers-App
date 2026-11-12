// Локальные настройки подсказок внутри приложения: по видам и «тихие часы» (A9, ADR-077).
// Хранятся на этом устройстве (localStorage), в облаке и в системных уведомлениях ничего не меняют.

export interface NotifyPrefs {
  messages: boolean;
  groups: boolean;
  quiet: boolean;
  /** Начало и конец тихих часов, «ЧЧ:ММ». */
  from: string;
  to: string;
  /** Колокольчик: уведомления отключены до этого момента (мс); 0 — не отключены, -1 — пока не включу. */
  muteUntil: number;
}

export const DEFAULT_PREFS: NotifyPrefs = { messages: true, groups: true, quiet: false, from: "22:00", to: "08:00", muteUntil: 0 };
const KEY = "customers.notifyPrefs";

export function loadPrefs(): NotifyPrefs {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<NotifyPrefs>) } : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: NotifyPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* без хранилища настройки просто не сохраняются */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event("customers:notify-prefs"));
}

/** Отключены ли уведомления колокольчиком сейчас. */
export function isMuted(p: NotifyPrefs, now: number = Date.now()): boolean {
  return p.muteUntil === -1 || p.muteUntil > now;
}

/** Отключить на `hours` часов; без аргумента — пока не включу; 0 — включить. */
export function setMute(hours?: number | 0, now: number = Date.now()) {
  savePrefs({ ...loadPrefs(), muteUntil: hours === 0 ? 0 : hours === undefined ? -1 : now + hours * 3_600_000 });
}

const minutes = (hm: string) => { const [h, m] = hm.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

/** Попадает ли момент в тихие часы (интервал может переходить через полночь). */
export function inQuietHours(p: NotifyPrefs, now: Date): boolean {
  if (!p.quiet) return false;
  const a = minutes(p.from), b = minutes(p.to), t = now.getHours() * 60 + now.getMinutes();
  if (a === b) return false;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

/** Показывать ли подсказку этого вида сейчас. */
export function shouldToast(kind: "message" | "group", p: NotifyPrefs, now: Date = new Date()): boolean {
  if (isMuted(p, now.getTime()) || inQuietHours(p, now)) return false;
  return kind === "message" ? p.messages : p.groups;
}
