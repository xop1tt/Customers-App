import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { CrmPanel } from "./panels/CrmPanel";

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
    fireEvent.click(screen.getByLabelText("Учётная запись"));
    fireEvent.click(await screen.findByText("Настройки", { selector: ".menu-item" }));
    const dialog = await screen.findByRole("dialog", { name: "Настройки" });
    expect(within(dialog).getByText("Акцентный цвет")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText("Исключения"));
    await within(dialog).findByText("example-spam.ru");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Настройки" })).toBeNull());
  });

  it("настройки закрываются щелчком по затемнению и разбиты на категории", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    fireEvent.click(screen.getByLabelText("Учётная запись"));
    fireEvent.click(await screen.findByText("Настройки", { selector: ".menu-item" }));
    const dialog = await screen.findByRole("dialog", { name: "Настройки" });
    for (const title of ["Основные", "Приложение", "Работа", "Поддержка"]) expect(within(dialog).getByText(title)).toBeInTheDocument();
    for (const name of ["Способы связи", "Уведомления", "Система"]) expect(within(dialog).getByText(name)).toBeInTheDocument();
    expect(within(dialog).queryByText("Рассылка")).toBeNull();
    fireEvent.click(within(dialog).getByText("Способы связи"));
    await within(dialog).findByText("Программа для звонков");
    // Щелчок внутри окна не закрывает его, по затемнению — закрывает.
    fireEvent.pointerDown(dialog);
    expect(screen.getByRole("dialog", { name: "Настройки" })).toBeInTheDocument();
    fireEvent.pointerDown(dialog.parentElement as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Настройки" })).toBeNull());
  });

  it("в левой панели «Новые» выше «Все лиды», есть раздел «По оценке»", async () => {
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    const items = [...nav.querySelectorAll(".nav-item")].map((n) => n.textContent ?? "");
    expect(items.findIndex((t) => t.startsWith("Новые"))).toBeLessThan(items.findIndex((t) => t.startsWith("Все лиды")));
    expect(within(nav).getByText("По оценке")).toBeInTheDocument();
    fireEvent.click(within(nav).getByText("Оценка 70+"));
    const rows = await screen.findAllByRole("row");
    expect(rows.length).toBeGreaterThan(1);
    expect(within(nav).getByText("Оценка 70+").closest(".nav-item")).toHaveClass("active");
  });

  it("«Сообщить о проблеме» открывает небольшое окно, а не настройки", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    fireEvent.click(screen.getByLabelText("Справка"));
    fireEvent.click(await screen.findByText("Сообщить о проблеме"));
    const dialog = await screen.findByRole("dialog", { name: "Сообщить о проблеме" });
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Настройки" })).toBeNull();
  });

  it("фильтр по тексту сокращает список", async () => {
    render(<App />);
    fireEvent.click(within(await screen.findByLabelText("Навигация")).getByText("Все лиды"));
    await screen.findAllByRole("row");
    fireEvent.change(screen.getByLabelText("Поиск по лидам"), { target: { value: "Лаванда" } });
    await waitFor(() => expect(screen.getAllByRole("row").filter((r) => r.className.includes("tr"))).toHaveLength(1));
  });
});

describe("интеграции и профиль", () => {
  it("Битрикс24, Notion и вебхук настраиваются из одной панели", async () => {
    render(<CrmPanel />);
    for (const title of ["Битрикс24", "Notion", "Вебхук"]) await screen.findByText(title);
    fireEvent.click(screen.getAllByText("Настроить")[0] as HTMLElement);
    await screen.findByText("Адрес вебхука");
  });

  it("в настройках обновлений показывается только дата проверки, если она была", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    fireEvent.click(screen.getByLabelText("Учётная запись"));
    fireEvent.click(await screen.findByText("Настройки", { selector: ".menu-item" }));
    const dialog = await screen.findByRole("dialog", { name: "Настройки" });
    fireEvent.click(within(dialog).getByText("Обновления"));
    const hint = await within(dialog).findByText(/Проверено:/);
    expect(hint.textContent).not.toMatch(/не проверялись/);
  });
});
