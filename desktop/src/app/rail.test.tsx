import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetWsMock } from "../api/wsMock";
import { getState } from "../state/store";
import { App } from "./App";

afterEach(cleanup);
beforeEach(() => resetWsMock());

const rail = () => screen.getByRole("navigation", { name: "Модули" });
const mod = (name: RegExp) => within(rail()).getByRole("button", { name });

describe("рейка модулей", () => {
  it("переключает модули и возвращает в последний открытый раздел модуля", async () => {
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    await waitFor(() => expect(getState().ws).not.toBeNull());
    expect(mod(/^Поиск клиентов/)).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(nav).getByText("Все лиды"));
    await waitFor(() => expect(getState().section).toBe("all"));

    fireEvent.click(await within(rail()).findByRole("button", { name: /^CRM/ }));
    await waitFor(() => expect(getState().section).toBe("today"));
    expect(mod(/^CRM/)).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByText("CRM", { selector: ".side-module" })).toBeInTheDocument();
    fireEvent.click(within(nav).getByRole("button", { name: "Сделки" }));
    await waitFor(() => expect(getState().section).toBe("deals"));

    fireEvent.click(mod(/^Поиск клиентов/));
    await waitFor(() => expect(getState().section).toBe("all"));
    fireEvent.click(mod(/^CRM/));
    await waitFor(() => expect(getState().section).toBe("deals"));
    fireEvent.click(mod(/^Команда/));
    await waitFor(() => expect(getState().section).toBe("chat"));
  });

  it("настройки открываются из рейки", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    fireEvent.click(within(rail()).getByRole("button", { name: "Настройки" }));
    expect(await screen.findByRole("dialog", { name: "Настройки" })).toBeInTheDocument();
  });
});
