import { describe, expect, it } from "vitest";
import type { Lead } from "../api/types";
import { count, dailyCounts, emptyFilter, signals, sortLeads, subtitle, visibleLeads } from "./leads";

function lead(id: string, over: Partial<Lead> = {}, data: Partial<Lead["data"]> = {}): Lead {
  return {
    id,
    discoveredAt: "2026-11-05T09:00:00Z",
    favorite: false,
    archived: false,
    excluded: false,
    seen: true,
    note: "",
    phones: [],
    emails: [],
    data: { kind: "order", source: "fl_ru", external_id: id, title: `Лид ${id}`, url: "", description: "", contacts: {}, facts: [], assumptions: [], score: 50, relevance: "medium", score_reasons: [], status: "new", external_results: [], ...data },
    ...over,
  };
}

describe("разделы и фильтры", () => {
  const leads = [
    lead("a", {}, { score: 80 }),
    lead("b", { seen: false }, { score: 60 }),
    lead("c", { favorite: true }, { score: 20, relevance: "rejected" }),
    lead("d", { archived: true }),
    lead("e", { excluded: true }),
  ];

  it("считает лиды по разделам и прячет неподходящие", () => {
    expect(count(leads, "all", true)).toBe(2);
    expect(count(leads, "all", false)).toBe(3);
    expect(count(leads, "new", true)).toBe(1);
    expect(count(leads, "favorites", true)).toBe(0);
    expect(count(leads, "favorites", false)).toBe(1);
    expect(count(leads, "archive", true)).toBe(1);
    expect(count(leads, "excluded", true)).toBe(1);
  });

  it("фильтрует по типу, источнику, оценке и тексту", () => {
    const f = emptyFilter();
    expect(visibleLeads(leads, "all", f).map((l) => l.id)).toEqual(["a", "b"]);
    expect(visibleLeads(leads, "all", { ...f, minScore: 70 }).map((l) => l.id)).toEqual(["a"]);
    expect(visibleLeads(leads, "all", { ...f, kind: "organization" })).toEqual([]);
    expect(visibleLeads(leads, "all", { ...f, search: "ЛИД b" }).map((l) => l.id)).toEqual(["b"]);
    expect(visibleLeads(leads, "all", { ...f, source: "telegram_channels" })).toEqual([]);
  });

  it("ищет в заметке и контактах", () => {
    const l = lead("x", { note: "перезвонить во вторник" }, { contacts: { telegram: "@studio" } });
    expect(visibleLeads([l], "all", emptyFilter("вторник"))).toHaveLength(1);
    expect(visibleLeads([l], "all", emptyFilter("@STUDIO"))).toHaveLength(1);
    expect(visibleLeads([l], "all", emptyFilter("нет такого"))).toHaveLength(0);
  });

  it("сортирует по оценке и по названию стабильно", () => {
    expect(sortLeads(leads, "score", true).map((l) => l.id)).toEqual(["a", "b", "d", "e", "c"]);
    expect(sortLeads(leads, "title", false).map((l) => l.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("подписи", () => {
  it("собирает вторую строку", () => {
    expect(subtitle(lead("a", {}, { budget: 15000, address: "ул. Баумана, 44", region: "Казань" }))).toBe("15 000 ₽ · ул. Баумана, 44 · Казань");
    expect(subtitle(lead("a", {}, { description: "Нужен сайт" }))).toBe("Нужен сайт");
    expect(subtitle(lead("a", {}, { address: "Казань, ул. Баумана", region: "Казань" }))).toBe("Казань, ул. Баумана");
  });

  it("показывает не больше двух сигналов", () => {
    const org = lead("o", {}, { kind: "organization", facts: ["Сайт не открылся", "нет viewport", "HTTPS: нет"], external_results: [{ service: "x", ok: true }] });
    const s = signals(org);
    expect(s.map((x) => x.text)).toEqual(["Нет сайта", "Сайт не открылся"]);
    expect(signals(lead("p", {}, { budget: 1000, score_reasons: ["явный запрос", "срочно"] })).map((x) => x.text)).toEqual(["Бюджет", "Явный запрос"]);
  });
});

describe("график", () => {
  it("раскладывает лиды по дням", () => {
    const now = new Date(2026, 10, 5, 12, 0, 0);
    const a = lead("a", { discoveredAt: new Date(2026, 10, 5, 8, 0, 0).toISOString() }, { kind: "organization" });
    const b = lead("b", { discoveredAt: new Date(2026, 10, 4, 23, 0, 0).toISOString() });
    const points = dailyCounts([a, b], 14, now);
    expect(points).toHaveLength(14);
    expect(points[13]).toMatchObject({ organizations: 1, orders: 0 });
    expect(points[12]).toMatchObject({ organizations: 0, orders: 1 });
  });
});
