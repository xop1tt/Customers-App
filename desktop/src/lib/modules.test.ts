import { describe, expect, it } from "vitest";
import { SECTIONS, type SectionId } from "./leads";
import { MODULES, moduleOf, RESTORABLE } from "./modules";

describe("модули рейки", () => {
  it("каждый раздел принадлежит ровно одному модулю, домашний раздел модуля — его собственный", () => {
    for (const id of Object.keys(SECTIONS) as SectionId[]) expect(MODULES.map((m) => m.id)).toContain(moduleOf(id));
    for (const m of MODULES) expect(moduleOf(m.home)).toBe(m.id);
    expect(moduleOf("collection")).toBe("crm");
    expect(moduleOf("profile")).toBe("team");
    expect(moduleOf("sources")).toBe("search");
  });
  it("восстанавливаются только разделы без обязательного выбора", () => {
    expect(RESTORABLE).toContain("today");
    expect(RESTORABLE).not.toContain("collection");
    expect(RESTORABLE).not.toContain("profile");
  });
});
