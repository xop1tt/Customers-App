import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetWsMock } from "../api/wsMock";
import { getState, setState } from "../state/store";
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
    await waitFor(() => expect(getState().section).toBe("people"));
    // «Сообщения» — отдельный модуль рейки со своей панелью.
    fireEvent.click(mod(/^Сообщения/));
    await waitFor(() => expect(getState().section).toBe("chat"));
    expect(mod(/^Сообщения/)).toHaveAttribute("aria-current", "page");
  });

  it("настройки открываются из рейки", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    fireEvent.click(within(rail()).getByRole("button", { name: "Настройки" }));
    expect(await screen.findByRole("dialog", { name: "Настройки" })).toBeInTheDocument();
  });
});

describe("панель разделов", () => {
  it("«Настроить панель» у каждой вкладки своя: поиск показывает свои разделы, CRM — свои коллекции", async () => {
    setState({ customizeNav: false });
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    await waitFor(() => expect(getState().ws).not.toBeNull());
    fireEvent.click(mod(/^Поиск клиентов/));
    await waitFor(() => expect(mod(/^Поиск клиентов/)).toHaveAttribute("aria-current", "page"));
    fireEvent.click(within(nav).getByRole("button", { name: "Настроить панель" }));
    expect(await within(nav).findByText("Настройка: Поиск клиентов")).toBeInTheDocument();
    expect(within(nav).getByText("Все лиды")).toBeInTheDocument();
    expect(within(nav).queryByText("Все клиенты")).toBeNull();

    // Смена вкладки закрывает режим настройки; в CRM настраиваются только коллекции.
    fireEvent.click(mod(/^CRM/));
    await waitFor(() => expect(getState().customizeNav).toBe(false));
    fireEvent.click(within(nav).getByRole("button", { name: "Настроить панель" }));
    expect(await within(nav).findByText("Настройка: CRM")).toBeInTheDocument();
    expect(within(nav).queryByText("Все лиды")).toBeNull();
    expect(within(nav).queryByText("Избранное")).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: "Готово" }));

    // У «Сообщений» и «Команды» настраивать нечего: кнопки нет.
    fireEvent.click(mod(/^Сообщения/));
    await waitFor(() => expect(getState().section).toBe("chat"));
    expect(within(nav).queryByRole("button", { name: "Настроить панель" })).toBeNull();
  });

  it("кнопка свёртки левой панели стоит в верхней строке слева и работает и при открытой, и при скрытой панели", async () => {
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    const bar = document.querySelector("header.topbar") as HTMLElement;
    expect(within(nav).queryByRole("button", { name: "Свернуть панель" })).toBeNull();
    const first = bar.firstElementChild as HTMLElement;
    expect(first.getAttribute("aria-label")).toBe("Свернуть панель");
    fireEvent.click(first);
    await waitFor(() => expect(getState().device.navOpen).toBe(false));
    const again = (document.querySelector("header.topbar") as HTMLElement).firstElementChild as HTMLElement;
    expect(again.getAttribute("aria-label")).toBe("Показать панель");
    fireEvent.click(again);
    await waitFor(() => expect(getState().device.navOpen).toBe(true));
  });
});
