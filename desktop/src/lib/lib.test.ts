import { describe, expect, it } from "vitest";
import { bytes, fullRu, intervalTitle, plural, shortRelative } from "./format";
import { HIDE_DELAY, HoverReveal, SHOW_DELAY } from "./hoverReveal";
import { evaluate, explanation } from "./powerPolicy";
import { CONFIGURABLE, move, ordered, toggled } from "./sidebarPrefs";
import { addAll, feedUrl, isPublicHttpUrl, keyword, split, telegramChannel, vkCommunity } from "./sourceInput";
import { applyRegion, back, canSkip, finish, isLast, newFlow, next, regionName, skip, stateOf, stepOf } from "./welcomeFlow";

describe("боковая панель", () => {
  it("упорядочивает элементы по сохранённому порядку", () => {
    expect(ordered(["a", "b", "c"], ["c", "x", "a"])).toEqual(["c", "a", "b"]);
    expect(ordered(["a", "b"], [])).toEqual(["a", "b"]);
  });
  it("переставляет элементы", () => {
    expect(move(["a", "b", "c", "d"], 0, 3)).toEqual(["b", "c", "a", "d"]);
    expect(move(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(move(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
  it("скрывает и показывает", () => {
    expect(toggled([], "new", false)).toEqual(["new"]);
    expect(toggled(["new", "home"], "new", true)).toEqual(["home"]);
    expect(CONFIGURABLE).not.toContain("all");
  });
});

describe("выезжающая панель", () => {
  it("раскрывается после задержки и сворачивается после ухода", () => {
    const h = new HoverReveal();
    h.setEdge(true, 0);
    expect(h.tick(SHOW_DELAY - 0.01)).toBe(false);
    expect(h.tick(SHOW_DELAY + 0.001)).toBe(true);
    expect(h.revealed).toBe(true);
    h.setEdge(false, 1);
    h.setPanel(true, 1);
    h.setPanel(false, 2);
    expect(h.tick(2 + HIDE_DELAY - 0.01)).toBe(false);
    expect(h.tick(2 + HIDE_DELAY + 0.001)).toBe(true);
    expect(h.revealed).toBe(false);
  });
  it("не сворачивается, пока открыто окно из панели", () => {
    const h = new HoverReveal();
    h.setEdge(true, 0);
    h.tick(1);
    h.setBusy(true, 1);
    h.setEdge(false, 1);
    expect(h.tick(10)).toBe(false);
    h.setBusy(false, 10);
    expect(h.nextDelay(10)).toBeCloseTo(HIDE_DELAY);
    expect(h.tick(10 + HIDE_DELAY + 0.001)).toBe(true);
  });
  it("быстрый проход мимо края ничего не открывает", () => {
    const h = new HoverReveal();
    h.setEdge(true, 0);
    h.setEdge(false, 0.05);
    expect(h.tick(1)).toBe(false);
    expect(h.nextDelay(1)).toBeNull();
  });
});

describe("облегчённый режим", () => {
  it("включается по энергосбережению и по низкому заряду", () => {
    expect(evaluate({ systemSaver: true, batteryPercent: null, charging: null }, true, 20)).toEqual({ kind: "systemSaver" });
    expect(evaluate({ systemSaver: false, batteryPercent: 15, charging: false }, true, 20)).toEqual({ kind: "lowBattery", percent: 15, threshold: 20 });
    expect(evaluate({ systemSaver: false, batteryPercent: 15, charging: true }, true, 20)).toBeNull();
    expect(evaluate({ systemSaver: true, batteryPercent: 5, charging: false }, false, 20)).toBeNull();
    expect(evaluate({ systemSaver: false, batteryPercent: 49, charging: false }, true, 999)).toEqual({ kind: "lowBattery", percent: 49, threshold: 50 });
  });
  it("объясняет причину", () => {
    expect(explanation({ kind: "lowBattery", percent: 12, threshold: 20 })).toContain("12%");
  });
});

describe("мастер первого запуска", () => {
  it("идёт по шагам, пропускает и завершается на последнем", () => {
    let f = newFlow();
    expect(stepOf(f).id).toBe("intro");
    expect(canSkip(f)).toBe(false);
    f = skip(f); // intro нельзя пропустить: это обычное «Далее»
    expect(f.skipped).toEqual([]);
    expect(stepOf(f).id).toBe("sources");
    f = skip(f);
    expect(f.skipped).toEqual(["sources"]);
    f = back(f);
    f = next(f);
    expect(f.skipped).toEqual([]);
    f = next(next(next(f)));
    expect(isLast(f)).toBe(true);
    expect(canSkip(f)).toBe(false);
    expect(next(f).finished).toBe(true);
    expect(finish(newFlow()).finished).toBe(true);
    expect(stateOf(skip(next(newFlow())), "sources", false)).toBe("skipped");
    expect(stateOf(newFlow(), "sources", true)).toBe("configured");
  });
  it("подсказывает регион без служебных слов", () => {
    expect(regionName("город Казань")).toBe("Казань");
    expect(regionName(null, "Казань городской округ")).toBe("Казань");
    expect(regionName("", "", "Республика Татарстан")).toBe("Республика Татарстан");
    expect(regionName(null, null, null)).toBeNull();
    expect(applyRegion("Казань", [])).toEqual(["Казань"]);
    expect(applyRegion("Казань", ["Москва"])).toEqual(["Москва"]);
  });
});

describe("ввод источников", () => {
  it("разбирает каналы Telegram и сообщества VK", () => {
    expect(telegramChannel("https://t.me/s/freetasks?before=2")).toBe("freetasks");
    expect(telegramChannel("@teleworko")).toBe("teleworko");
    expect(telegramChannel("ab")).toBeNull();
    expect(vkCommunity("https://vk.com/club_dev/")).toBe("club_dev");
    expect(vkCommunity("vk.ru/some.name")).toBe("some.name");
    expect(vkCommunity("!!")).toBeNull();
  });
  it("принимает только публичные адреса лент", () => {
    expect(feedUrl("fl.ru/rss/all.xml")).toBe("https://fl.ru/rss/all.xml");
    expect(feedUrl("http://localhost/feed")).toBeNull();
    expect(feedUrl("https://192.168.1.5/rss")).toBeNull();
    expect(feedUrl("https://172.20.0.1/rss")).toBeNull();
    expect(isPublicHttpUrl("ftp://site.ru")).toBe(false);
    expect(isPublicHttpUrl("https://site")).toBe(false);
  });
  it("разбивает списки и пропускает повторы", () => {
    expect(split("а, б;в\nг")).toEqual(["а", "б", "в", "г"]);
    expect(keyword("  Сайт ")).toBe("сайт");
    const r = addAll(["сайт"], "Сайт, бот, , ", keyword);
    expect(r.items).toEqual(["сайт", "бот"]);
    const bad = addAll([], "t.me/ab, @freetasks", telegramChannel);
    expect(bad).toEqual({ items: ["freetasks"], rejected: ["t.me/ab"] });
  });
});

describe("форматы", () => {
  const now = new Date(2026, 10, 5, 15, 0, 0);
  it("пишет даты по-русски", () => {
    expect(shortRelative(new Date(2026, 10, 5, 9, 4).toISOString(), now)).toBe("09:04");
    expect(shortRelative(new Date(2026, 10, 4, 9, 4).toISOString(), now)).toBe("Вчера, 09:04");
    expect(shortRelative(new Date(2026, 9, 3, 9, 4).toISOString(), now)).toBe("3 окт.");
    expect(shortRelative(new Date(2025, 9, 3, 9, 4).toISOString(), now)).toBe("3 окт. 2025");
    expect(shortRelative(null, now)).toBe("—");
    expect(fullRu(new Date(2026, 10, 5, 9, 42).toISOString())).toBe("5 ноября 2026, 09:42");
  });
  it("пишет размеры, интервалы и склонения", () => {
    expect(bytes(512)).toBe("512 Б");
    expect(bytes(1536)).toBe("1,5 КБ");
    expect(bytes(150 * 1024 * 1024)).toBe("150 МБ");
    expect(intervalTitle(1)).toBe("Каждый час");
    expect(intervalTitle(3)).toBe("Каждые 3 ч");
    expect(intervalTitle(24)).toBe("Раз в сутки");
    expect(intervalTitle(120)).toBe("Раз в 5 дн.");
    expect([1, 2, 5, 11, 21, 24].map((n) => plural(n, "лид", "лида", "лидов"))).toEqual(["лид", "лида", "лидов", "лидов", "лид", "лида"]);
  });
});
