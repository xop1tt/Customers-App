import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncStatus, UpdateInfo } from "../api/types";
import { setState } from "../state/store";
import { App } from "./App";
import { subsectionsOf } from "./settings/subsections";
import { syncView, updateVisible } from "./Sidebar";

afterEach(cleanup);

const update = (over: Partial<UpdateInfo>): UpdateInfo => ({
  phase: "idle", current: "1.2.2", canUpdate: true, available: null, stagedVersion: null, lastCheck: null, releasesPage: "https://example.org", ...over,
});
const sync = (over: Partial<SyncStatus>): SyncStatus => ({ enabled: true, kind: "idle", message: null, lastSync: null, pending: 0, ...over });

describe("кнопка «Обновить»", () => {
  it("видна, только когда обновление уже загружено", () => {
    expect(updateVisible(null)).toBe(false);
    expect(updateVisible(update({ phase: "upToDate" }))).toBe(false);
    expect(updateVisible(update({ phase: "idle" }))).toBe(false);
    const found = { version: "1.3.0", title: "", notes: "", page: null, size: 1 };
    for (const phase of ["available", "downloading", "checking", "failed"] as const) expect(updateVisible(update({ phase, available: found }))).toBe(false);
    for (const phase of ["ready", "installing"] as const) expect(updateVisible(update({ phase }))).toBe(true);
    expect(updateVisible(update({ phase: "checking", stagedVersion: "1.3.0" }))).toBe(true);
    expect(updateVisible(update({ phase: "failed", stagedVersion: "1.3.0" }))).toBe(true);
    expect(updateVisible(update({ phase: "downloading", stagedVersion: "1.3.0" }))).toBe(false);
  });

  it("стоит в левой панели над «Настроить панель»", async () => {
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    setState({ update: update({ phase: "ready", stagedVersion: "1.3.0", available: { version: "1.3.0", title: "", notes: "", page: null, size: 1 } }) });
    const button = await within(nav).findByRole("button", { name: /Обновить/ });
    const customize = within(nav).getByText("Настроить панель").closest("button") as HTMLElement;
    expect(button.compareDocumentPosition(customize) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    setState({ update: update({ phase: "upToDate" }) });
    await waitFor(() => expect(within(nav).queryByRole("button", { name: /Обновить/ })).toBeNull());
  });
});

describe("облачко синхронизации", () => {
  it("показывает четыре состояния", () => {
    expect(syncView(null)).toBeNull();
    expect(syncView(sync({ enabled: false }))).toBeNull();
    expect(syncView(sync({ kind: "syncing" }))?.tone).toBe("sync");
    expect(syncView(sync({}))).toMatchObject({ tone: "ok", label: "Синхронизировано" });
    expect(syncView(sync({ pending: 3 }))).toMatchObject({ tone: "pending" });
    expect(syncView(sync({ kind: "failed", message: "ошибка" }))?.label).toContain("Не синхронизировано");
    expect(syncView(sync({ kind: "offline" }))).toMatchObject({ tone: "offline", label: "Потеряно соединение с облаком" });
  });

  it("стоит справа от имени, подписи «Облачный аккаунт» нет, «?» в одной строке с профилем", async () => {
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    setState({ session: { id: "c", displayName: "Анна", avatar: null, isCloud: true, cloudUser: null, databasePath: "" }, sync: sync({ kind: "offline" }) });
    const account = await within(nav).findByLabelText("Учётная запись");
    expect(within(account).getByText("Анна")).toBeInTheDocument();
    expect(within(account).getByRole("img", { name: "Потеряно соединение с облаком" })).toBeInTheDocument();
    expect(within(nav).queryByText("Облачный аккаунт")).toBeNull();
    expect(account.parentElement).toContainElement(within(nav).getByLabelText("Справка"));
    setState({ sync: sync({ kind: "syncing" }) });
    expect(await within(account).findByRole("img", { name: "Синхронизация…" })).toBeInTheDocument();
  });
});

describe("подразделы настроек", () => {
  it("у страниц с несколькими группами есть подразделы, остальные не раскрываются", () => {
    expect(subsectionsOf("appearance", false).map((s) => s.id)).toEqual(["look", "sidebar"]);
    expect(subsectionsOf("account", false).map((s) => s.id)).toEqual(["profile", "security"]);
    expect(subsectionsOf("account", true).map((s) => s.id)).toEqual(["profile", "security", "cloud"]);
    expect(subsectionsOf("exclusions", true)).toEqual([]);
    expect(subsectionsOf("notifications", true)).toEqual([]);
  });

  it("выбранная страница раскрывается, показывается только её подраздел", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    fireEvent.click(screen.getByLabelText("Учётная запись"));
    fireEvent.click(await screen.findByText("Настройки", { selector: ".menu-item" }));
    const dialog = await screen.findByRole("dialog", { name: "Настройки" });
    fireEvent.click(within(dialog).getByText("Оформление", { selector: ".nav-item span" }));
    const subs = within(dialog).getByRole("group", { name: "Подразделы: Оформление" });
    expect(within(subs).getAllByRole("button").map((b) => b.textContent)).toEqual(["Внешний вид", "Боковая панель"]);
    expect(within(dialog).getByText("Акцентный цвет")).toBeInTheDocument();
    expect(within(dialog).queryByText("Числа у разделов")).toBeNull();
    fireEvent.click(within(subs).getByRole("button", { name: "Боковая панель" }));
    expect(await within(dialog).findByText("Числа у разделов")).toBeInTheDocument();
    expect(within(dialog).queryByText("Акцентный цвет")).toBeNull();
  });
});

