import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";

afterEach(cleanup);

describe("приложение с демо-бэкендом", () => {
  it("открывает главную, список лидов и сведения о лиде", async () => {
    render(<App />);
    fireEvent.click(within(await screen.findByLabelText("Навигация")).getByText("Главная"));
    await screen.findByText("Лучшие новые лиды");
    expect(screen.getByText("Все лиды", { selector: ".kpi-label" })).toBeInTheDocument();

    fireEvent.click(within(screen.getByLabelText("Навигация")).getByText("Все лиды"));
    const rows = await screen.findAllByRole("row");
    expect(rows.length).toBeGreaterThan(5);

    const row = screen.getAllByRole("row").find((r) => r.textContent?.includes("Студия красоты «Лаванда»")) as HTMLElement;
    fireEvent.click(row);
    const panel = await screen.findByLabelText("Сведения о лиде");
    expect(within(panel).getByText("Студия красоты «Лаванда»")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("tab", { name: "История" }));
    await within(panel).findByText("Найден");
  });

  it("настройки открываются и закрываются, разделы переключаются", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    fireEvent.click(screen.getByText("Настройки", { selector: ".side-tools span" }));
    const dialog = await screen.findByRole("dialog", { name: "Настройки" });
    expect(within(dialog).getByText("Акцентный цвет")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText("Исключения"));
    await within(dialog).findByText("example-spam.ru");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Настройки" })).toBeNull());
  });

  it("фильтр по тексту сокращает список", async () => {
    render(<App />);
    fireEvent.click(within(await screen.findByLabelText("Навигация")).getByText("Все лиды"));
    await screen.findAllByRole("row");
    fireEvent.change(screen.getByLabelText("Поиск по лидам"), { target: { value: "Лаванда" } });
    await waitFor(() => expect(screen.getAllByRole("row").filter((r) => r.className.includes("tr"))).toHaveLength(1));
  });
});
