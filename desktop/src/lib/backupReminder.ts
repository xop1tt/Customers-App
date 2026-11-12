// Напоминание о несделанной резервной копии (пакет G8, ADR-061): чистая логика, данные — список копий ядра.

import type { BackupFile } from "../api/types";

/** Сколько дней без копии считается долгим сроком. Автокопия делается раз в сутки, поэтому неделя — это сбой. */
export const BACKUP_STALE_DAYS = 7;
const DAY = 86_400_000;

export type BackupState = { kind: "ok" } | { kind: "never" } | { kind: "stale"; days: number; last: Date };

/** Свежая ли последняя копия. Отложенное напоминание (`snoozedUntil` в будущем) не показывается. */
export function backupState(backups: BackupFile[], now: Date = new Date(), snoozedUntil: number | null = null): BackupState {
  if (snoozedUntil !== null && snoozedUntil > now.getTime()) return { kind: "ok" };
  const times = backups.map((b) => (b.modifiedAt ? Date.parse(b.modifiedAt) : NaN)).filter((t) => !Number.isNaN(t));
  if (!times.length) return { kind: "never" };
  const last = Math.max(...times);
  const days = Math.floor((now.getTime() - last) / DAY);
  return days >= BACKUP_STALE_DAYS ? { kind: "stale", days, last: new Date(last) } : { kind: "ok" };
}

/** «Позже»: напомнить снова через сутки. */
export const snoozeUntil = (now: Date = new Date()) => now.getTime() + DAY;
