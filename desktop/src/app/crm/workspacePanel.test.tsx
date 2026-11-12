// Панель управления рабочим пространством справа: разделы по роли, структура, закрытие.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
const chips = (panel: HTMLElement) => within(within(panel).getByRole("navigation", { name: "Разделы рабочего пространства" })).getAllByRole("button").map((b) => b.textContent);

describe("панель рабочего пространства", () => {
  it("владелец видит все разделы, включая «Владелец»", async () => {
    const panel = await open("owner");
    expect(chips(panel)).toEqual(["Обзор", "Люди", "Структура", "CRM", "Доступ и журнал", "Синхронизация", "Владелец"]);
    expect(within(panel).getByText("Опасная зона")).toBeTruthy();
    expect(within(panel).getByRole("list", { name: "Должности и их возможности" }).children.length).toBeGreaterThan(5);
  });

  it("сотрудник не видит опасную зону и не может назначать должности", async () => {
    const panel = await open("employee");
    expect(within(panel).queryByText("Опасная зона")).toBeNull();
    expect(within(panel).getByText("Назначать должности вы не можете")).toBeTruthy();
  });

  it("«Управлять отделами» открывает «Сотрудников» и закрывает панель; крестик закрывает", async () => {
    const panel = await open("owner");
    fireEvent.click(within(panel).getByRole("button", { name: "Управлять отделами" }));
    expect(getState().workspaceOpen).toBe(false);
    expect(getState().section).toBe("people");
    setState({ workspaceOpen: true });
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Рабочее пространство" })).getByRole("button", { name: "Закрыть" }));
    expect(getState().workspaceOpen).toBe(false);
  });
});
