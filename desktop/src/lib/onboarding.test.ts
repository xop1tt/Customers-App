import { describe, expect, it } from "vitest";
import type { CrmRecord } from "../api/types";
import { PIPELINE_TEMPLATES, planStages, probabilities, showChecklist, startChecklist } from "./onboarding";

const stage = (id: string, position: number, kind = "open", pipeline_id = "p1"): CrmRecord => ({ id, name: id, position, kind, pipeline_id } as unknown as CrmRecord);
// Как воронка нового Workspace: пять открытых этапов, выигрыш и проигрыш (SEED_STAGES ядра).
const seed = [stage("a", 1), stage("b", 2), stage("c", 3), stage("d", 4), stage("e", 5), stage("won", 6, "won"), stage("lost", 7, "lost"), stage("other", 1, "open", "p2")];
const tpl = (id: string) => PIPELINE_TEMPLATES.find((t) => t.id === id)!;

describe("шаблоны воронки", () => {
  it("вероятности растут от 10 до 80 %", () => {
    expect(probabilities(5)).toEqual([10, 28, 45, 63, 80]);
    expect(probabilities(4)).toEqual([10, 33, 57, 80]);
    expect(probabilities(1)).toEqual([50]);
    expect(probabilities(0)).toEqual([]);
  });

  it("«Услуги»: пять этапов переименовываются по порядку, выигрыш получает своё название, проигрыш — в конце", () => {
    const plan = planStages(seed, "p1", tpl("services"));
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.update.map((u) => [u.id, u.patch.name ?? null, u.patch.position])).toEqual([
      ["a", "Новый", 1], ["b", "Квалификация", 2], ["c", "Предложение", 3], ["d", "Переговоры", 4], ["e", "Счёт", 5], ["won", "Успех", 6], ["lost", null, 7],
    ]);
    // Этапы другой воронки не затрагиваются.
    expect(plan.update.some((u) => u.id === "other")).toBe(false);
  });

  it("«Товары»: лишний открытый этап удаляется, вероятности по шаблону", () => {
    const plan = planStages(seed, "p1", tpl("goods"));
    expect(plan.remove).toEqual(["e"]);
    expect(plan.update.find((u) => u.id === "d")!.patch).toMatchObject({ name: "Отгрузка", probability: 80 });
    expect(plan.update.find((u) => u.id === "won")!.patch).toMatchObject({ name: "Получено", position: 5, probability: 100 });
  });

  it("недостающие этапы и этап выигрыша создаются в нужной воронке", () => {
    const plan = planStages([stage("a", 1), stage("lost", 2, "lost")], "p1", tpl("projects"));
    expect(plan.create.map((c) => [c.name, c.kind, c.pipeline_id])).toEqual([["Оценка", "open", "p1"], ["Договор", "open", "p1"], ["В работе", "open", "p1"], ["Сдано", "won", "p1"]]);
    expect(plan.update.find((u) => u.id === "lost")!.patch).toEqual({ position: 6 });
  });
});

describe("«Начало работы»", () => {
  const facts = { wizardDone: true, companies: 0, deals: 0, tasks: 0, backup: false };
  it("отмечает сделанное и исчезает, когда всё сделано или скрыто", () => {
    const items = startChecklist(facts);
    expect(items.map((i) => [i.id, i.done])).toEqual([["workspace", true], ["clients", false], ["deal", false], ["task", false], ["backup", false]]);
    expect(showChecklist(items, false)).toBe(true);
    expect(showChecklist(items, true)).toBe(false);
    const all = startChecklist({ wizardDone: true, companies: 3, deals: 1, tasks: 2, backup: true });
    expect(all.every((i) => i.done)).toBe(true);
    expect(showChecklist(all, false)).toBe(false);
  });
});
