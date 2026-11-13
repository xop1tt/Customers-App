// Глобальный поиск в шапке: выпадающий список, переходы, настройки «Система → Поиск» (ADR-088).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../api";
import { resetWsMock } from "../api/wsMock";
import { DEFAULT_GLOBAL_SEARCH, loadGlobalSearch, resetGlobalSearch, saveGlobalSearch } from "../lib/globalSearch";
import { getState, refreshSnapshot, setState } from "../state/store";
import { Settings } from "./settings/Settings";
import { TitleBar } from "./TitleBar";
import { TopBar } from "./TopBar";

afterEach(() => { cleanup(); resetGlobalSearch(); setState({ settings: null, settingsSub: null, selection: [], record: null }); });
beforeEach(async () => {
  resetWsMock(); resetGlobalSearch();
  setState({ ws: await api.wsState(), section: "today", phase: "ready" });
  await refreshSnapshot();
});

const box = () => screen.getByRole("combobox", { name: "Глобальный поиск" });

describe("поле глобального поиска", () => {
  it("поле поиска — в заголовке окна по центру, без названия; кнопки «Быстрый поиск» в верхней строке нет", () => {
    const { container } = render(<><TitleBar /><TopBar /></>);
    expect(screen.queryByRole("button", { name: "Быстрый поиск" })).toBeNull();
    const bar = container.querySelector(".titlebar") as HTMLElement;
    expect(within(bar).getByRole("combobox", { name: "Глобальный поиск" })).toBeInTheDocument();
    expect(bar.querySelector(".titlebar-center")).toContainElement(box());
    expect(bar).not.toHaveTextContent("Customers");
    expect(bar.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(container.querySelector("header.topbar .gsearch")).toBeNull();
  });

  it("кнопки окна: на Windows справа, на macOS «светофор» слева; вне приложения они ничего не делают", () => {
    setState({ boot: { platform: "windows" } as never });
    const { container, rerender } = render(<TitleBar />);
    expect(within(container.querySelector(".titlebar-win") as HTMLElement).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Свернуть окно", "Развернуть окно", "Закрыть окно"]);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть окно" }));
    setState({ boot: { platform: "macos" } as never });
    rerender(<TitleBar />);
    expect(container.querySelector(".titlebar-win")).toBeNull();
    expect(container.querySelector(".titlebar-side .titlebar-dots")).not.toBeNull();
    setState({ boot: null });
  });

  it("на экране входа поля поиска в заголовке нет", () => {
    setState({ phase: "auth" });
    render(<TitleBar />);
    expect(screen.queryByRole("combobox", { name: "Глобальный поиск" })).toBeNull();
  });

  it("результаты по группам в выпадающем списке: лиды и записи CRM; Enter открывает выбранное", async () => {
    render(<TitleBar />);
    fireEvent.change(box(), { target: { value: "Лаванда" } });
    const list = await screen.findByRole("listbox", { name: "Результаты поиска" });
    await waitFor(() => expect(within(list).getAllByRole("option").length).toBeGreaterThan(0));
    expect(within(list).getByText("Лиды")).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(getState().section).toBe("all"));
    expect(getState().selection).toHaveLength(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Esc закрывает список, пустой запрос списка не открывает", async () => {
    render(<TitleBar />);
    fireEvent.focus(box());
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box(), { target: { value: "Нов" } });
    await screen.findByRole("listbox");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("настройки поиска", () => {
  it("значения по умолчанию и сохранение", () => {
    expect(loadGlobalSearch()).toEqual(DEFAULT_GLOBAL_SEARCH);
    saveGlobalSearch({ leads: false, limit: 8 });
    expect(loadGlobalSearch()).toMatchObject({ leads: false, limit: 8, company: true });
  });

  it("группа выключена в настройках — её нет в списке; поле можно скрыть совсем", async () => {
    saveGlobalSearch({ leads: false });
    render(<TitleBar />);
    fireEvent.change(box(), { target: { value: "Лаванда" } });
    await screen.findByRole("listbox");
    expect(screen.queryByText("Лиды", { selector: ".gsearch-group" })).toBeNull();
    cleanup();
    saveGlobalSearch({ enabled: false });
    render(<TitleBar />);
    expect(screen.queryByRole("combobox", { name: "Глобальный поиск" })).toBeNull();
  });

  it("в «Системе» есть подраздел «Поиск» с переключателями", async () => {
    setState({ settings: "system", settingsSub: "gsearch" });
    render(<Settings />);
    const dialog = await screen.findByRole("dialog", { name: "Настройки" });
    expect(within(dialog).getByText("Поле поиска в шапке")).toBeInTheDocument();
    for (const t of ["Лиды", "Компании", "Контакты", "Сделки", "Задачи", "Заявки", "Действия"]) expect(within(dialog).getAllByText(t).length).toBeGreaterThan(0);
    // Первый переключатель — само поле, второй — «Лиды».
    const sw = within(dialog).getAllByRole("switch")[1]!;
    fireEvent.click(sw);
    await waitFor(() => expect(loadGlobalSearch().leads).toBe(false));
  });
});
