import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock, setWsMockRole } from "../../api/wsMock";
import { addDays, dayKey, dayTitle, startOfDay } from "../../lib/calendar";
import { translate } from "../../lib/i18n";
import { SECTIONS } from "../../lib/leads";
import { moduleOf } from "../../lib/modules";
import { MenuHost } from "../../ui/overlay";
import { getState, openRecord, setState } from "../../state/store";
import { CalendarPage } from "./CalendarPage";
import { CrmCard } from "./CrmCard";

afterEach(() => { cleanup(); openRecord("tasks", null); });
beforeEach(async () => {
  resetWsMock();
  setState({ ws: await api.wsState() });
});

/** Середина видимого периода: день заведомо в текущем месяце и не сегодня. */
const at = (day: Date, hours: number, minutes = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes).toISOString();
const today = () => startOfDay(new Date());
const cell = (day: Date) => screen.getByRole("gridcell", { name: dayTitle(day) });
/** Переносимый объект перетаскивания: jsdom не создаёт DataTransfer сам. */
const transfer = () => ({ dataTransfer: { effectAllowed: "", setData: () => {}, getData: () => "" } });

describe("календарь CRM", () => {
  it("раздел стоит в модуле CRM рядом с «Сегодня»", () => {
    expect(SECTIONS.calendar.title).toBe("Календарь");
    expect(moduleOf("calendar")).toBe("crm");
  });

  it("показывает задачи по сроку и события по времени, открывает карточку", async () => {
    const day = today();
    const task = await api.wsSave("tasks", null, { title: "Встреча с клиентом", status: "todo", due_at: at(day, 15, 30) });
    const company = (await api.wsList("companies")).items[0]!;
    await api.wsSave("activities", null, { type: "meeting", summary: "Показали макеты", occurred_at: at(day, 12), entity_type: "company", entity_id: company.id, payload: {} });
    render(<CalendarPage />);
    await screen.findByRole("grid");
    // Неделя показывает все записи дня: в месяце лишнее сворачивается в «ещё N», а стартовые записи демо зависят от времени суток.
    fireEvent.click(screen.getByRole("tab", { name: "Неделя" }));
    const box = cell(day);
    const chip = await within(box).findByRole("button", { name: "15:30 Встреча с клиентом" });
    expect(box.className).toContain("today");
    await within(box).findByRole("button", { name: "12:00 Встреча: Показали макеты" });

    fireEvent.click(chip);
    expect(getState().record).toEqual({ table: "tasks", id: task.id });
    fireEvent.click(within(box).getByRole("button", { name: "12:00 Встреча: Показали макеты" }));
    expect(getState().record).toEqual({ table: "companies", id: company.id });
  });

  it("месяц сворачивает лишние записи в «ещё N», неделя показывает все", async () => {
    const day = today();
    for (let i = 0; i < 5; i++) await api.wsSave("tasks", null, { title: `Дело ${i}`, status: "todo", due_at: at(day, 9 + i) });
    render(<CalendarPage />);
    await screen.findByRole("grid");
    const box = cell(day);
    await within(box).findByText("Дело 0");
    const hidden = within(box).getByRole("button", { name: /^ещё \d+$/ });
    expect(within(box).queryByText("Дело 4")).toBeNull();
    fireEvent.click(hidden);
    await within(cell(day)).findByText("Дело 4");
    expect(screen.getByRole("tab", { name: "Неделя" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("gridcell")).toHaveLength(7);
  });

  it("перетаскивание переносит срок задачи на другой день и сохраняет время", async () => {
    const day = today();
    // Соседний день той же недели: он есть и в месяце, и в неделе.
    const target = addDays(day, day.getDay() === 0 ? -1 : 1);
    const task = await api.wsSave("tasks", null, { title: "Отправить договор", status: "todo", due_at: at(day, 16, 45) });
    render(<CalendarPage />);
    await screen.findByRole("grid");
    const chip = await within(cell(day)).findByRole("button", { name: "16:45 Отправить договор" });
    expect(chip.getAttribute("draggable")).toBe("true");
    fireEvent.dragStart(chip, transfer());
    fireEvent.dragOver(cell(target), transfer());
    expect(cell(target).className).toContain("drop");
    fireEvent.drop(cell(target), transfer());
    await within(cell(target)).findByRole("button", { name: "16:45 Отправить договор" });
    const saved = new Date(String((await api.wsCard("tasks", task.id)).record.due_at));
    expect([dayKey(saved), saved.getHours(), saved.getMinutes()]).toEqual([dayKey(target), 16, 45]);
    expect(getState().toasts.at(-1)).toMatchObject({ kind: "success", text: `Срок перенесён: ${dayTitle(target)}` });
  });

  it("меню записи переносит срок на завтра", async () => {
    const day = today();
    const task = await api.wsSave("tasks", null, { title: "Подготовить смету", status: "todo", due_at: at(day, 11) });
    render(<><CalendarPage /><MenuHost /></>);
    await screen.findByRole("grid");
    fireEvent.click(screen.getByRole("tab", { name: "Все" }));
    const chip = await within(cell(day)).findByRole("button", { name: "11:00 Подготовить смету" });
    fireEvent.contextMenu(chip);
    const item = await screen.findByRole("menuitem", { name: "Перенести на завтра" });
    fireEvent.click(within(item).queryByRole("button") ?? item);
    await waitFor(async () => expect(dayKey(new Date(String((await api.wsCard("tasks", task.id)).record.due_at)))).toBe(dayKey(addDays(day, 1))));
  });

  it("чужую задачу сотрудник не переносит, события не перетаскиваются", async () => {
    const day = today();
    const other = "00000000-0000-4000-8000-000000000002";
    const company = (await api.wsList("companies")).items[0]!;
    await api.wsSave("activities", null, { type: "call", summary: "Созвон", occurred_at: at(day, 10), entity_type: "company", entity_id: company.id, payload: {} });
    const foreign = await api.wsSave("tasks", null, { title: "Чужая задача", status: "todo", due_at: at(day, 13), assignee_id: other });
    setWsMockRole("employee");
    setState({ ws: await api.wsState() });
    render(<CalendarPage />);
    await screen.findByRole("grid");
    // Неделя показывает все записи дня: в месяце лишнее сворачивается в «ещё N», а стартовые записи демо зависят от времени суток.
    fireEvent.click(screen.getByRole("tab", { name: "Неделя" }));
    // «Мои»: чужая задача скрыта, пока не выбран показ всех.
    await within(cell(day)).findByRole("button", { name: "10:00 Звонок: Созвон" });
    expect(within(cell(day)).queryByText("Чужая задача")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Все" }));
    const chip = await within(cell(day)).findByRole("button", { name: "13:00 Чужая задача" });
    const editable = getState().ws!.me === foreign.created_by;
    expect(chip.getAttribute("draggable")).toBe(String(editable));
    expect(within(cell(day)).getByRole("button", { name: "10:00 Звонок: Созвон" }).getAttribute("draggable")).toBe("false");
  });

  it("щелчок по «+» дня открывает новую задачу со сроком этого дня", async () => {
    const day = today();
    render(<><CalendarPage /><aside aria-label="Карточка записи"><CrmCard /></aside></>);
    await screen.findByRole("grid");
    fireEvent.click(within(cell(day)).getByRole("button", { name: "Новая задача на этот день" }));
    const record = getState().record!;
    expect([record.table, record.id]).toEqual(["tasks", "new"]);
    const due = new Date(String(record.preset?.due_at));
    expect([dayKey(due), due.getHours()]).toEqual([dayKey(day), 10]);
    const card = await screen.findByLabelText("Карточка записи");
    const title = within(card).getAllByRole("textbox")[0]!;
    fireEvent.change(title, { target: { value: "Задача из календаря" } });
    fireEvent.blur(title);
    fireEvent.click(within(card).getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(getState().record?.id).not.toBe("new"));
    const saved = new Date(String((await api.wsCard("tasks", getState().record!.id)).record.due_at));
    expect([dayKey(saved), saved.getHours()]).toEqual([dayKey(day), 10]);
    // Ядро сообщает об изменении данных, экран перечитывает период.
    setState((s) => ({ wsVersion: s.wsVersion + 1 }));
    await within(cell(day)).findByRole("button", { name: "10:00 Задача из календаря" });
  });

  it("наблюдатель не видит кнопок создания, переходы листают период", async () => {
    setWsMockRole("viewer");
    setState({ ws: await api.wsState() });
    render(<CalendarPage />);
    await screen.findByRole("grid");
    expect(screen.queryByRole("button", { name: "Новая задача на этот день" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Задача" })).toBeNull();
    const title = () => screen.getByRole("grid").getAttribute("aria-label");
    const before = title();
    fireEvent.click(screen.getByRole("button", { name: "Следующий месяц" }));
    await waitFor(() => expect(title()).not.toBe(before));
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await waitFor(() => expect(title()).toBe(before));
  });

  it("тексты календаря переведены на английский", () => {
    for (const ru of ["Календарь", "Месяц", "Неделя", "Мои", "Все", "Новая задача на этот день", "Перенести на завтра", "Перенести на сегодня", "Перенести на следующую неделю",
      "Предыдущий месяц", "Следующий месяц", "Предыдущая неделя", "Следующая неделя", "Календарь не загрузился", "ещё 3", "Срок перенесён: 12 ноября, четверг",
      "Задачи показаны по сроку, события — по времени. Срок задачи можно перетащить на другой день."]) {
      expect(translate(ru), ru).not.toBeNull();
    }
  });
});
