import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock } from "../../api/wsMock";
import { boot, getState, setState } from "../../state/store";
import { CollectionPage } from "./CollectionPage";
import { DealBoard } from "./DealBoard";
import { StartChecklist } from "./StartChecklist";

afterEach(cleanup);
beforeEach(async () => {
  resetWsMock();
  try { localStorage.clear(); } catch { /* нет хранилища */ }
  await boot();
  setState({ ws: await api.wsState(), record: null, workspaceOpen: false });
});

async function clear(table: string) {
  for (const r of (await api.wsList(table, { limit: 5000 })).items) await api.wsDelete(table, r.id);
}

describe("«Начало работы» на «Сегодня»", () => {
  it("показывает несделанные шаги с кнопками, «Скрыть» убирает карточку и после перезапуска", async () => {
    await clear("deals");
    await clear("tasks");
    const first = render(<StartChecklist />);
    const card = await screen.findByRole("region", { name: "Начало работы" });
    expect(within(card).getByText(/из 5/)).toBeTruthy();
    expect(within(card).getByText("Добавить клиентов").textContent).toContain("Добавить клиентов");
    fireEvent.click(within(card).getByRole("button", { name: "Создать" }));
    expect(getState().record).toEqual({ table: "deals", id: "new" });
    fireEvent.click(within(card).getByRole("button", { name: "Запланировать" }));
    expect(getState().record).toEqual({ table: "tasks", id: "new" });
    fireEvent.click(within(card).getByRole("button", { name: "Скрыть" }));
    expect(screen.queryByRole("region", { name: "Начало работы" })).toBeNull();
    first.unmount();
    render(<StartChecklist />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("region", { name: "Начало работы" })).toBeNull();
  });

  it("исчезает, когда всё сделано", async () => {
    const pipe = (await api.wsList("pipeline_stages", { limit: 1 })).items[0]!;
    await api.wsSave("deals", null, { title: "Первая", pipeline_id: pipe.pipeline_id, stage_id: pipe.id });
    await api.wsSave("tasks", null, { title: "Позвонить", status: "todo" });
    await api.wsSave("companies", null, { name: "Ромашка" });
    setState({ account: { ...getState().account!, welcomeDone: true, autoBackup: true } });
    render(<StartChecklist />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("region", { name: "Начало работы" })).toBeNull();
  });
});

describe("пустые экраны CRM", () => {
  it("«Все клиенты» без записей: импорт, новая компания и поиск", async () => {
    await clear("companies");
    const all = (await api.wsCollections()).find((c) => c.entity_type === "company" && !c.config.filters?.length)!;
    setState({ collectionId: all.id });
    render(<CollectionPage />);
    expect(await screen.findByText("Здесь будут ваши клиенты")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Импорт из Excel или CSV" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Найти новых" }));
    expect(getState().section).toBe("home");
  });

  it("доска без сделок: «Сделка», лиды и настройка этапов", async () => {
    await clear("deals");
    render(<DealBoard />);
    const empty = (await screen.findByText("Сделок пока нет")).closest(".empty") as HTMLElement;
    fireEvent.click(within(empty).getByRole("button", { name: "Новая сделка" }));
    expect(getState().record).toEqual({ table: "deals", id: "new" });
    fireEvent.click(screen.getByRole("button", { name: "Настроить этапы" }));
    expect(getState().workspaceOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Открыть лиды" }));
    await waitFor(() => expect(getState().section).toBe("new"));
  });
});
