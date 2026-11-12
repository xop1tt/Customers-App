// Справочник отделов поверх текста профиля (ADR-077) в демо-режиме ?team.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { window.history.replaceState({}, "", "/?team"); });

import { resetChatMock } from "../../api/chatMock";
import { resetWsMock, setWsMockRole } from "../../api/wsMock";
import { departmentError, departmentsOf, renamePlan, sameDepartment, teamOf } from "../../lib/departments";
import type { TeamMember } from "../../api/types";
import { getState, openCollection, openRecord, setState } from "../../state/store";
import { App } from "../App";

afterEach(cleanup);
beforeEach(() => { resetWsMock(); resetChatMock(); });

const m = (id: string, department: string, extra: Partial<TeamMember> = {}): TeamMember => ({
  user_id: id, display_name: id, avatar: null, email: null, role: "employee", role_name: "Сотрудник", rank: 40, joined_at: null, title: "",
  department, manager_id: null, hired_on: null, last_seen: null, online: false, can_edit: true, ...extra,
});

describe("lib/departments", () => {
  it("группирует без учёта регистра, «Без отдела» в конце", () => {
    const d = departmentsOf([m("a", "Продажи"), m("b", "продажи "), m("c", ""), m("d", "Аналитика")]);
    expect(d.map((x) => x.name)).toEqual(["Аналитика", "Продажи", ""]);
    expect(d[1]?.members).toHaveLength(2);
  });
  it("план переименования учитывает права", () => {
    const dep = departmentsOf([m("a", "Продажи"), m("b", "Продажи", { can_edit: false })])[0]!;
    expect(renamePlan(dep, "Продажи").change).toHaveLength(0);
    const p = renamePlan(dep, "Sales");
    expect(p.change.map((x) => x.user_id)).toEqual(["a"]);
    expect(p.locked).toBe(1);
  });
  it("проверка названия", () => {
    expect(departmentError(" ")).not.toBeNull();
    expect(departmentError("x".repeat(121))).not.toBeNull();
    expect(departmentError("Продажи")).toBeNull();
  });
  it("моя команда и мой отдел", () => {
    const t = [m("me", "A"), m("x", "A", { manager_id: "me" }), m("y", "B", { manager_id: "x" }), m("z", "A")];
    expect([...teamOf(t, "me")].sort()).toEqual(["x", "y"]);
    expect([...sameDepartment(t, "me")].sort()).toEqual(["x", "z"]);
  });
});

describe("вкладка «Отделы»", () => {
  it("показывает отделы и переименовывает их у участников", async () => {
    render(<App />);
    setWsMockRole("owner");
    await waitFor(() => expect(getState().chat?.available).toBe(true));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Модули" })).getByRole("button", { name: /^Команда/ }));
    const n = await screen.findByLabelText("Навигация");
    fireEvent.click(await within(n).findByRole("button", { name: /Сотрудники/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Отделы" }));
    const sec = await screen.findByLabelText("Отделы");
    expect(within(sec).getByText("Продажи")).toBeInTheDocument();
    fireEvent.click(within(sec).getAllByRole("button", { name: "Переименовать…" })[0]!);
    const input = await screen.findByLabelText("Название отдела");
    fireEvent.change(input, { target: { value: "Коммерция" } });
    fireEvent.click(screen.getByRole("button", { name: "Переименовать" }));
    await waitFor(() => expect(within(screen.getByLabelText("Отделы")).getByText("Коммерция")).toBeInTheDocument());
  });
});

describe("фильтр «чьи записи»", () => {
  it("в коллекции есть переключатель «Моей команды», «Моего отдела» и он сужает выдачу", async () => {
    render(<App />);
    await waitFor(() => expect(getState().collections.length).toBeGreaterThan(0));
    const col = getState().collections.find((c) => c.entity_type === "company") ?? getState().collections[0]!;
    openCollection(col.id);
    const all = await screen.findByRole("tab", { name: "Все" });
    expect(all).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Моей команды" })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Моего отдела" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Моего отдела" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Моего отдела", selected: true })).toBeInTheDocument());
  });
});

describe("«Обсудить» в карточке", () => {
  it("создаёт обсуждение с прикреплённой карточкой и открывает чат", async () => {
    render(<App />);
    await waitFor(() => expect(getState().chat?.available).toBe(true));
    await waitFor(() => expect(getState().team.length).toBeGreaterThan(1));
    const col = getState().collections.find((c) => c.entity_type === "company")!;
    openCollection(col.id);
    const { api } = await import("../../api");
    const items = (await api.wsCollectionItems(col.id)).items;
    expect(items.length).toBeGreaterThan(0);
    openRecord("companies", items[0]!.id);
    fireEvent.click(await screen.findByRole("button", { name: "Обсудить" }));
    const dlg = await screen.findByRole("dialog");
    fireEvent.click(within(dlg).getAllByRole("checkbox")[0]!);
    fireEvent.click(within(dlg).getByRole("button", { name: "Начать обсуждение" }));
    await waitFor(() => expect(getState().section).toBe("chat"));
    expect(getState().chatOpen).toBeTruthy();
  });
});

describe("«Мои права»", () => {
  it("показывает роль и список разрешённого и недоступного", async () => {
    const { setWsMockRole } = await import("../../api/wsMock");
    setWsMockRole("viewer");
    render(<App />);
    await waitFor(() => expect(getState().ws?.isCloud).toBe(true));
    setState({ workspaceOpen: true });
    fireEvent.click(await screen.findByRole("button", { name: "Что мне разрешено" }));
    expect(await screen.findByLabelText("Разрешено")).toBeInTheDocument();
    expect(screen.getByLabelText("Недоступно").children.length).toBeGreaterThan(0);
  });
});
