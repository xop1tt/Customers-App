import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock } from "../../api/wsMock";
import { setState } from "../../state/store";
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
});
