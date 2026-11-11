import { describe, expect, it } from "vitest";
import type { BackupFile } from "../api/types";
import { BACKUP_STALE_DAYS, backupState, snoozeUntil } from "./backupReminder";

const now = new Date("2026-11-11T12:00:00Z");
const copy = (daysAgo: number | null): BackupFile => ({ name: "leadgen.db", path: "/b", size: 1, modifiedAt: daysAgo === null ? null : new Date(now.getTime() - daysAgo * 86_400_000).toISOString() });

describe("напоминание о резервной копии", () => {
  it("нет копий — «ещё нет»; копии без даты не считаются", () => {
    expect(backupState([], now)).toEqual({ kind: "never" });
    expect(backupState([copy(null)], now)).toEqual({ kind: "never" });
  });

  it("свежая копия — молчит, неделя и дольше — напоминает по самой новой", () => {
    expect(backupState([copy(30), copy(BACKUP_STALE_DAYS - 1)], now)).toEqual({ kind: "ok" });
    expect(backupState([copy(30), copy(BACKUP_STALE_DAYS)], now)).toMatchObject({ kind: "stale", days: BACKUP_STALE_DAYS });
    expect(backupState([copy(12.5)], now)).toMatchObject({ kind: "stale", days: 12 });
  });

  it("«Позже» скрывает на сутки", () => {
    const until = snoozeUntil(now);
    expect(until - now.getTime()).toBe(86_400_000);
    expect(backupState([], now, until)).toEqual({ kind: "ok" });
    expect(backupState([], new Date(until + 1), until)).toEqual({ kind: "never" });
  });
});
