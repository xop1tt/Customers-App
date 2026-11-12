import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import type { CrmRecord } from "../../api/types";
import { resetWsMock } from "../../api/wsMock";
import { getState, openRecord, setState } from "../../state/store";
import { CrmCard } from "./CrmCard";
import { DealBoard } from "./DealBoard";

afterEach(() => { cleanup(); vi.restoreAllMocks(); openRecord("companies", null); });
beforeEach(async () => {
  resetWsMock();
  setState({ ws: await api.wsState(), account: null });
});

const card = () => render(<aside aria-label="Карточка записи"><CrmCard /></aside>);
const changed = () => setState((s) => ({ wsVersion: s.wsVersion + 1 }));
const activities = async (table: string, id: string) => ((await api.wsCard(table, id)).activities ?? []) as CrmRecord[];

describe("коммуникации в карточке", () => {
  it("«Позвонить» набирает номер и записывает звонок в ленту", async () => {
    const call = vi.spyOn(api, "callPhone");
    const c = await api.wsSave("contacts", null, { first_name: "Иван", last_name: "Петров", phones: ["+79991112233"] });
    openRecord("contacts", c.id);
    card();
    const bar = await screen.findByRole("group", { name: "Связаться" });
    fireEvent.click(within(bar).getByRole("button", { name: "Позвонить" }));
    await waitFor(async () => expect(await activities("contacts", c.id)).toHaveLength(1));
    expect(call).toHaveBeenCalledWith("+79991112233");
    expect((await activities("contacts", c.id))[0]).toMatchObject({ type: "call", summary: "Звонок: +79991112233", payload: { phone: "+79991112233" } });
    expect(getState().toasts.at(-1)?.text).toBe("Звонок записан в ленту");
  });

  it("без телефона кнопка звонка недоступна; у компании есть телефоны её контактов", async () => {
    const co = await api.wsSave("companies", null, { name: "Ромашка" });
    await api.wsSave("contacts", null, { first_name: "Анна", company_id: co.id, phones: ["+79990000001"] });
    const empty = await api.wsSave("contacts", null, { first_name: "Без телефона" });
    openRecord("contacts", empty.id);
    const { unmount } = card();
    expect((within(await screen.findByRole("group", { name: "Связаться" })).getByRole("button", { name: "Позвонить" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    openRecord("companies", co.id);
    card();
    const bar = await screen.findByRole("group", { name: "Связаться" });
    await waitFor(() => expect((within(bar).getByRole("button", { name: "Позвонить" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("«Написать» подставляет шаблон, открывает письмо в почте и записывает его в ленту", async () => {
    const open = vi.spyOn(api, "openInMailApp");
    setState({ account: { signature: "Максим, Customers" } as never });
    const co = await api.wsSave("companies", null, { name: "Ромашка" });
    const c = await api.wsSave("contacts", null, { first_name: "Иван", company_id: co.id, emails: ["ivan@romashka.ru"] });
    openRecord("contacts", c.id);
    card();
    fireEvent.click(within(await screen.findByRole("group", { name: "Связаться" })).getByRole("button", { name: "Написать" }));
    const dialog = await screen.findByRole("dialog", { name: "Написать письмо" });
    const subject = within(dialog).getByRole("textbox", { name: "Тема" }) as HTMLInputElement;
    await waitFor(() => expect(subject.value).toBe("Знакомство: Ромашка"));
    const body = within(dialog).getByRole("textbox", { name: "Текст" }) as HTMLTextAreaElement;
    expect(body.value.startsWith("Здравствуйте, Иван!")).toBe(true);
    expect(body.value.endsWith("Максим, Customers")).toBe(true);

    fireEvent.change(subject, { target: { value: "Встреча в пятницу" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Открыть в почте" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(open).toHaveBeenCalledWith("ivan@romashka.ru", "Встреча в пятницу", body.value);
    expect((await activities("contacts", c.id))[0]).toMatchObject({ type: "email", summary: "Письмо: Встреча в пятницу", payload: { to: "ivan@romashka.ru", via: "mail_app" } });
  });

  it("с настроенным сервером письмо отправляется сразу; без адреса кнопки неактивны", async () => {
    vi.spyOn(api, "mailState").mockResolvedValue({ account: null, delivery: "smtp", hasPassword: true, smtpReady: true, signature: "" });
    const send = vi.spyOn(api, "mailSend").mockResolvedValue("Письмо отправлено на a@b.ru");
    const co = await api.wsSave("companies", null, { name: "Без почты" });
    openRecord("companies", co.id);
    card();
    fireEvent.click(within(await screen.findByRole("group", { name: "Связаться" })).getByRole("button", { name: "Написать" }));
    const dialog = await screen.findByRole("dialog", { name: "Написать письмо" });
    expect(within(dialog).getByText(/В карточке нет почты/)).toBeTruthy();
    const sendBtn = await within(dialog).findByRole("button", { name: "Отправить" });
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Кому" }), { target: { value: "a@b.ru" } });
    fireEvent.click(sendBtn);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(send).toHaveBeenCalledWith("a@b.ru", expect.any(String), expect.any(String));
    expect((await activities("companies", co.id))[0]).toMatchObject({ type: "email", payload: { via: "smtp" } });
  });

  it("«Встреча» создаёт задачу со сроком у записи", async () => {
    const co = await api.wsSave("companies", null, { name: "Ромашка" });
    openRecord("companies", co.id);
    card();
    fireEvent.click(within(await screen.findByRole("group", { name: "Связаться" })).getByRole("button", { name: "Встреча" }));
    const dialog = await screen.findByRole("dialog", { name: "Запланировать встречу" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Место или ссылка" }), { target: { value: "Офис клиента" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Запланировать" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const tasks = (await api.wsCard("companies", co.id)).tasks ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Встреча: Ромашка", description: "Офис клиента", entity_type: "company", status: "todo" });
    expect(typeof tasks[0]!.due_at).toBe("string");
  });
});

describe("следующее действие сделки", () => {
  const openDeal = async () => {
    const deals = (await api.wsList("deals", { limit: 100 })).items;
    const stages = (await api.wsList("pipeline_stages", { limit: 100 })).items;
    const open = new Set(stages.filter((s) => s.kind === "open").map((s) => s.id));
    return deals.find((d) => open.has(String(d.stage_id)))!;
  };

  it("предупреждает, если шага нет, и планирует его из карточки", async () => {
    const deal = await api.wsSave("deals", (await openDeal()).id, {});
    for (const task of (await api.wsCard("deals", deal.id)).tasks ?? []) await api.wsSave("tasks", task.id, { status: "done" });
    openRecord("deals", deal.id);
    card();
    const sec = await screen.findByRole("region", { name: "Следующее действие" });
    await within(sec).findByText("Нет следующего шага: сделка может остыть.");
    fireEvent.click(within(sec).getByRole("button", { name: "Запланировать" }));
    fireEvent.change(within(sec).getByRole("textbox", { name: "Следующий шаг" }), { target: { value: "Отправить КП" } });
    fireEvent.click(within(sec).getByRole("button", { name: "Добавить" }));
    await waitFor(async () => expect(((await api.wsCard("deals", deal.id)).tasks ?? []).some((x) => x.title === "Отправить КП" && x.status === "todo")).toBe(true));
    changed();
    expect(await within(await screen.findByRole("region", { name: "Следующее действие" })).findByRole("button", { name: /Отправить КП/ })).toBeTruthy();
  });

  it("доска показывает ближайший шаг или предупреждение на карточках открытых сделок", async () => {
    const deal = await openDeal();
    await api.wsSave("tasks", null, { title: "Созвон по договору", entity_type: "deal", entity_id: deal.id, status: "todo", due_at: new Date(Date.now() - 86400000).toISOString() });
    await api.wsSave("deals", null, { title: "Сделка без шага", pipeline_id: deal.pipeline_id, stage_id: deal.stage_id, currency: "RUB" });
    render(<DealBoard />);
    const title = await screen.findByText(String(deal.title));
    const article = title.closest("article") as HTMLElement;
    // Просроченная задача раньше остальных: она и есть следующий шаг, строка подсвечена.
    const line = (await within(article).findByText("Созвон по договору")).closest(".board-next") as HTMLElement;
    expect(line.classList.contains("bad")).toBe(true);
    const other = (await screen.findByText("Сделка без шага")).closest("article") as HTMLElement;
    expect(within(other).getByText("Нет следующего шага")).toBeTruthy();
  });
});
