import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdateInfo } from "../api/types";
import { getState, setState } from "../state/store";
import { App } from "./App";
import { subsectionsOf } from "./settings/subsections";
import { updateVisible } from "./Sidebar";

afterEach(cleanup);

const update = (over: Partial<UpdateInfo>): UpdateInfo => ({
  phase: "idle", current: "1.2.2", canUpdate: true, available: null, stagedVersion: null, lastCheck: null, releasesPage: "https://example.org", ...over,
});

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

describe("учётная запись в левой панели", () => {
  it("имя без значка синхронизации и подписи об облаке, «?» в одной строке с профилем", async () => {
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    setState({ session: { id: "local-1", displayName: "Алексей", avatar: null, databasePath: "" } });
    const account = await within(nav).findByLabelText("Учётная запись");
    expect(within(account).getByText("Алексей")).toBeInTheDocument();
    expect(account.querySelector(".sync-badge")).toBeNull();
    expect(within(nav).queryByText("Облачный аккаунт")).toBeNull();
    expect(account.parentElement).toContainElement(within(nav).getByLabelText("Справка"));
  });
});

describe("подразделы настроек", () => {
  it("у страниц с несколькими группами есть подразделы, остальные не раскрываются", () => {
    expect(subsectionsOf("appearance").map((s) => s.id)).toEqual(["look", "sidebar"]);
    expect(subsectionsOf("account")).toEqual([]);
    expect(subsectionsOf("exclusions")).toEqual([]);
    expect(subsectionsOf("notifications")).toEqual([]);
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

  it("меню: Профиль, Настройки, Рабочее пространство — без «Выйти», «Коннекторы» и «Данные и копии»", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    fireEvent.click(screen.getByLabelText("Учётная запись"));
    const items = (await screen.findAllByRole("button")).filter((b) => b.classList.contains("menu-item")).map((b) => b.textContent);
    expect(items.slice(0, 3)).toEqual(["Профиль", "Настройки", "Рабочее пространство"]);
    expect(items).not.toContain("Аккаунт и синхронизация");
    expect(items).not.toContain("Данные и копии");
    expect(items).not.toContain("Выйти");
    expect(items).not.toContain("Коннекторы");
    fireEvent.click(screen.getByText("Профиль", { selector: ".menu-item" }));
    const dialog = await screen.findByRole("dialog", { name: "Настройки" });
    expect(within(dialog).getAllByText("Профиль").length).toBeGreaterThan(0);
  });
});

describe("версия программы в настройках", () => {
  it("внизу левого списка по центру: vX.Y.Z, любое число частей; «Данные» из аккаунта убраны", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    fireEvent.click(screen.getByLabelText("Учётная запись"));
    fireEvent.click(await screen.findByText("Настройки", { selector: ".menu-item" }));
    const dialog = await screen.findByRole("dialog", { name: "Настройки" });
    const nav = within(dialog).getByRole("navigation", { name: "Разделы настроек" });
    const ver = within(nav).getByLabelText("Версия программы");
    expect(ver.textContent).toMatch(/^v\d+(\.\d+)*$/);
    expect(nav.lastElementChild).toBe(ver);
    setState({ boot: { ...getState().boot!, version: "1.2.3.4.5" } });
    await waitFor(() => expect(within(nav).getByLabelText("Версия программы")).toHaveTextContent("v1.2.3.4.5"));
    expect(within(dialog).queryByRole("button", { name: "Данные" })).toBeNull();
  });
});
