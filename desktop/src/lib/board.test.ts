import { describe, expect, it } from "vitest";
import type { CrmRecord } from "../api/types";
import { boardColumns, canMove, todayGroups } from "./board";

const rec = (over: Partial<CrmRecord>): CrmRecord => ({ id: Math.random().toString(36), workspace_id: "w", version: 1, created_at: "", updated_at: "2026-11-10T10:00:00Z", created_by: "a", ...over });

describe("канбан сделок", () => {
  const stages = [rec({ id: "s2", pipeline_id: "p", position: 2 }), rec({ id: "s1", pipeline_id: "p", position: 1 }), rec({ id: "x", pipeline_id: "other", position: 1 })];
  it("строит колонки по порядку этапов и считает суммы по валютам", () => {
    const deals = [
      rec({ stage_id: "s1", amount: 100, currency: "RUB" }),
      rec({ stage_id: "s1", amount: 50 }),
      rec({ stage_id: "s1", amount: 10, currency: "USD" }),
      rec({ stage_id: "s1" }),
      rec({ stage_id: "s1", amount: 999, deleted_at: "2026-11-01T00:00:00Z" }),
      rec({ stage_id: "s2", amount: 5, archived_at: "2026-11-01T00:00:00Z" }),
    ];
    const cols = boardColumns(stages, deals, "p");
    expect(cols.map((c) => c.stage.id)).toEqual(["s1", "s2"]);
    expect(cols[0]!.deals).toHaveLength(4);
    expect(cols[0]!.totals).toEqual([["RUB", 150], ["USD", 10]]);
    expect(cols[1]!.deals).toHaveLength(0);
  });
  it("переносит только в другой этап той же воронки", () => {
    const d = rec({ stage_id: "s1", pipeline_id: "p" });
    expect(canMove(d, stages[0]!)).toBe(true);
    expect(canMove(d, stages[1]!)).toBe(false);
    expect(canMove(d, stages[2]!)).toBe(false);
  });
});

describe("экран «Сегодня»", () => {
  const now = new Date(2026, 10, 11, 12, 0);
  const at = (d: number, h: number) => new Date(2026, 10, d, h, 0).toISOString();
  it("делит открытые задачи на просроченные (срок прошёл) и оставшиеся на сегодня по местному времени", () => {
    const tasks = [
      rec({ title: "вчера", due_at: at(10, 18), status: "todo" }),
      rec({ title: "утром", due_at: at(11, 9), status: "in_progress" }),
      rec({ title: "вечером", due_at: at(11, 23), status: "todo" }),
      rec({ title: "завтра", due_at: at(12, 9), status: "todo" }),
      rec({ title: "готово", due_at: at(10, 9), status: "done" }),
      rec({ title: "без срока", status: "todo" }),
      rec({ title: "чужая", due_at: at(11, 10), status: "todo", assignee_id: "other" }),
    ];
    const g = todayGroups(tasks, [], now, "me");
    expect(g.overdue.map((t) => t.title)).toEqual(["вчера", "утром"]);
    expect(g.today.map((t) => t.title)).toEqual(["вечером"]);
    expect(todayGroups(tasks, [], now).today.map((t) => t.title)).toEqual(["вечером"]);
    expect(todayGroups(tasks, [], now).overdue.map((t) => t.title)).toEqual(["вчера", "утром", "чужая"]);
  });
  it("находит открытые сделки без движения 7 дней и дольше", () => {
    const deals = [
      rec({ title: "старая", status: "open", updated_at: at(1, 12) }),
      rec({ title: "неделя", status: "open", updated_at: at(4, 12) }),
      rec({ title: "свежая", status: "open", updated_at: at(9, 12) }),
      rec({ title: "выиграна", status: "won", updated_at: at(1, 12) }),
    ];
    expect(todayGroups([], deals, now).stale.map((x) => [x.deal.title, x.days])).toEqual([["старая", 10], ["неделя", 7]]);
  });
});
