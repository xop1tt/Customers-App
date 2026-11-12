import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetWsMock } from "../api/wsMock";
import { saveAi } from "../state/hub";
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

  it("в рейке нет «Настроек»: внизу кнопка «Ai», а настройки открываются из меню аккаунта", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    expect(within(rail()).queryByRole("button", { name: "Настройки" })).toBeNull();
    const buttons = within(rail()).getAllByRole("button");
    expect(buttons.at(-1)).toHaveAccessibleName("Ai");
    fireEvent.click(await screen.findByLabelText("Учётная запись"));
    fireEvent.click(await screen.findByText("Настройки", { selector: ".menu-item" }));
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

  it("левая панель сворачивается растяжением и выдвигается обратно; кнопок сворачивания нет", async () => {
    Element.prototype.setPointerCapture = () => {};
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    const bar = document.querySelector("header.topbar") as HTMLElement;
    expect(within(bar).queryByRole("button", { name: /Свернуть|Показать панель/ })).toBeNull();
    const handle = () => document.querySelector(".resizer") as HTMLElement;
    expect(handle().className).not.toContain("collapsed");
    const drag = (from: number, to: number) => {
      fireEvent.pointerDown(handle(), { clientX: from, pointerId: 1 });
      fireEvent.pointerMove(handle(), { clientX: to, pointerId: 1 });
      fireEvent.pointerUp(handle(), { clientX: to, pointerId: 1 });
    };
    drag(260, 40);
    await waitFor(() => expect(getState().device.navOpen).toBe(false));
    expect(screen.queryByLabelText("Навигация")).toBeNull();
    expect(handle().className).toContain("collapsed");
    drag(0, 300);
    await waitFor(() => expect(getState().device.navOpen).toBe(true));
    expect(nav).toBeDefined();
    expect(getState().device.navWidth).toBeGreaterThanOrEqual(200);
  });

  it("значок Ai есть по умолчанию; выключатель помощника убирает его из рейки", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    expect(within(rail()).getByRole("button", { name: "Ai" })).toBeInTheDocument();
    await act(async () => { await saveAi({ enabled: false }); });
    await waitFor(() => expect(within(rail()).queryByRole("button", { name: "Ai" })).toBeNull());
    await act(async () => { await saveAi({ enabled: true }); });
    await waitFor(() => expect(within(rail()).getByRole("button", { name: "Ai" })).toBeInTheDocument());
  });
});
