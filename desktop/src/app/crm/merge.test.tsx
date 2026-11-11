import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock, setWsMockRole } from "../../api/wsMock";
import { translate } from "../../lib/i18n";
import { getState, openRecord, setState } from "../../state/store";
import { CrmCard } from "./CrmCard";

afterEach(() => { cleanup(); openRecord("companies", null); });
beforeEach(async () => {
  resetWsMock();
  setState({ ws: await api.wsState() });
});

const card = () => render(<aside aria-label="Карточка записи"><CrmCard /></aside>);
/** После записи демо-ядро сообщает об изменении: перечитать карточку. */
const changed = () => setState((s) => ({ wsVersion: s.wsVersion + 1 }));

describe("объединение дубликатов", () => {
  it("переносит связанное, выбирает значения и отменяется из карточки", async () => {
    const keep = await api.wsSave("companies", null, { name: "Ромашка", phones: ["+7 999 111-22-33"] });
    const dup = await api.wsSave("companies", null, { name: "Ромашка", inn: "1655000000", phones: ["+79990000000"] });
    const contact = await api.wsSave("contacts", null, { first_name: "Иван", company_id: dup.id });
    const task = await api.wsSave("tasks", null, { title: "Позвонить", entity_type: "company", entity_id: dup.id });
    openRecord("companies", keep.id);
    card();
    fireEvent.click(await screen.findByRole("button", { name: "Объединить с дубликатом" }));
    const dialog = await screen.findByRole("dialog");
    const similar = await within(dialog).findByRole("list", { name: "Похожие записи" });
    fireEvent.click(within(similar).getByRole("button", { name: /Ромашка/ }));

    const table = await within(screen.getByRole("dialog")).findByRole("table", { name: "Различающиеся поля" });
    const rows = within(table).getAllByRole("row").slice(1).map((r) => r.firstElementChild!.textContent);
    expect(rows).toEqual(["ИНН", "Телефоны"]);
    expect((within(table).getByRole("radio", { name: "Оба списка" }) as HTMLInputElement).checked).toBe(true);
    expect((within(table).getByRole("radio", { name: "1655000000" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Объединить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const kept = (await api.wsCard("companies", keep.id)).record;
    expect([kept.inn, kept.phones]).toEqual(["1655000000", ["+7 999 111-22-33", "+79990000000"]]);
    expect((await api.wsCard("companies", dup.id)).record.deleted_at).toBeTruthy();
    expect((await api.wsCard("contacts", contact.id)).record.company_id).toBe(keep.id);
    expect((await api.wsCard("tasks", task.id)).record.entity_id).toBe(keep.id);
    expect(getState().toasts.at(-1)).toMatchObject({ kind: "success", text: "Объединено. К записи перешло связанных: 2" });

    changed();
    const notice = await screen.findByText("Объединено с «Ромашка».");
    fireEvent.click(within(notice.closest(".notice") as HTMLElement).getByRole("button", { name: "Отменить" }));
    await waitFor(async () => expect((await api.wsCard("companies", dup.id)).record.deleted_at).toBeNull());
    expect((await api.wsCard("contacts", contact.id)).record.company_id).toBe(dup.id);
    expect((await api.wsCard("companies", keep.id)).record.inn ?? null).toBeNull();
    expect(await api.wsMergeLast()).toBeNull();
  });

  it("можно оставить вторую запись; поиск находит непохожую", async () => {
    const a = await api.wsSave("contacts", null, { first_name: "Анна", emails: ["anna@a.ru"] });
    const b = await api.wsSave("contacts", null, { first_name: "Аня", last_name: "Смирнова" });
    openRecord("contacts", a.id);
    card();
    fireEvent.click(await screen.findByRole("button", { name: "Объединить с дубликатом" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Похожих записей нет. Найдите вторую запись поиском.");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Поиск второй записи" }), { target: { value: "Смирнова" } });
    fireEvent.click(within(await within(dialog).findByRole("list", { name: "Найденные записи" })).getByRole("button", { name: /Аня Смирнова/ }));
    fireEvent.click(await within(screen.getByRole("dialog")).findByRole("tab", { name: "Аня Смирнова" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Объединить" }));
    await waitFor(() => expect(getState().record).toEqual({ table: "contacts", id: b.id }));
    const kept = (await api.wsCard("contacts", b.id)).record;
    expect([kept.first_name, kept.emails]).toEqual(["Аня", ["anna@a.ru"]]);
    expect((await api.wsCard("contacts", a.id)).record.deleted_at).toBeTruthy();
  });

  it("сотруднику кнопка не показывается, ядро тоже не даёт объединить", async () => {
    const a = await api.wsSave("companies", null, { name: "Альфа" });
    const b = await api.wsSave("companies", null, { name: "Альфа" });
    setWsMockRole("employee");
    setState({ ws: await api.wsState() });
    openRecord("companies", a.id);
    card();
    await screen.findByRole("button", { name: "Закрыть" });
    expect(screen.queryByRole("button", { name: "Объединить с дубликатом" })).toBeNull();
    await expect(api.wsMerge({ entity: "companies", keep: a.id, remove: b.id, values: {} })).rejects.toMatchObject({ message: expect.stringContaining("Недостаточно прав") });
  });

  it("тексты объединения переведены на английский", () => {
    for (const ru of ["Объединить с дубликатом", "Объединить: Ромашка", "Объединение записей", "Остаётся", "Вторая запись", "Оба списка", "Похожие", "Найдено", "Различающиеся поля",
      "Поиск второй записи", "Найти: компании", "Ничего не найдено.", "Похожих записей нет. Найдите вторую запись поиском.", "Объединено с «Ромашка».", "Объединено. К записи перешло связанных: 3",
      "Объединение отменено: «Ромашка» восстановлена", "Выберите запись, которая дублирует эту. На следующем шаге вы решите, какие значения оставить.", "Объединить", "пусто",
      "Значения полей совпадают или у второй записи пусто: оставшаяся запись не изменится."]) {
      expect(translate(ru), ru).not.toBeNull();
    }
  });
});
