import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import type { CrmRecord, WsState } from "../../api/types";
import { resetWsMock } from "../../api/wsMock";
import { can, cellText, ENTITIES, fromInput, toInput } from "../../lib/crm";
import { SECTIONS } from "../../lib/leads";
import { moduleOf } from "../../lib/modules";
import { getState, setState } from "../../state/store";
import { App } from "../App";
import { canManage } from "./Collections";

afterEach(cleanup);
beforeEach(() => resetWsMock());

const rec = (over: Partial<CrmRecord>): CrmRecord => ({ id: "r1", workspace_id: "w", version: 1, created_at: "", updated_at: "", created_by: "a", ...over });
const lookup = { members: [], stages: new Map(), companies: new Map(), pipelines: new Map() };

describe("описание CRM-сущностей", () => {
  it("преобразует ввод в значения ядра и обратно", () => {
    expect(fromInput("list", "+7 900, a@b.ru; ,")).toEqual(["+7 900", "a@b.ru"]);
    expect(fromInput("money", "180 000,50")).toBe(180000.5);
    expect(fromInput("text", "  ")).toBeNull();
    expect(toInput("list", ["a", "b"])).toBe("a, b");
    expect(toInput("text", null)).toBe("");
    const iso = fromInput("datetime", "2026-11-10T09:30") as string;
    expect(toInput("datetime", iso)).toBe("2026-11-10T09:30");
  });

  it("решает права так же, как сервер: своё — с edit_own, чужое — только с edit", () => {
    const employee = ["records.view", "records.create", "records.edit_own"];
    expect(can(employee, "edit", rec({ created_by: "me" }), "me")).toBe(true);
    expect(can(employee, "edit", rec({ created_by: "x", owner_id: "me" }), "me")).toBe(true);
    expect(can(employee, "edit", rec({ created_by: "x", assignee_id: "me" }), "me")).toBe(true);
    expect(can(employee, "edit", rec({ created_by: "x" }), "me")).toBe(false);
    expect(can(employee, "delete")).toBe(false);
    expect(can(["records.view"], "create")).toBe(false);
    expect(can([...employee, "records.edit"], "edit", rec({ created_by: "x" }), "me")).toBe(true);
  });

  it("подписывает значения перечислений и суммы", () => {
    expect(cellText(ENTITIES.deal, rec({ status: "won" }), "status", lookup)).toBe("Выиграна");
    expect(cellText(ENTITIES.task, rec({ priority: "urgent" }), "priority", lookup)).toBe("Срочный");
    expect(cellText(ENTITIES.deal, rec({ amount: 1500, currency: "RUB" }), "amount", lookup)).toMatch(/1\s?500/);
  });

  it("личной коллекцией управляет автор, общей — с collections.manage", () => {
    expect(canManage({ visibility: "private", created_by: "me" }, [], "me")).toBe(true);
    expect(canManage({ visibility: "private", created_by: "x" }, ["collections.manage"], "me")).toBe(false);
    expect(canManage({ visibility: "workspace", created_by: "me" }, [], "me")).toBe(false);
    expect(canManage({ visibility: "workspace", created_by: "x" }, ["collections.manage"], "me")).toBe(true);
  });

  it("у каждого раздела есть эмодзи для заголовка", () => {
    for (const s of Object.values(SECTIONS)) expect(s.emoji.length).toBeGreaterThan(0);
  });
});

