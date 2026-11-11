// Ссылки-действия без href недоступны с клавиатуры (F-37): действие — это кнопка, переход — настоящий <a href>.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });

describe("доступность ссылок", () => {
  it("в интерфейсе нет <a> без href", () => {
    const bad = walk(join(__dirname, "..")).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/<a\b(?![^>]*\bhref=)[^>]*>/g)].map((m) => `${f}: ${m[0].slice(0, 60)}`),
    );
    expect(bad).toEqual([]);
  });

  it("уменьшенное движение учитывается в стилях", () => {
    expect(readFileSync(join(__dirname, "../styles/base.css"), "utf8")).toContain("prefers-reduced-motion");
  });
});
