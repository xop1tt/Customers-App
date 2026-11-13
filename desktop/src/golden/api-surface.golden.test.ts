// «Золотой» слепок публичного API: имена и арность экспортируемых функций каждого модуля.
// Исчезла или поменялась функция — тест упадёт. Намеренное изменение: `npm run golden:update`.
import { describe, expect, it } from "vitest";

const modules = import.meta.glob(["../lib/*.ts", "../state/*.ts", "../api/index.ts", "../api/mock.ts", "../api/wsMock.ts", "!../**/*.test.ts"], { eager: true }) as Record<string, Record<string, unknown>>;

function describeExport(value: unknown): string {
  if (typeof value === "function") {
    const isClass = /^class\s/.test(Function.prototype.toString.call(value));
    return `${isClass ? "class" : "function"}/${(value as (...a: unknown[]) => unknown).length}`;
  }
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (value && typeof value === "object") return `object{${Object.keys(value).sort().join(",")}}`;
  return typeof value;
}

describe("золотой слепок API", () => {
  for (const path of Object.keys(modules).sort()) {
    it(path.replace(/^\.\.\//, ""), () => {
      const mod = modules[path]!;
      const surface = Object.fromEntries(Object.keys(mod).sort().map((k) => [k, describeExport(mod[k])]));
      expect(surface).toMatchSnapshot();
    });
  }
});
