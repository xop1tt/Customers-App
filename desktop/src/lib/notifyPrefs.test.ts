import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, inQuietHours, shouldToast } from "./notifyPrefs";

const at = (h: number, m = 0) => new Date(2026, 10, 12, h, m);

describe("подсказки в приложении", () => {
  it("тихие часы через полночь", () => {
    const p = { ...DEFAULT_PREFS, quiet: true, from: "22:00", to: "08:00" };
    expect(inQuietHours(p, at(23))).toBe(true);
    expect(inQuietHours(p, at(7, 59))).toBe(true);
    expect(inQuietHours(p, at(8))).toBe(false);
    expect(inQuietHours(p, at(12))).toBe(false);
  });
  it("тихие часы внутри суток и выключенные", () => {
    expect(inQuietHours({ ...DEFAULT_PREFS, quiet: true, from: "13:00", to: "14:00" }, at(13, 30))).toBe(true);
    expect(inQuietHours({ ...DEFAULT_PREFS, quiet: false }, at(23))).toBe(false);
    expect(inQuietHours({ ...DEFAULT_PREFS, quiet: true, from: "10:00", to: "10:00" }, at(10))).toBe(false);
  });
  it("виды подсказок", () => {
    expect(shouldToast("message", { ...DEFAULT_PREFS, messages: false }, at(12))).toBe(false);
    expect(shouldToast("group", DEFAULT_PREFS, at(12))).toBe(true);
    expect(shouldToast("group", { ...DEFAULT_PREFS, quiet: true }, at(23))).toBe(false);
  });
});
