// Панель управления рабочим пространством справа: разделы по роли, структура, закрытие.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { resetWsMock, setWsMockRole } from "../../api/wsMock";
import { getState, setState } from "../../state/store";
import { WorkspaceDialog } from "./WorkspaceDialog";

vi.hoisted(() => { window.history.replaceState({}, "", "/?team"); });

afterEach(cleanup);
beforeEach(() => resetWsMock());

const open = async (role: "owner" | "employee") => {
  setWsMockRole(role);
  setState({ ws: await api.wsState(), workspaceOpen: true });
  render(<WorkspaceDialog />);
  return screen.getByRole("dialog", { name: "Рабочее пространство" });
};
const tiles = (panel: HTMLElement) => within(panel).getAllByRole("button").filter((b) => b.classList.contains("ws-tile")).map((b) => b.querySelector("strong")!.textContent);
const tile = (panel: HTMLElement, name: string) => within(panel).getByRole("button", { name: new RegExp(name) });

describe("панель рабочего пространства", () => {
  it("владелец видит плитки всех групп, включая «Опасную зону»", async () => {
    const panel = await open("owner");
    expect(tiles(panel)).toEqual(["Сотрудники", "Приглашения", "Отделы и должности", "Воронки и этапы", "Свои поля", "Роли и права", "Коннекторы", "Синхронизация", "Журнал действий", "Экспорт и копии", "Опасная зона"]);
    fireEvent.click(tile(panel, "Отделы и должности"));
    expect(within(panel).getByRole("list", { name: "Должности и их возможности" }).children.length).toBeGreaterThan(5);
  });

  it("плитка открывает раздел, «Назад к плиткам» возвращает, Esc сначала возвращает, затем закрывает", async () => {
    const panel = await open("owner");
    fireEvent.click(tile(panel, "Синхронизация"));
    expect(within(panel).queryByRole("button", { name: /Сотрудники/ })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Назад к плиткам" }));
    expect(tile(panel, "Сотрудники")).toBeTruthy();
    fireEvent.click(tile(panel, "Синхронизация"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tile(panel, "Сотрудники")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(getState().workspaceOpen).toBe(false);
  });

  it("сотрудник не видит опасную зону и не может назначать должности", async () => {
    const panel = await open("employee");
    expect(tiles(panel)).not.toContain("Опасная зона");
    expect(tiles(panel)).toContain("Выход");
    expect(tiles(panel)).not.toContain("Журнал действий");
    fireEvent.click(tile(panel, "Отделы и должности"));
    expect(within(panel).getByText(/Назначать должности вы не можете/)).toBeTruthy();
  });

  it("«Управлять отделами» открывает «Сотрудников» и закрывает панель; крестик закрывает", async () => {
    const panel = await open("owner");
    fireEvent.click(tile(panel, "Отделы и должности"));
    fireEvent.click(within(panel).getByRole("button", { name: "Управлять отделами" }));
    expect(getState().workspaceOpen).toBe(false);
    expect(getState().section).toBe("people");
    setState({ workspaceOpen: true });
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Рабочее пространство" })).getByRole("button", { name: "Закрыть" }));
    expect(getState().workspaceOpen).toBe(false);
  });
});

describe("закрытие панели", () => {
  it("переход в другой раздел или вкладку закрывает панель; смена того же раздела — нет", async () => {
    await open("owner");
    setState({ section: getState().section });
    expect(getState().workspaceOpen).toBe(true);
    setState({ section: getState().section === "deals" ? "today" : "deals" });
    expect(getState().workspaceOpen).toBe(false);
  });
});

describe("входящие приглашения", () => {
  it("приглашение на почту учётной записи приходит в приложение и принимается кнопкой", async () => {
    const { DEMO_EMAIL } = await import("../../api/wsMock");
    setWsMockRole("owner");
    expect(await api.wsIncoming()).toEqual([]);
    await api.wsInvite(DEMO_EMAIL, "manager");
    await api.wsInvite("other@firma.ru", "viewer");
    const list = await api.wsIncoming();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ workspaceName: "Отдел продаж", roleName: "Менеджер" });
    setState({ ws: await api.wsState(), incoming: list, workspaceOpen: true });
    render(<WorkspaceDialog />);
    const card = await screen.findByLabelText("Приглашения");
    fireEvent.click(within(card).getByRole("button", { name: "Принять" }));
    await waitFor(() => expect(getState().incoming).toHaveLength(0));
    expect(getState().ws?.workspaces.filter((w) => w.name === "Отдел продаж")).toHaveLength(2);
    expect(await api.wsIncoming()).toEqual([]);
  });

  it("отклонить убирает приглашение", async () => {
    const { DEMO_EMAIL } = await import("../../api/wsMock");
    setWsMockRole("owner");
    await api.wsInvite(DEMO_EMAIL, "viewer");
    const [inv] = await api.wsIncoming();
    await api.wsDeclineIncoming(inv!.id);
    expect(await api.wsIncoming()).toEqual([]);
    await expect(api.wsAcceptIncoming(inv!.id)).rejects.toThrow(/не найдено/);
  });
});
