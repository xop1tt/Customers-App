import { describe, expect, it } from "vitest";
import { formatRecoveryKey, normalizeRecoveryKey } from "./recoveryKey";

const KEY = "7KQ2MXW9RT4HBNCP3VZE6GJ8SYD5FA";

describe("ключ восстановления", () => {
  it("показывается группами по пять", () => {
    expect(formatRecoveryKey(KEY)).toBe("7KQ2M-XW9RT-4HBNC-P3VZE-6GJ8S-YD5FA");
  });

  it("вводится как удобно: строчными, с пробелами или дефисами", () => {
    expect(normalizeRecoveryKey("7kq2m xw9rt 4hbnc p3vze 6gj8s yd5fa")).toBe(KEY);
    expect(normalizeRecoveryKey(" 7KQ2M-XW9RT-4HBNC-P3VZE-6GJ8S-YD5FA ")).toBe(KEY);
  });

  it("короткий ключ и похожие знаки (O, I, 0, 1) отклоняются", () => {
    expect(normalizeRecoveryKey(KEY.slice(1))).toBeNull();
    expect(normalizeRecoveryKey(`O${KEY.slice(1)}`)).toBeNull();
    expect(normalizeRecoveryKey(`1${KEY.slice(1)}`)).toBeNull();
    expect(normalizeRecoveryKey("")).toBeNull();
  });
});
