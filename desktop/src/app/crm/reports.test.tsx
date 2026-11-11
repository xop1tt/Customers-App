import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock } from "../../api/wsMock";
import { setState } from "../../state/store";
import { money } from "../../lib/format";
import { forecast } from "../../lib/reports";
import { ReportsPage } from "./ReportsPage";

afterEach(cleanup);
beforeEach(async () => {
  resetWsMock();
  setState({ ws: await api.wsState() });
});

describe("экран «Отчёты»", () => {
  it("показывает воронку по истории этапов, выигрыш, конверсию и причины проигрыша", async () => {
    const stages = (await api.wsList("pipeline_stages", { sort: [{ field: "position", dir: "asc" }] })).items;
    const [first, second] = stages;
    const won = stages.find((s) => s.kind === "won")!;
    const lost = stages.find((s) => s.kind === "lost")!;
    const base = { pipeline_id: first!.pipeline_id, currency: "RUB" };
    const a = await api.wsSave("deals", null, { ...base, title: "Выиграем", stage_id: first!.id, amount: 1000 });
    await api.wsSave("deals", a.id, { stage_id: second!.id });
    await api.wsSave("deals", a.id, { stage_id: won.id });
    const b = await api.wsSave("deals", null, { ...base, title: "Проиграем", stage_id: first!.id });
    await api.wsSave("deals", b.id, { stage_id: lost.id, lost_reason: "Выбрали конкурента" });

    const history = await api.wsStageHistory();
    expect(history.filter((x) => x.deal_id === a.id).map((x) => [x.from_stage_id, x.to_stage_id])).toEqual([[first!.id, second!.id], [second!.id, won.id]]);

    render(<ReportsPage />);
    const funnel = await screen.findByRole("region", { name: "Воронка" });
    const rows = within(funnel).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent(String(first!.name));
    expect(within(rows[1]!).getByText(String(second!.name))).toBeTruthy();
    expect(rows.at(-1)).toHaveTextContent(String(won.name));

    const stats = screen.getByRole("list", { name: "Итоги периода" });
    expect(within(stats).getByRole("listitem", { name: "Конверсия в успех" })).toHaveTextContent(/\d+ %/);
    expect(within(stats).getByRole("listitem", { name: "Выиграно" })).toHaveTextContent(/₽/);
    expect(within(screen.getByRole("region", { name: "Причины проигрыша" })).getByText("Выбрали конкурента")).toBeTruthy();
    expect(screen.getByRole("region", { name: "По ответственным" })).toBeTruthy();
  });

  it("прогноз, динамика, источники и показатели сотрудников (G3)", async () => {
    const stages = (await api.wsList("pipeline_stages", { sort: [{ field: "position", dir: "asc" }] })).items;
    const offer = stages.find((s) => s.kind === "open" && Number(s.probability) > 0)!;
    const today = new Date();
    const inMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10); // последний день месяца
    await api.wsSave("deals", null, { title: "Прогнозная", pipeline_id: offer.pipeline_id, stage_id: offer.id, amount: 200000, currency: "RUB", expected_close_date: inMonth });
    await api.wsSave("companies", null, { name: "Из таблицы", source: "import:клиенты.xlsx" });
    await api.wsSave("tasks", null, { title: "Сделано", status: "done", assignee_id: (await api.wsState()).me });

    render(<ReportsPage />);
    const fc = await screen.findByRole("region", { name: "Прогноз" });
    const deals = (await api.wsList("deals", { limit: 5000 })).items;
    const m0 = forecast(deals, stages, String(offer.pipeline_id)).rows.find((r) => r.bucket === "m0")!;
    expect(m0.count).toBeGreaterThan(0);
    const rub = m0.weighted.find(([cur]) => cur === "RUB")![1];
    expect(rub).toBeGreaterThanOrEqual(200000 * Number(offer.probability) / 100);
    expect(within(screen.getByRole("list", { name: "Итоги периода" })).getByRole("listitem", { name: "Прогноз на этот месяц" }).textContent!.replace(/\s/gu, " ")).toContain(money(rub, "RUB").replace(/\s/gu, " "));
    expect(within(fc).getByText("Всего ожидается")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Динамика по месяцам" })).getAllByRole("row")).toHaveLength(7);
    expect(within(screen.getByRole("region", { name: "Источники клиентов" })).getByText("Импорт из таблиц")).toBeTruthy();
    const staff = screen.getByRole("region", { name: "По ответственным" });
    expect(within(staff).getByRole("columnheader", { name: "Задачи" })).toBeTruthy();
    expect(within(staff).getByText("Анна").closest("tr")!.textContent).toMatch(/1/);
  });
});
