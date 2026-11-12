// Коннекторы в демо-режиме облачного рабочего пространства (?team): каталог, установка, кнопки в карточке, проверка компании, подача и модерация.
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
  fireEvent.click(await screen.findByText("Коннекторы", { selector: ".menu-item" }));
  return screen.findByRole("dialog", { name: "Коннекторы" });
}

async function confirm(label: string) {
  // Подтверждение — последнее открытое диалоговое окно.
  await waitFor(() => expect(document.querySelectorAll(".dialog").length).toBeGreaterThan(0));
  const dlgs = document.querySelectorAll<HTMLElement>(".dialog");
  fireEvent.click(within(dlgs[dlgs.length - 1]!).getByRole("button", { name: label }));
}

describe("коннекторы", () => {
  it("открывается из меню учётной записи, каталог ищет и фильтрует по категориям", async () => {
    const dlg = await openMarketFromMenu();
    expect(dlg.className).toContain("market");
    const grid = await within(dlg).findByRole("list", { name: "Коннекторы" });
    expect(within(grid).getByText("Звонилка")).toBeInTheDocument();
    expect(within(grid).getByText("Документы+")).toBeInTheDocument();
    // Заявка на проверке в каталог не попадает.
    expect(within(grid).queryByText("Уведомления в Telegram")).toBeNull();
    fireEvent.change(within(dlg).getByLabelText("Поиск коннекторов"), { target: { value: "счета" } });
    await waitFor(() => expect(within(dlg).queryByText("Звонилка")).toBeNull());
    expect(within(dlg).getByText("Документы+")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Поиск коннекторов"), { target: { value: "" } });
    fireEvent.click(within(within(dlg).getByRole("group", { name: "Категории" })).getByRole("button", { name: "Телефония" }));
    await waitFor(() => expect(within(dlg).queryByText("Документы+")).toBeNull());
    expect(within(dlg).getByText("Звонилка")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(getState().market).toBeNull());
  });

  it("менеджер видит коннектор, но ставит его владелец или администратор", async () => {
    const dlg = await openMarketFromMenu();
    fireEvent.click(await within(dlg).findByText("Звонилка"));
    expect(await within(dlg).findByRole("button", { name: "Установить" })).toBeDisabled();
    expect(within(dlg).getByText("Устанавливает владелец или администратор рабочего пространства")).toBeInTheDocument();
  });

  it("установка с показом прав, кнопка коннектора в карточке, выключение и удаление", async () => {
    setWsMockRole("owner");
    const dlg = await openMarketFromMenu();
    fireEvent.click(await within(dlg).findByText("Звонилка"));
    expect(await within(dlg).findByRole("heading", { name: "Звонилка" })).toBeInTheDocument();
    expect(within(dlg).getByText("Доступ к данным")).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Установить" }));
    await confirm("Установить");
    await waitFor(() => expect(getState().marketInstalled.map((x) => x.name)).toContain("Звонилка"));
    expect(await within(dlg).findByRole("button", { name: "Удалить" })).toBeInTheDocument();

    // Кнопка коннектора в карточке компании.
    setState({ market: null });
    const { api } = await import("../../api");
    const list = await api.wsList("companies", { limit: 1 });
    await waitFor(() => expect(getState().collections.length).toBeGreaterThan(0));
    openCrmCard("company", list.items[0]!.id);
    expect(await screen.findByRole("button", { name: /Звонки компании/ })).toBeInTheDocument();

    // Выключенный коннектор пропадает из карточек.
    setState({ market: "installed" });
    const d2 = await screen.findByRole("dialog", { name: "Коннекторы" });
    fireEvent.click(await within(d2).findByText("Звонилка"));
    fireEvent.click(await within(d2).findByRole("switch", { name: "Включена" }));
    await waitFor(() => expect(getState().marketInstalled).toHaveLength(0));
    fireEvent.click(within(d2).getByRole("button", { name: "Удалить" }));
    await confirm("Удалить");
    expect(await within(d2).findByRole("button", { name: "Установить" })).toBeInTheDocument();
  });

  it("без проверенной компании коннектор не отправить; компанию проверяет модератор", async () => {
    const dlg = await openMarketFromMenu();
    fireEvent.click(within(dlg).getByRole("button", { name: "Для разработчиков" }));
    const newBtn = await within(dlg).findByRole("button", { name: "Новый коннектор" });
    expect(newBtn).toBeDisabled();
    fireEvent.click(await within(dlg).findByRole("button", { name: "Пройти проверку компании" }));
    const form = await screen.findByRole("dialog", { name: "Проверка компании" });
    const send = within(form).getByRole("button", { name: "Отправить на проверку" });
    expect(send).toBeDisabled();
    const fill = (label: string, value: string) => fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    fill("Юридическое название", "ООО Склад");
    fill("Страна регистрации", "Россия");
    fill("Регистрационный номер", "7712345678");
    fill("Сайт компании", "https://sklad.example.com");
    fill("Политика конфиденциальности", "https://sklad.example.com/privacy");
    fill("Контактное лицо", "Пётр Складов");
    // Личная почта не подходит: домен должен совпадать с сайтом компании.
    fill("Рабочая почта", "petr@gmail.com");
    expect(send).toBeDisabled();
    fill("Рабочая почта", "petr@sklad.example.com");
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(await within(dlg).findByText("Заявка на проверке")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Новый коннектор" })).toBeDisabled();

    // Модератор на вкладке «На проверке» подтверждает компанию.
    fireEvent.click(within(dlg).getByRole("button", { name: "На проверке" }));
    const queue = await within(dlg).findByRole("list", { name: "Заявки компаний" });
    fireEvent.click(within(queue).getByRole("button", { name: /Подтвердить компанию/ }));
    await confirm("Подтвердить");
    fireEvent.click(within(dlg).getByRole("button", { name: "Для разработчиков" }));
    expect(await within(dlg).findByText("Проверена")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Новый коннектор" })).toBeEnabled();
  });

  it("проверенная компания подаёт коннектор: автопроверка, вкладка «На проверке», публикация в каталог", async () => {
    // Демо-разработчик уже проверен: подтверждаем компанию так же, как в предыдущем тесте, через сервер демо.
    const { api } = await import("../../api");
    await api.wsMarket("market_company_save", { company: { legal_name: "ООО Склад", country: "Россия", reg_number: "7712345678", website: "https://sklad.example.com",
      contact_name: "Пётр Складов", contact_email: "petr@sklad.example.com", privacy_url: "https://sklad.example.com/privacy" } });
    const me = getState().ws!.me!;
    await api.wsMarket("market_company_review", { user: me, approve: true });

    const dlg = await openMarketFromMenu();
    fireEvent.click(within(dlg).getByRole("button", { name: "Для разработчиков" }));
    fireEvent.click(await within(dlg).findByRole("button", { name: "Новый коннектор" }));
    const form = await screen.findByRole("dialog", { name: "Новый коннектор" });
    const send = within(form).getByRole("button", { name: "Отправить на проверку" });
    expect(within(form).getByLabelText("Разработчик")).toHaveValue("ООО Склад");
    fireEvent.change(within(form).getByLabelText("Название"), { target: { value: "Склад онлайн" } });
    fireEvent.change(within(form).getByLabelText("Адрес в каталоге"), { target: { value: "sklad-online" } });
    fireEvent.change(within(form).getByLabelText("Кратко"), { target: { value: "Остатки товаров в сделке" } });
    fireEvent.change(within(form).getByLabelText("Описание"), { target: { value: "Показывает остатки товаров на складе прямо в карточке сделки." } });
    // Неверный манифест не отправить, причина видна в списке автоматической проверки.
    const manifest = within(form).getByLabelText("Манифест");
    fireEvent.change(manifest, { target: { value: "{" } });
    expect(within(within(form).getByRole("list", { name: "Автоматическая проверка" })).getByText("Манифест — неверный JSON.")).toBeInTheDocument();
    expect(send).toBeDisabled();
    // Адрес не https — отказ автопроверки.
    fireEvent.change(manifest, { target: { value: JSON.stringify({ schema: 1, actions: [{ id: "stock", label: "Остатки", entity: "deal", url: "http://sklad.example.com/{id}" }] }) } });
    expect(send).toBeDisabled();
    fireEvent.change(manifest, { target: { value: JSON.stringify({ schema: 1, actions: [{ id: "stock", label: "Остатки", entity: "deal", url: "https://sklad.example.com/{id}" }] }) } });
    expect(send).toBeEnabled();
    fireEvent.click(send);

    fireEvent.click(await within(dlg).findByRole("button", { name: "На проверке" }));
    const mine = await within(dlg).findByRole("list", { name: "Мои заявки" });
    expect(await within(mine).findByText("1.0.0: Отправлена на проверку")).toBeInTheDocument();
    const queue = await within(dlg).findByRole("list", { name: "Заявки" });
    const row = within(queue).getByText(/Склад онлайн/).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Опубликовать" }));
    await confirm("Опубликовать");
    await waitFor(() => expect(within(within(dlg).getByRole("list", { name: "Опубликованные коннекторы" })).getByText("Склад онлайн")).toBeInTheDocument());
    fireEvent.click(within(dlg).getByRole("button", { name: "Каталог" }));
    expect(await within(await within(dlg).findByRole("list", { name: "Коннекторы" })).findByText("Склад онлайн")).toBeInTheDocument();
  });

  it("черновик сохраняется на компьютере и виден на вкладке «На проверке»", async () => {
    const { api } = await import("../../api");
    await api.wsMarket("market_company_save", { company: { legal_name: "ООО Склад", country: "Россия", reg_number: "7712345678", website: "https://sklad.example.com",
      contact_name: "Пётр Складов", contact_email: "petr@sklad.example.com", privacy_url: "https://sklad.example.com/privacy" } });
    await api.wsMarket("market_company_review", { user: getState().ws!.me!, approve: true });
    localStorage.removeItem("customers.connectorDrafts");
    const dlg = await openMarketFromMenu();
    fireEvent.click(within(dlg).getByRole("button", { name: "Для разработчиков" }));
    fireEvent.click(await within(dlg).findByRole("button", { name: "Новый коннектор" }));
    const form = await screen.findByRole("dialog", { name: "Новый коннектор" });
    fireEvent.change(within(form).getByLabelText("Название"), { target: { value: "Мой черновик" } });
    fireEvent.click(within(form).getByRole("button", { name: "Сохранить черновик" }));
    fireEvent.click(within(dlg).getByRole("button", { name: "На проверке" }));
    const mine = await within(dlg).findByRole("list", { name: "Мои заявки" });
    expect(within(mine).getByText("Мой черновик")).toBeInTheDocument();
    expect(within(mine).getByText("1.0.0: Черновик")).toBeInTheDocument();
    localStorage.removeItem("customers.connectorDrafts");
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