describe("демо-ядро Workspace", () => {
  it("ведёт версии, статус сделки по этапу и историю этапов", async () => {
    const stages = (await api.wsList("pipeline_stages", { sort: [{ field: "position", dir: "asc" }] })).items;
    const pipe = stages[0]!.pipeline_id as string;
    const deal = await api.wsSave("deals", null, { title: "Тест", pipeline_id: pipe, stage_id: stages[0]!.id });
    expect(deal).toMatchObject({ version: 1, status: "open" });
    const won = stages.find((s) => s.kind === "won")!;
    const after = await api.wsSave("deals", deal.id, { stage_id: won.id });
    expect(after).toMatchObject({ version: 2, status: "won" });
    expect(after.closed_at).toBeTruthy();
    const card = await api.wsCard("deals", deal.id);
    expect(card.history).toHaveLength(1);
  });

  it("удаляет в корзину и не даёт править удалённое", async () => {
    const c = await api.wsSave("companies", null, { name: "Корзина" });
    await api.wsDelete("companies", c.id);
    expect((await api.wsList("companies", { search: "Корзина" })).total).toBe(0);
    expect((await api.wsList("companies", { search: "Корзина", deleted: true })).total).toBe(1);
    await expect(api.wsSave("companies", c.id, { name: "Новое" })).rejects.toMatchObject({ message: expect.stringContaining("удалена") });
    await api.wsRestore("companies", c.id);
    expect((await api.wsList("companies", { search: "Корзина" })).total).toBe(1);
  });

  it("требует обязательные поля и находит дубликаты до сохранения", async () => {
    await expect(api.wsSave("companies", null, { name: "" })).rejects.toMatchObject({ message: expect.stringContaining("name") });
    const dup = await api.wsDuplicates("companies", { name: "ООО «Северный ветер»" });
    expect(dup.map((d) => d.name)).toContain("ООО «Северный ветер»");
  });

  it("коллекции считают записи по своим фильтрам и меняют порядок", async () => {
    const list = await api.wsCollections();
    expect(list.map((c) => c.builtin)).toEqual(["all_clients", "my_clients", "new_leads", "deals_this_week", "overdue_tasks", "won_deals", "lost_deals"]);
    expect(list.find((c) => c.builtin === "overdue_tasks")!.count).toBe(1);
    await api.wsReorderCollections([list[6]!.id, ...list.slice(0, 6).map((c) => c.id)]);
    expect((await api.wsCollections())[0]!.builtin).toBe("lost_deals");
  });

  it("перенос лида повторно не дублирует компанию", async () => {
    const lead = getState().snap.leads[0] ?? (await api.snapshot()).leads[0]!;
    const first = await api.wsConvertLead(lead.id, { createDeal: true });
    const again = await api.wsConvertLead(lead.id, { createDeal: true });
    expect(first.reusedCompany).toBe(false);
    expect(first.dealId).toBeTruthy();
    expect(again).toMatchObject({ companyId: first.companyId, reusedCompany: true, dealId: null });
  });
});

async function openCrm() {
  const rail = await screen.findByRole("navigation", { name: "Модули" });
  fireEvent.click(await within(rail).findByRole("button", { name: /^CRM/ }));
}