describe("экран входа", () => {
  beforeEach(() => { window.history.pushState({}, "", "/?auth&cloud"); });
  it("выбор «облачный / на этом компьютере» — две отдельные кнопки, а не растянутое поле", async () => {
    const { AuthScreen } = await import("./Auth");
    const { setState: set } = await import("../state/store");
    set({ phase: "auth", boot: { version: "1", platform: "macos", cloudAvailable: true, hasUsers: true, existingInstall: false, session: null, device: { rememberedUser: null } } as never });
    const { container } = render(<AuthScreen />);
    const tabs = screen.getByRole("tablist");
    const buttons = within(tabs).getAllByRole("tab");
    expect(buttons.map((b) => b.textContent)).toEqual(["Облачный аккаунт", "На этом компьютере"]);
    expect(buttons.every((b) => b.className.includes("auth-mode"))).toBe(true);
    expect(tabs.className).toBe("auth-modes");
    expect(container.querySelector("img.brand")).not.toBeNull();
    expect(container.querySelector(".brand svg")).toBeNull();
  });
});

describe("сворачиваемые группы и меню учётной записи", () => {
  it("группа сворачивается по заголовку и оставляет только открытый пункт", async () => {
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    const head = within(nav).getByRole("button", { name: "Работа" });
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(within(nav).getByText("Журнал поиска")).toBeInTheDocument();
    fireEvent.click(head);
    await waitFor(() => expect(within(nav).getByRole("button", { name: "Работа" })).toHaveAttribute("aria-expanded", "false"));
    expect(within(nav).queryByText("Журнал поиска")).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: "По оценке" }));
    await waitFor(() => expect(within(nav).queryByText("Оценка 90+")).toBeNull());
    // В режиме настройки панели всё раскрыто.
    fireEvent.click(within(nav).getByText("Настроить панель"));
    expect(await within(nav).findByText("Журнал поиска")).toBeInTheDocument();
    fireEvent.click(within(nav).getByRole("button", { name: "Готово" }));
    await waitFor(() => expect(within(nav).queryByText("Журнал поиска")).toBeNull());
    fireEvent.click(within(nav).getByRole("button", { name: "Работа" }));
    expect(await within(nav).findByText("Журнал поиска")).toBeInTheDocument();
    fireEvent.click(within(nav).getByRole("button", { name: "По оценке" }));
    expect(await within(nav).findByText("Оценка 90+")).toBeInTheDocument();
  });

  it("меню: Профиль, Настройки, Рабочее пространство — без «Аккаунт и синхронизация» и «Данные и копии»", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    fireEvent.click(screen.getByLabelText("Учётная запись"));
    const items = (await screen.findAllByRole("button")).filter((b) => b.classList.contains("menu-item")).map((b) => b.textContent);
    expect(items.slice(0, 3)).toEqual(["Профиль", "Настройки", "Рабочее пространство"]);
    expect(items).not.toContain("Аккаунт и синхронизация");
    expect(items).not.toContain("Данные и копии");
    fireEvent.click(screen.getByText("Профиль", { selector: ".menu-item" }));
    expect(await screen.findByRole("button", { name: "Изменить профиль" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Изменить профиль" }));
    const dialog = await screen.findByRole("dialog", { name: "Настройки" });
    expect(within(dialog).getAllByText("Профиль").length).toBeGreaterThan(0);
  });
});
