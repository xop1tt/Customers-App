// Маркетплейс в демо-режиме облачного Workspace (?team): каталог, установка, кнопки в карточке, подача и модерация.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { window.history.replaceState({}, "", "/?team"); });

import { resetChatMock } from "../../api/chatMock";
import { resetMarketMock } from "../../api/marketMock";
import { resetWsMock, setWsMockRole } from "../../api/wsMock";
import { getState, setState } from "../../state/store";
import { openCrmCard } from "../../state/team";
import { App } from "../App";

afterEach(cleanup);
beforeEach(() => { resetWsMock(); resetChatMock(); resetMarketMock(); });

async function openMarketFromMenu() {
  render(<App />);
  await screen.findByLabelText("Навигация");
  fireEvent.click(screen.getByLabelText("Учётная запись"));
  fireEvent.click(await screen.findByText("Маркетплейс", { selector: ".menu-item" }));
  return screen.findByRole("dialog", { name: "Маркетплейс" });
}

async function confirm(label: string) {
  // Подтверждение — последнее открытое диалоговое окно.
  await waitFor(() => expect(document.querySelectorAll(".dialog").length).toBeGreaterThan(0));
  const dlgs = document.querySelectorAll<HTMLElement>(".dialog");
  fireEvent.click(within(dlgs[dlgs.length - 1]!).getByRole("button", { name: label }));
}

describe("маркетплейс", () => {
  it("открывается из меню учётной записи, каталог ищет и фильтрует по категориям", async () => {
    const dlg = await openMarketFromMenu();
    expect(dlg.className).toContain("market");
    const grid = await within(dlg).findByRole("list", { name: "Интеграции" });
    expect(within(grid).getByText("Звонилка")).toBeInTheDocument();
    expect(within(grid).getByText("Документы+")).toBeInTheDocument();
    // Заявка на проверке в каталог не попадает.
    expect(within(grid).queryByText("Уведомления в Telegram")).toBeNull();
    fireEvent.change(within(dlg).getByLabelText("Поиск интеграций"), { target: { value: "счета" } });
    await waitFor(() => expect(within(dlg).queryByText("Звонилка")).toBeNull());
    expect(within(dlg).getByText("Документы+")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Поиск интеграций"), { target: { value: "" } });
    fireEvent.click(within(within(dlg).getByRole("group", { name: "Категории" })).getByRole("button", { name: "Телефония" }));
    await waitFor(() => expect(within(dlg).queryByText("Документы+")).toBeNull());
    expect(within(dlg).getByText("Звонилка")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(getState().market).toBeNull());
  });

  it("менеджер видит интеграцию, но ставит её владелец или администратор", async () => {
    const dlg = await openMarketFromMenu();
    fireEvent.click(await within(dlg).findByText("Звонилка"));
    expect(await within(dlg).findByRole("button", { name: "Установить" })).toBeDisabled();
    expect(within(dlg).getByText("Устанавливает владелец или администратор Workspace")).toBeInTheDocument();
  });

  it("установка с показом прав, кнопка интеграции в карточке, выключение и удаление", async () => {
    setWsMockRole("owner");
    const dlg = await openMarketFromMenu();
    fireEvent.click(await within(dlg).findByText("Звонилка"));
    expect(await within(dlg).findByRole("heading", { name: "Звонилка" })).toBeInTheDocument();
    expect(within(dlg).getByText("Доступ к данным")).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Установить" }));
    await confirm("Установить");
    await waitFor(() => expect(getState().marketInstalled.map((x) => x.name)).toContain("Звонилка"));
    expect(await within(dlg).findByRole("button", { name: "Удалить" })).toBeInTheDocument();

    // Кнопка интеграции в карточке компании.
    setState({ market: null });
    const { api } = await import("../../api");
    const list = await api.wsList("companies", { limit: 1 });
    await waitFor(() => expect(getState().collections.length).toBeGreaterThan(0));
    openCrmCard("company", list.items[0]!.id);
    expect(await screen.findByRole("button", { name: /Звонки компании/ })).toBeInTheDocument();

    // Выключенная интеграция пропадает из карточек.
    setState({ market: "installed" });
    const d2 = await screen.findByRole("dialog", { name: "Маркетплейс" });
    fireEvent.click(await within(d2).findByText("Звонилка"));
    fireEvent.click(await within(d2).findByRole("switch", { name: "Включена" }));
    await waitFor(() => expect(getState().marketInstalled).toHaveLength(0));
    fireEvent.click(within(d2).getByRole("button", { name: "Удалить" }));
    await confirm("Удалить");
    expect(await within(d2).findByRole("button", { name: "Установить" })).toBeInTheDocument();
  });

  it("разработчик подаёт интеграцию, модератор публикует её в каталог", async () => {
    const dlg = await openMarketFromMenu();
    fireEvent.click(within(dlg).getByRole("button", { name: "Для разработчиков" }));
    fireEvent.click(await within(dlg).findByRole("button", { name: "Новая интеграция" }));
    const form = await screen.findByRole("dialog", { name: "Новая интеграция" });
    fireEvent.change(within(form).getByLabelText("Название"), { target: { value: "Склад онлайн" } });
    fireEvent.change(within(form).getByLabelText("Адрес в каталоге"), { target: { value: "sklad-online" } });
    fireEvent.change(within(form).getByLabelText("Разработчик"), { target: { value: "ООО Склад" } });
    fireEvent.change(within(form).getByLabelText("Кратко"), { target: { value: "Остатки товаров в сделке" } });
    // Неверный манифест не отправить.
    const manifest = within(form).getByLabelText("Манифест");
    fireEvent.change(manifest, { target: { value: "{" } });
    expect(within(form).getByText("Манифест — неверный JSON.")).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Отправить на проверку" })).toBeDisabled();
    fireEvent.change(manifest, { target: { value: JSON.stringify({ schema: 1, actions: [{ id: "stock", label: "Остатки", entity: "deal", url: "https://sklad.example.com/{id}" }] }) } });
    fireEvent.click(within(form).getByRole("button", { name: "Отправить на проверку" }));
    const mine = await within(dlg).findByRole("list", { name: "Мои интеграции" });
    expect(await within(mine).findByText("1.0.0: На проверке")).toBeInTheDocument();

    fireEvent.click(await within(dlg).findByRole("button", { name: "Модерация" }));
    const queue = await within(dlg).findByRole("list", { name: "Заявки" });
    const row = within(queue).getByText(/Склад онлайн/).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Опубликовать" }));
    await confirm("Опубликовать");
    await waitFor(() => expect(within(within(dlg).getByRole("list", { name: "Опубликованные интеграции" })).getByText("Склад онлайн")).toBeInTheDocument());
    fireEvent.click(within(dlg).getByRole("button", { name: "Каталог" }));
    expect(await within(await within(dlg).findByRole("list", { name: "Интеграции" })).findByText("Склад онлайн")).toBeInTheDocument();
  });
});

describe("адрес кнопки интеграции", () => {
  it("значения кодируются, название записи — только с правом crm.read", async () => {
    const { actionUrl } = await import("../../state/market");
    const action = { id: "a", label: "A", entity: "company" as const, url: "https://x.example.com/{type}/{id}?n={title}" };
    expect(actionUrl(action, ["crm.read"], { id: "1/2", type: "company", title: "ООО & Ко" })).toBe("https://x.example.com/company/1%2F2?n=%D0%9E%D0%9E%D0%9E%20%26%20%D0%9A%D0%BE");
    expect(actionUrl(action, [], { id: "1", type: "company", title: "секрет" })).toBe("https://x.example.com/company/1?n=");
  });
});
