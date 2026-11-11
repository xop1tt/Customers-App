import { describe, expect, it } from "vitest";
import type { CrmRecord } from "../api/types";
import { forecast, IMPORT_SOURCE, MANUAL_SOURCE, monthly, sourceName, sources, team } from "./reports";

const P = "p1";
const now = new Date(2026, 10, 11, 15, 0); // 11 ноября 2026, местное время
const rec = (id: string, f: Record<string, unknown>): CrmRecord => ({ id, pipeline_id: P, deleted_at: null, ...f }) as unknown as CrmRecord;
const STAGES = [rec("new", { probability: 10 }), rec("offer", { probability: 60 }), rec("odd", { probability: 250 }), rec("won", { probability: 100, kind: "won" })];
const deal = (id: string, f: Record<string, unknown>) => rec(id, { status: "open", currency: "RUB", created_at: "2026-11-02T10:00:00Z", ...f });

describe("прогноз по сделкам", () => {
  it("раскладывает открытые сделки по месяцу ожидаемой даты и взвешивает вероятностью этапа", () => {
    const deals = [
      deal("a", { stage_id: "offer", amount: 100000, expected_close_date: "2026-11-30" }),
      deal("b", { stage_id: "new", amount: 50000, expected_close_date: "2026-11-11" }), // сегодня — ещё этот месяц
      deal("c", { stage_id: "offer", amount: 10000, expected_close_date: "2026-12-05" }),
      deal("d", { stage_id: "offer", amount: 20000, expected_close_date: "2027-01-31" }),
      deal("e", { stage_id: "offer", amount: 30000, expected_close_date: "2027-02-01" }),
      deal("f", { stage_id: "new", amount: 40000, expected_close_date: "2026-11-10" }), // вчера
      deal("g", { stage_id: "offer", amount: 1000 }), // без даты
      deal("h", { stage_id: "offer", expected_close_date: "2026-11-20" }), // без суммы
      deal("usd", { stage_id: "odd", amount: 100, currency: "USD", expected_close_date: "2026-11-20" }), // вероятность > 100 → 100
      deal("won", { stage_id: "won", status: "won", amount: 999, expected_close_date: "2026-11-20" }),
      deal("other", { pipeline_id: "p2", stage_id: "offer", amount: 999, expected_close_date: "2026-11-20" }),
      deal("del", { stage_id: "offer", amount: 999, expected_close_date: "2026-11-20", deleted_at: "2026-11-05T00:00:00Z" }),
    ];
    const f = forecast(deals, STAGES, P, now);
    const row = (b: string) => f.rows.find((r) => r.bucket === b)!;
    expect(f.rows.map((r) => r.bucket)).toEqual(["overdue", "m0", "m1", "m2", "later", "none"]);
    expect([row("m0").count, row("m0").sums, row("m0").weighted]).toEqual([4, [["RUB", 150000], ["USD", 100]], [["RUB", 65000], ["USD", 100]]]);
    expect(row("m0").month).toEqual(new Date(2026, 10, 1));
    expect([row("m1").count, row("m1").weighted]).toEqual([1, [["RUB", 6000]]]);
    expect([row("m2").count, row("m2").month]).toEqual([1, new Date(2027, 0, 1)]);
    expect([row("later").count, row("overdue").count, row("overdue").weighted, row("none").count]).toEqual([1, 1, [["RUB", 4000]], 1]);
    expect(f.weighted).toEqual([["RUB", 65000 + 6000 + 12000 + 18000 + 4000 + 600], ["USD", 100]]);
    expect(f.noAmount).toBe(1);
    // Без выбора воронки считаются все воронки.
    expect(forecast(deals, STAGES, null, now).rows.find((r) => r.bucket === "m0")!.count).toBe(5);
  });
});

describe("динамика по месяцам", () => {
  it("последние месяцы по порядку: создано по дате создания, выиграно и проиграно по дате закрытия", () => {
    const deals = [
      deal("a", { created_at: "2026-11-03T10:00:00Z" }),
      deal("b", { created_at: "2026-10-20T10:00:00Z", status: "won", closed_at: "2026-11-05T10:00:00Z", amount: 5000 }),
      deal("c", { created_at: "2026-09-01T10:00:00Z", status: "lost", closed_at: "2026-10-01T10:00:00Z" }),
      deal("old", { created_at: "2025-01-01T10:00:00Z", status: "won", closed_at: "2025-02-01T10:00:00Z" }),
    ];
    const m = monthly(deals, P, now, 3);
    expect(m.map((r) => r.month)).toEqual([new Date(2026, 8, 1), new Date(2026, 9, 1), new Date(2026, 10, 1)]);
    expect(m.map((r) => [r.created, r.won, r.lost])).toEqual([[1, 0, 0], [1, 0, 1], [1, 1, 0]]);
    expect(m[2]!.wonSums).toEqual([["RUB", 5000]]);
  });
});

