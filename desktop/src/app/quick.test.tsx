import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../api";
import { resetWsMock, setWsMockRole } from "../api/wsMock";
import { translate } from "../lib/i18n";
import { moveActive, quickActions, quickRecords } from "../lib/quick";
import { getState, setState } from "../state/store";
import { QuickSearch, toggleQuick } from "./QuickSearch";

afterEach(() => { cleanup(); setState({ quickOpen: false, record: null }); });
beforeEach(async () => {
  resetWsMock();
  setState({ ws: await api.wsState(), section: "home", quickOpen: false });
});

const input = () => screen.getByRole("combobox", { name: "Быстрый поиск" });
const options = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("быстрый поиск: логика", () => {
  it("действия по праву и по тексту, стрелки по кругу", () => {
    const all = quickActions("", ["records.create"]).map((i) => i.title);
    expect(all.slice(0, 2)).toEqual(["Новая компания", "Новый контакт"]);
    expect(all).toContain("Перейти: Календарь");
    expect(quickActions("", ["records.view"]).some((i) => i.kind === "create")).toBe(false);
    expect(quickActions("кален", ["records.create"]).map((i) => i.title)).toEqual(["Перейти: Календарь"]);
    expect([moveActive(0, 3, -1), moveActive(2, 3, 1), moveActive(0, 0, 1)]).toEqual([2, 0, 0]);
    const rec = { id: "1", name: "Альфа", phones: ["+7 1"], emails: ["a@a.ru"] } as never;
    expect(quickRecords({ company: [rec] })).toMatchObject([{ kind: "record", title: "Альфа", hint: "+7 1 · a@a.ru" }]);
  });
});

describe("окно Ctrl/Cmd+K", () => {
  it("находит записи разных типов, Enter открывает карточку в CRM", async () => {
    const deal = (await api.wsList("deals")).items[0]!;
    await api.wsSave("contacts", null, { first_name: "Северин", last_name: "Петров" });
    render(<QuickSearch />);
    toggleQuick();
    await screen.findByRole("dialog", { name: "Быстрый поиск" });
    fireEvent.change(input(), { target: { value: "север" } });
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(2));
    expect(screen.getByText("Компании")).toBeTruthy();
    expect(screen.getByText("Контакты")).toBeTruthy();
    expect(options()).toContain(`💼${deal.title}`);
    const first = options()[0];
    expect(first).toContain("ООО «Северный ветер»");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(getState().quickOpen).toBe(false);
    expect(getState().section).toBe("today");
    expect(getState().record?.table).toBe("companies");
  });

  it("стрелки выбирают пункт, действие создаёт задачу и переход открывает раздел", async () => {
    render(<QuickSearch />);
    toggleQuick();
    await screen.findByRole("dialog");
    expect(options()[0]).toContain("Новая компания");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[3]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(getState().record).toEqual({ table: "tasks", id: "new" });
    expect(getState().section).toBe("calendar");

    toggleQuick();
    await screen.findByRole("dialog");
    fireEvent.change(input(), { target: { value: "отчёт" } });
    fireEvent.click(await screen.findByRole("option", { name: /Перейти: Отчёты/ }));
    expect(getState().section).toBe("reports");
  });

  it("наблюдатель видит только переходы, пустой результат подписан", async () => {
    setWsMockRole("viewer");
    setState({ ws: await api.wsState() });
    render(<QuickSearch />);
    toggleQuick();
    await screen.findByRole("dialog");
    expect(options().every((t) => t?.includes("Перейти"))).toBe(true);
    fireEvent.change(input(), { target: { value: "zzzqqq" } });
    await within(screen.getByRole("listbox")).findByText("Ничего не найдено.");
  });

  it("тексты окна переведены на английский", () => {
    for (const ru of ["Быстрый поиск", "Быстрый поиск (Ctrl+K)", "Компания, контакт, сделка, задача или действие", "Создать", "Разделы", "Новая компания", "Новый контакт",
      "Новая сделка", "Новая задача", "Новая заявка", "Перейти: Сегодня", "Перейти: Календарь", "Перейти: Сделки", "Перейти: Отчёты", "выбрать", "открыть", "закрыть", "Результаты"]) {
      expect(translate(ru), ru).not.toBeNull();
    }
  });
});
