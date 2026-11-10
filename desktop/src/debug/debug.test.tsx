import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../app/App";
import { getState, setState } from "../state/store";

afterEach(() => {
  setState({ debugOpen: false });
  cleanup();
});

async function ready(channel: "stable" | "beta") {
  render(<App />);
  await waitFor(() => expect(getState().phase).toBe("ready"));
  setState({ boot: { ...getState().boot!, channel } });
}

const shortcut = () => fireEvent.keyDown(document, { key: "D", shiftKey: true, ctrlKey: true, metaKey: true });

describe("Debug Menu", () => {
  it("в Stable нет ни пункта меню, ни сочетания клавиш", async () => {
    await ready("stable");
    fireEvent.click(screen.getByLabelText("Учётная запись"));
    expect(await screen.findByText("Настройки", { selector: ".menu-item" })).toBeTruthy();
    expect(screen.queryByText("Debug Menu", { selector: ".menu-item" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    shortcut();
    expect(getState().debugOpen).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Debug Menu" })).toBeNull();
  });

  it("в Beta открывается из меню учётной записи и сочетанием клавиш", async () => {
    await ready("beta");
    fireEvent.click(screen.getByLabelText("Учётная запись"));
    fireEvent.click(await screen.findByText("Debug Menu", { selector: ".menu-item" }));
    const dialog = await screen.findByRole("dialog", { name: "Debug Menu" });
    expect(await within(dialog).findByText("local.customers.beta")).toBeTruthy();
    shortcut();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Debug Menu" })).toBeNull());
    shortcut();
    expect(await screen.findByRole("dialog", { name: "Debug Menu" })).toBeTruthy();
  });

  it("сценарии запускаются и показывают итог", async () => {
    await ready("beta");
    setState({ debugOpen: true });
    const dialog = await screen.findByRole("dialog", { name: "Debug Menu" });
    fireEvent.click(within(dialog).getByRole("tab", { name: /Сценарии/ }));
    expect(await within(dialog).findByText("Первый запуск и создание базы")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Запустить все/ }));
    const summary = await within(dialog).findByLabelText("Итог");
    expect(summary.textContent).toContain("PASS 2");
    expect(summary.textContent).toContain("FAIL 0");
  });

  it("журнал фильтрует по уровню и тексту", async () => {
    await ready("beta");
    setState({ debugOpen: true });
    const dialog = await screen.findByRole("dialog", { name: "Debug Menu" });
    fireEvent.click(within(dialog).getByRole("tab", { name: /Журнал/ }));
    const log = await within(dialog).findByRole("log");
    await waitFor(() => expect(log.textContent).toContain("Запуск Customers Beta"));
    fireEvent.click(within(dialog).getByText("ERROR"));
    await waitFor(() => expect(log.textContent).toContain("Записей нет"));
  });
});