describe("источники клиентов", () => {
  it("читаемые имена источников", () => {
    expect([sourceName(""), sourceName(null), sourceName("import:clients.xlsx"), sourceName("leadgen:telegram"), sourceName("Выставка")])
      .toEqual([MANUAL_SOURCE, MANUAL_SOURCE, IMPORT_SOURCE, "Поиск клиентов · telegram", "Выставка"]);
  });

  it("новые клиенты периода и выигранные сделки по источнику клиента", () => {
    const from = new Date(2026, 10, 1);
    const companies = [
      rec("c1", { source: "import:a.csv", created_at: "2026-11-02T10:00:00Z" }),
      rec("c2", { source: "import:b.xlsx", created_at: "2026-11-03T10:00:00Z" }),
      rec("c3", { source: "leadgen:rss", created_at: "2026-11-04T10:00:00Z" }),
      rec("c4", { source: null, created_at: "2026-01-01T10:00:00Z" }), // старый клиент, но сделка выиграна в периоде
      rec("gone", { source: "leadgen:rss", created_at: "2026-11-04T10:00:00Z", deleted_at: "2026-11-05T10:00:00Z" }),
    ];
    const deals = [
      deal("w1", { company_id: "c4", status: "won", closed_at: "2026-11-06T10:00:00Z", amount: 7000 }),
      deal("w2", { company_id: null, status: "won", closed_at: "2026-11-06T10:00:00Z", amount: 1000 }),
      deal("w3", { company_id: "c3", status: "won", closed_at: "2026-10-06T10:00:00Z" }), // вне периода
    ];
    expect(sources(companies, deals, P, from)).toEqual([
      { source: IMPORT_SOURCE, clients: 2, won: 0, wonSums: [] },
      { source: "Поиск клиентов · rss", clients: 1, won: 0, wonSums: [] },
      { source: "Без клиента", clients: 0, won: 1, wonSums: [["RUB", 1000]] },
      { source: MANUAL_SOURCE, clients: 0, won: 1, wonSums: [["RUB", 7000]] },
    ]);
  });
});

describe("показатели сотрудников", () => {
  it("сделки по ответственному, задачи по исполнителю, события по автору", () => {
    const from = new Date(2026, 10, 1);
    const deals = [
      deal("a", { owner_id: "anna" }),
      deal("b", { owner_id: "anna", status: "won", closed_at: "2026-11-05T10:00:00Z" }),
      deal("c", { owner_id: "boris", status: "lost", closed_at: "2026-11-05T10:00:00Z" }),
    ];
    const tasks = [
      rec("t1", { assignee_id: "anna", status: "done", completed_at: "2026-11-04T10:00:00Z" }),
      rec("t2", { assignee_id: "anna", status: "done", completed_at: "2026-10-04T10:00:00Z" }), // вне периода
      rec("t3", { assignee_id: "vera", status: "todo", due_at: "2026-11-10T10:00:00Z" }), // просрочена
      rec("t4", { assignee_id: "vera", status: "cancelled", due_at: "2026-11-10T10:00:00Z" }),
      rec("t5", { assignee_id: null, status: "todo", due_at: "2026-11-01T10:00:00Z" }),
    ];
    const activities = [
      rec("x1", { created_by: "boris", type: "call", occurred_at: "2026-11-06T10:00:00Z" }),
      rec("x2", { created_by: "boris", type: "system", occurred_at: "2026-11-06T10:00:00Z" }),
      rec("x3", { created_by: "boris", type: "meeting", occurred_at: "2026-10-06T10:00:00Z" }),
    ];
    const rows = team(deals, tasks, activities, P, from, now);
    const by = (o: string | null) => rows.find((r) => r.owner === o)!;
    expect(rows[0]!.owner).toBe("anna");
    expect([by("anna").open, by("anna").won, by("anna").winRate, by("anna").tasksDone]).toEqual([1, 1, 1, 1]);
    expect([by("boris").lost, by("boris").winRate, by("boris").activities]).toEqual([1, 0, 1]);
    expect([by("vera").overdue, by("vera").open]).toEqual([1, 0]);
    expect(by(null).overdue).toBe(1);
    expect(rows.at(-1)!.owner).toBeNull();
  });
});
