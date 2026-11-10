import { afterEach, describe, expect, it } from "vitest";
import { resolveLanguage, setLanguage, t, translate } from "./i18n";
import { resolveTheme } from "./theme";
import { bytes, fullRu, integer } from "./format";

afterEach(() => setLanguage("ru"));

describe("язык", () => {
  it("выбор пользователя главнее языка системы", () => {
    expect(resolveLanguage("en", "ru-RU")).toBe("en");
    expect(resolveLanguage("ru", "en-US")).toBe("ru");
    expect(resolveLanguage("system", "ru-RU")).toBe("ru");
    expect(resolveLanguage("system", "de-DE")).toBe("en");
  });

  it("переводит точные строки, шаблоны и склонения", () => {
    expect(translate("Настройки")).not.toBeNull();
    expect(translate("Каждые 15 мин")).toBe("Every 15 min");
    expect(translate("Выбрано: 3 лида")).toBe("Selected: 3 leads");
    expect(translate("5 записей")).toBe("5 items");
    expect(translate("  Сбросить ")).toBe("  Reset ");
  });

  it("непереведённое остаётся русским, а не ломает экран", () => {
    expect(translate("Совсем новая строка без перевода")).toBeNull();
    expect(translate("English only")).toBeNull();
    setLanguage("en");
    expect(t("Совсем новая строка без перевода")).toBe("Совсем новая строка без перевода");
  });

  it("t() переводит только в английском режиме", () => {
    expect(t("Сбросить")).toBe("Сбросить");
    setLanguage("en");
    expect(t("Сбросить")).toBe("Reset");
  });

  it("страница переводится и возвращается обратно", async () => {
    document.body.innerHTML = `<button aria-label="Сбросить">Сбросить</button><p>Новый текст</p>`;
    setLanguage("en");
    expect(document.body.querySelector("button")?.textContent).toBe("Reset");
    expect(document.body.querySelector("button")?.getAttribute("aria-label")).toBe("Reset");
    // новые узлы тоже переводятся
    const p = document.createElement("span");
    p.textContent = "Сбросить";
    document.body.append(p);
    await Promise.resolve();
    expect(p.textContent).toBe("Reset");
    setLanguage("ru");
    expect(document.body.querySelector("button")?.textContent).toBe("Сбросить");
    expect(p.textContent).toBe("Сбросить");
  });

  it("даты, размеры и числа следуют языку", () => {
    const iso = "2026-11-05T09:42:00";
    expect(fullRu(iso)).toBe("5 ноября 2026, 09:42");
    expect(bytes(1536)).toBe("1,5 КБ");
    setLanguage("en");
    expect(fullRu(iso)).toBe("November 5, 2026, 09:42");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(integer(12345)).toBe("12,345");
  });
});

describe("тема", () => {
  it("«как в системе» берёт тему системы", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme(undefined, false)).toBe("light");
  });
});