describe("интерфейс CRM", () => {
  it("модуль CRM рейки: «Сегодня», «Сделки» и коллекции; разделы поиска в нём не показываются; коллекция открывается", async () => {
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    expect(within(nav).getByText("Все лиды")).toBeInTheDocument();
    expect(within(nav).queryByText("Коллекции")).toBeNull();
    await openCrm();
    const title = await within(nav).findByText("Коллекции");
    expect(getState().section).toBe("today");
    expect(within(nav).getByRole("button", { name: "Сделки" }).compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(nav).queryByText("Все лиды")).toBeNull();
    expect(within(nav).queryByText("По источнику")).toBeNull();
    fireEvent.click(await within(nav).findByText("Все клиенты"));
    const header = document.querySelector(".topbar-title") as HTMLElement;
    await waitFor(() => expect(header).toHaveTextContent("Все клиенты"));
    fireEvent.click(await screen.findByText("ООО «Северный ветер»"));
    const card = await screen.findByLabelText("Карточка записи");
    expect(await within(card).findByDisplayValue("ООО «Северный ветер»")).toBeInTheDocument();
    expect(within(card).getByText("Ольга Смирнова")).toBeInTheDocument();
  });

  it("панель карточки закрывается кнопкой и клавишей Esc; в шапке панели CRM виден переключатель рабочего пространства", async () => {
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    await openCrm();
    const wsBtn = await within(nav).findByRole("button", { name: /^Рабочее пространство:/ });
    expect(wsBtn).toBeInTheDocument();
    fireEvent.click(await within(nav).findByText("Все клиенты"));
    fireEvent.click(await screen.findByText("ООО «Северный ветер»"));
    const card = await screen.findByLabelText("Карточка записи");
    fireEvent.click(within(card).getByRole("button", { name: "Закрыть" }));
    await waitFor(() => expect(screen.queryByLabelText("Карточка записи")).toBeNull());
    fireEvent.click(await screen.findByText("ООО «Северный ветер»"));
    await screen.findByLabelText("Карточка записи");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("Карточка записи")).toBeNull());
  });

  it("аватары участников видны только в облачном рабочем пространстве из нескольких человек", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    await waitFor(() => expect(getState().ws).not.toBeNull());
    expect(document.querySelector(".ws-avatars")).toBeNull();
    const ws = getState().ws as WsState;
    const people = ["Алексей", "Борис", "Вера", "Глеб", "Дина", "Егор"].map((n, i) => ({ userId: `u${i}`, displayName: n, role: "employee", roleName: "Сотрудник", rank: 40, avatarPath: null, email: null }));
    setState({ ws: { ...ws, isCloud: true, members: people } });
    const btn = await screen.findByRole("button", { name: "Участники: 6" });
    // Широкое окно: 4 аватара и «+2»; узкое (< 1100 px): один и «+5».
    const wide = window.innerWidth >= 1100;
    expect(btn.querySelectorAll(".ws-avatar")).toHaveLength(wide ? 5 : 2);
    expect(btn).toHaveTextContent(wide ? "+2" : "+5");
    const topbar = document.querySelector(".topbar") as HTMLElement;
    const order = [...topbar.children].map((el) => el.className);
    expect(order.findIndex((c) => c.includes("ws-avatars"))).toBeGreaterThan(-1);
    // «Найти лиды» есть только в модуле «Поиск».
    expect(order.some((c) => c.includes("search-btn"))).toBe(moduleOf(getState().section) === "search");
  });

  it("в верхней строке нет «Найти лиды», синхронизации и кнопок сворачивания панелей; «Найти лиды» остаётся в поиске", async () => {
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    await waitFor(() => expect(getState().phase).toBe("ready"));
    setState({ section: "home" });
    const top = () => document.querySelector("header.topbar") as HTMLElement;
    expect(await within(top()).findByRole("button", { name: "Найти лиды" })).toBeInTheDocument();
    await openCrm();
    await within(nav).findByText("Коллекции");
    expect(within(top()).queryByRole("button", { name: "Найти лиды" })).toBeNull();
    expect(top().querySelector(".sync-chip")).toBeNull();
    expect(within(top()).queryByRole("button", { name: /Свернуть|Показать панель/ })).toBeNull();
  });

  it("новая коллекция создаётся из диалога с эмодзи и открывается", async () => {
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    await openCrm();
    fireEvent.click(await within(nav).findByRole("button", { name: "Новая коллекция" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText(/Клиенты из Казани/), { target: { value: "Горячие" } });
    fireEvent.click(within(dialog).getByRole("option", { name: "🔥" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(getState().section).toBe("collection"));
    await waitFor(() => expect(document.querySelector(".topbar-title")).toHaveTextContent("🔥Горячие"));
  });
});

describe("редакторы воронок и ролей (демо-ядро)", () => {
  it("удаление этапа переносит сделки на выбранный этап", async () => {
    const stages = (await api.wsList("pipeline_stages", { sort: [{ field: "position", dir: "asc" }] })).items;
    const deals = (await api.wsList("deals")).items;
    const from = stages.find((s) => deals.some((d) => d.stage_id === s.id))!;
    const to = stages.find((s) => s.id !== from.id && s.pipeline_id === from.pipeline_id)!;
    const n = deals.filter((d) => d.stage_id === from.id).length;
    expect(await api.wsDeleteStage(from.id, to.id)).toEqual({ moved: n });
    expect((await api.wsList("deals")).items.filter((d) => d.stage_id === from.id)).toHaveLength(0);
    expect((await api.wsList("pipeline_stages")).items.some((s) => s.id === from.id)).toBe(false);
    await expect(api.wsDeleteStage(to.id, to.id)).rejects.toBeDefined();
  });

  it("локальное рабочее пространство не показывает роли", async () => {
    expect(await api.wsRoles()).toEqual({ roles: [], catalog: [] });
  });
});

describe("свои поля (демо-ядро)", () => {
  it("значения хранятся отдельными записями и приходят в карточке", async () => {
    const company = (await api.wsList("companies")).items[0]!;
    const field = await api.wsSave("custom_fields", null, { entity_type: "company", label: "Сегмент", kind: "select", options: ["A", "B"], position: 1 });
    const value = await api.wsSave("custom_field_values", null, { field_id: field.id, entity_type: "company", entity_id: company.id, value: "A" });
    const card = await api.wsCard("companies", company.id);
    expect(card.custom_field_values?.map((v) => v.id)).toEqual([value.id]);
    await api.wsSave("custom_field_values", value.id, { value: null });
    expect((await api.wsCard("companies", company.id)).custom_field_values?.[0]?.value).toBeNull();
  });
});

describe("загрузка локальной CRM (демо-ядро)", () => {
  it("локальная учётная запись не загружает в облако", async () => {
    await expect(api.wsUploadLocal()).rejects.toBeDefined();
  });
});

describe("присутствие (демо-ядро)", () => {
  it("в локальном Workspace никого нет", async () => {
    expect(await api.wsPresence()).toEqual([]);
  });
});

describe("вложения (демо-ядро)", () => {
  it("метаданные приходят в карточке, большие файлы отклоняются", async () => {
    const company = (await api.wsList("companies")).items[0]!;
    const a = await api.wsAttachAdd("company", company.id, "договор.pdf", "application/pdf", btoa("%PDF"));
    expect(a.size).toBe(4);
    expect((await api.wsCard("companies", company.id)).attachments?.map((x) => x.id)).toContain(a.id);
    await expect(api.wsAttachAdd("company", company.id, "x.bin", "", "A".repeat(7_500_000))).rejects.toBeDefined();
  });
});
