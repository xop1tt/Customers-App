import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock } from "../../api/wsMock";
import { MenuHost } from "../../ui/overlay";
import { setState } from "../../state/store";
import { DealBoard } from "./DealBoard";
import { TodayPage } from "./TodayPage";

afterEach(cleanup);
beforeEach(async () => {
  resetWsMock();
  setState({ ws: await api.wsState() });
});

async function firstStages() {
  const stages = (await api.wsList("pipeline_stages", { sort: [{ field: "position", dir: "asc" }] })).items;
  return stages;
}

describe("канбан сделок", () => {
  it("показывает сделку в её этапе с суммой и переносит её в другой этап из меню", async () => {
    const stages = await firstStages();
    const deal = await api.wsSave("deals", null, { title: "Тестовая сделка", pipeline_id: stages[0]!.pipeline_id, stage_id: stages[0]!.id, amount: 70000, currency: "RUB" });
    render(<><DealBoard /><MenuHost /></>);
    const first = await screen.findByRole("listitem", { name: String(stages[0]!.name) });
    await within(first).findByText("Тестовая сделка");
    expect(within(first).getAllByText(/70\s?000 ₽/).length).toBeGreaterThan(0);
    fireEvent.click(within(first).getAllByRole("button", { name: "Сменить этап" })[0]!);
    fireEvent.click(within(await screen.findByRole("menuitem", { name: String(stages[1]!.name) })).getByRole("button"));
    const second = screen.getByRole("listitem", { name: String(stages[1]!.name) });
    await within(second).findByText("Тестовая сделка");
    expect((await api.wsCard("deals", deal.id)).record.stage_id).toBe(stages[1]!.id);
  });
});

describe("экран «Сегодня»", () => {
  it("показывает просроченную задачу и закрывает её отметкой", async () => {
    const t = await api.wsSave("tasks", null, { title: "Срочно позвонить", status: "todo", due_at: new Date(Date.now() - 2 * 86400_000).toISOString() });
    render(<TodayPage />);
    const overdue = await screen.findByRole("region", { name: "Просрочено" });
    await within(overdue).findByText("Срочно позвонить");
    fireEvent.click(within(overdue).getByLabelText(/Выполнено: Срочно позвонить/));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Просрочено" })).queryByText("Срочно позвонить")).toBeNull());
    expect((await api.wsCard("tasks", t.id)).record.status).toBe("done");
  });
});
