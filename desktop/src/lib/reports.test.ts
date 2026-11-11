import { describe, expect, it } from "vitest";
import type { CrmRecord, StageChange } from "../api/types";
import { byOwner, funnel, lostReasons, NO_REASON, percent, periodStart, sums, summary } from "./reports";

const P = "p1";
const st = (id: string, position: number, kind = "open"): CrmRecord => ({ id, pipeline_id: P, position, kind, name: id }) as unknown as CrmRecord;
const STAGES = [st("new", 1), st("qual", 2), st("offer", 3), st("won", 4, "won"), st("lost", 5, "lost")];
const deal = (id: string, f: Partial<CrmRecord>): CrmRecord => ({ id, pipeline_id: P, created_at: "2026-11-02T10:00:00Z", status: "open", deleted_at: null, ...f }) as unknown as CrmRecord;
const h = (deal_id: string, from: string | null, to: string): StageChange => ({ deal_id, from_stage_id: from, to_stage_id: to, changed_at: "2026-11-03T10:00:00Z" });

describe("отчёты: период", () => {
  it("начало месяца, квартала и года по местному времени; всё время — без границы", () => {
    const now = new Date(2026, 10, 11, 15, 0);
    expect(periodStart("month", now)).toEqual(new Date(2026, 10, 1));
    expect(periodStart("quarter", now)).toEqual(new Date(2026, 9, 1));
    expect(periodStart("quarter", new Date(2026, 2, 31))).toEqual(new Date(2026, 0, 1));
    expect(periodStart("year", now)).toEqual(new Date(2026, 0, 1));
    expect(periodStart("all", now)).toBeNull();
  });
});

describe("отчёты: воронка", () => {
  it("считает дошедших до этапа по истории, выигранные проходят все этапы, проигранные — до этапа проигрыша", () => {
    const deals = [
      deal("a", { stage_id: "new" }),
      deal("b", { stage_id: "offer" }), // сразу создана на третьем этапе
      deal("c", { stage_id: "lost", status: "lost" }), // проиграна со второго этапа
      deal("d", { stage_id: "won", status: "won" }),
      deal("old", { stage_id: "won", status: "won", created_at: "2026-09-01T00:00:00Z" }), // вне периода
      deal("del", { stage_id: "offer", deleted_at: "2026-11-05T00:00:00Z" }),
      deal("other", { stage_id: "x", pipeline_id: "p2" }),
    ];
    const history = [h("c", null, "new"), h("c", "new", "qual"), h("c", "qual", "lost")];
    const steps = funnel(STAGES, deals, history, P, new Date(2026, 10, 1));
    expect(steps.map((s) => [s.stage.id, s.reached])).toEqual([["new", 4], ["qual", 3], ["offer", 2], ["won", 1]]);
    expect(steps[0]!.fromPrev).toBeNull();
    expect(steps[1]!.fromPrev).toBeCloseTo(0.75);
    expect(steps[3]!.fromFirst).toBeCloseTo(0.25);
  });

  it("пустая воронка не делит на ноль", () => {
    const steps = funnel(STAGES, [], [], P, null);
    expect(steps.every((s) => s.reached === 0 && s.fromFirst === 0)).toBe(true);
    expect(steps[1]!.fromPrev).toBe(0);
  });
});

describe("отчёты: итоги", () => {
  const deals = [
    deal("w1", { status: "won", amount: 100, currency: "RUB", created_at: "2026-11-01T00:00:00Z", closed_at: "2026-11-11T00:00:00Z", owner_id: "u1" }),
    deal("w2", { status: "won", amount: 50, currency: "USD", created_at: "2026-10-20T00:00:00Z", closed_at: "2026-11-09T00:00:00Z", owner_id: "u2" }),
    deal("l1", { status: "lost", lost_reason: "Дорого", closed_at: "2026-11-05T00:00:00Z", owner_id: "u2" }),
    deal("l2", { status: "lost", lost_reason: " дорого ", closed_at: "2026-11-06T00:00:00Z", owner_id: "u2" }),
    deal("l3", { status: "lost", lost_reason: null, closed_at: "2026-11-07T00:00:00Z" }),
    deal("lOld", { status: "lost", lost_reason: "Сроки", closed_at: "2026-08-01T00:00:00Z" }),
    deal("o1", { status: "open", amount: 300, currency: "RUB", owner_id: "u1" }),
  ];
  const from = new Date("2026-11-01T00:00:00Z");

  it("выигранные и проигранные — по дате закрытия, суммы по валютам, конверсия и средний цикл", () => {
    const s = summary(deals, P, from);
    expect([s.won, s.lost, s.open]).toEqual([2, 3, 1]);
    expect(s.wonSums).toEqual([["RUB", 100], ["USD", 50]]);
    expect(s.winRate).toBeCloseTo(0.4);
    expect(s.cycleDays).toBeCloseTo(15);
    expect(s.openSums).toEqual([["RUB", 300]]);
    expect(summary([], P, from)).toMatchObject({ winRate: null, cycleDays: null, wonSums: [] });
  });

  it("причины проигрыша объединяются без учёта регистра и пробелов, пустая — «не указана»", () => {
    expect(lostReasons(deals, P, from)).toEqual([{ reason: "Дорого", count: 2 }, { reason: NO_REASON, count: 1 }]);
  });

  it("итоги по ответственным: сначала больше выигравшие, без ответственного — отдельной строкой", () => {
    const rows = byOwner(deals, P, from);
    expect(rows.map((r) => [r.owner, r.open, r.won, r.lost])).toEqual([["u1", 1, 1, 0], ["u2", 0, 1, 2], [null, 0, 0, 1]]);
    expect(rows[1]!.winRate).toBeCloseTo(1 / 3);
  });

  it("форматирование", () => {
    expect(percent(0.4567)).toBe("46 %");
    expect(percent(null)).toBe("—");
    expect(sums([deal("x", { amount: 5 }), deal("y", {})])).toEqual([["RUB", 5]]);
  });
});
