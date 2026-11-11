import { describe, expect, it } from "vitest";
import type { CrmRecord, WsCard } from "../api/types";
import { buildTimeline, filterTimeline, relatedForTimeline } from "./timeline";

const rec = (id: string, at: string, over: Partial<CrmRecord> = {}): CrmRecord => ({ id, workspace_id: "w", version: 1, created_at: at, updated_at: at, created_by: "u1", ...over });
const name = (id: string | null) => (id ? `этап ${id}` : "—");

describe("лента клиента", () => {
  const company: WsCard = {
    record: rec("c1", "2026-11-01T10:00:00Z", { name: "Альфа" }),
    notes: [rec("n1", "2026-11-03T10:00:00Z", { body: "Заметка о клиенте" }), rec("n2", "2026-11-04T10:00:00Z", { body: "удалена", deleted_at: "x" })],
    comments: [rec("m1", "2026-11-05T10:00:00Z", { body: "Коллеги, звоните после 12" })],
    activities: [rec("a1", "2026-11-02T00:00:00Z", { type: "call", summary: "Первый звонок", occurred_at: "2026-11-06T09:00:00Z" })],
    tasks: [rec("t1", "2026-11-02T12:00:00Z", { title: "Отправить КП", status: "done", completed_at: "2026-11-07T08:00:00Z" })],
    deals: [rec("d1", "2026-11-02T15:00:00Z", { title: "Сайт" })],
    conflicts: [],
  };
  const deal: WsCard = {
    record: rec("d1", "2026-11-02T15:00:00Z", { title: "Сайт" }),
    notes: [rec("n3", "2026-11-08T10:00:00Z", { body: "Согласовали смету" })],
    history: [{ from_stage_id: "s1", to_stage_id: "s2", changed_by: "u2", changed_at: "2026-11-09T10:00:00Z" }],
    conflicts: [],
  };

  it("собирает всё в одну ленту, новые сверху, с подписью источника", () => {
    const items = buildTimeline([{ card: company, source: null, table: "companies" }, { card: deal, source: "Сделка: Сайт", table: "deals" }], name);
    expect(items.map((i) => i.kind)).toEqual(["stage", "note", "task_done", "activity", "comment", "note", "created", "task", "created"]);
    expect(items[0]).toMatchObject({ text: "этап s1 → этап s2", source: "Сделка: Сайт", who: "u2", open: { table: "deals", id: "d1" } });
    expect(items.find((i) => i.kind === "activity")).toMatchObject({ label: "Звонок", at: "2026-11-06T09:00:00Z", source: null, open: null });
    expect(items.find((i) => i.kind === "task_done")?.open).toEqual({ table: "tasks", id: "t1" });
    expect(items.some((i) => i.text === "удалена")).toBe(false);
  });

  it("фильтрует по видам", () => {
    const items = buildTimeline([{ card: company, source: null, table: "companies" }, { card: deal, source: "Сделка: Сайт", table: "deals" }], name);
    expect(filterTimeline(items, "notes").map((i) => i.text)).toEqual(["Согласовали смету", "Коллеги, звоните после 12", "Заметка о клиенте"]);
    expect(filterTimeline(items, "tasks")).toHaveLength(2);
    expect(filterTimeline(items, "events")).toHaveLength(1);
    expect(filterTimeline(items, "stages").map((i) => i.kind)).toEqual(["stage", "created", "created"]);
    expect(filterTimeline(items, "all")).toHaveLength(items.length);
  });

  it("берёт в ленту компании живые сделки и контакты, не больше предела", () => {
    const card: WsCard = { record: rec("c", "2026-11-01T00:00:00Z"), conflicts: [],
      deals: [rec("d1", "2026-11-01T00:00:00Z"), rec("d2", "2026-11-05T00:00:00Z"), rec("d3", "2026-11-06T00:00:00Z", { deleted_at: "x" })],
      contacts: [rec("p1", "2026-11-02T00:00:00Z")] };
    expect(relatedForTimeline(card).map((x) => x.rec.id)).toEqual(["d2", "d1", "p1"]);
    expect(relatedForTimeline(card, 2)).toHaveLength(2);
  });
});
