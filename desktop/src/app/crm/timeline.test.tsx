import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock } from "../../api/wsMock";
import { getState } from "../../state/store";
import { App } from "../App";

afterEach(cleanup);
beforeEach(() => resetWsMock());

describe("лента клиента", () => {
  it("в ленте компании — её заметки и события, а также смены этапов и заметки её сделок; фильтр по видам", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    await waitFor(() => expect(getState().ws).not.toBeNull());
    const company = (await api.wsList("companies")).items.find((c) => c.name === "ООО «Северный ветер»")!;
    const deal = (await api.wsList("deals")).items.find((d) => d.company_id === company.id)!;
    const stages = (await api.wsList("pipeline_stages", { sort: [{ field: "position", dir: "asc" }] })).items;
    await api.wsSave("deals", deal.id, { stage_id: stages[3]!.id });
    await api.wsSave("notes", null, { entity_type: "deal", entity_id: deal.id, body: "Согласовали смету по сделке" });

    fireEvent.click(within(screen.getByRole("navigation", { name: "Модули" })).getByRole("button", { name: /^CRM/ }));
    fireEvent.click(await within(screen.getByLabelText("Навигация")).findByText("Все клиенты"));
    fireEvent.click(await screen.findByText("ООО «Северный ветер»"));
    const card = await screen.findByLabelText("Карточка записи");
    fireEvent.click(within(card).getByRole("tab", { name: "Лента" }));
    const feed = await within(card).findByRole("list", { name: "Лента" });
    expect(await within(feed).findByText("Согласовали смету по сделке")).toBeInTheDocument();
    expect(within(feed).getByText(`${String(stages[2]!.name)} → ${String(stages[3]!.name)}`)).toBeInTheDocument();
    expect(within(feed).getAllByText(/^Сделка: /).length).toBeGreaterThan(0);
    expect(within(feed).getByText("Нашли на FL.ru, просили смету до пятницы.")).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("tab", { name: "Этапы" }));
    await waitFor(() => expect(within(feed).queryByText("Нашли на FL.ru, просили смету до пятницы.")).toBeNull());
    expect(within(feed).getByText(`${String(stages[2]!.name)} → ${String(stages[3]!.name)}`)).toBeInTheDocument();
  });
});
