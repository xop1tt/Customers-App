// Панель управления рабочим пространством: только локальные разделы (ADR-100), переходы и закрытие.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { addWsMockMember, resetWsMock } from "../../api/wsMock";
import { getState, setState } from "../../state/store";
import { WorkspaceDialog } from "./WorkspaceDialog";

afterEach(cleanup);
beforeEach(() => resetWsMock());

const open = async () => {
  setState({ ws: await api.wsState(), workspaceOpen: true });
  render(<WorkspaceDialog />);
  return screen.getByRole("dialog", { name: "Рабочее пространство" });
};
const tiles = (panel: HTMLElement) => within(panel).getAllByRole("button").filter((b) => b.classList.contains("ws-tile")).map((b) => b.querySelector("strong")!.textContent);
const tile = (panel: HTMLElement, name: string) => within(panel).getByRole("button", { name: new RegExp(name) });

describe("панель рабочего пространства", () => {
  it("только локальные плитки: без приглашений, ролей, коннекторов, синхронизации и журнала", async () => {
    const panel = await open();
    expect(tiles(panel)).toEqual(["Воронки и этапы", "Свои поля", "Экспорт и копии"]);
    for (const gone of ["Приглашения", "Роли и права", "Коннекторы", "Синхронизация", "Журнал действий", "Опасная зона", "Отделы и должности"]) {
      expect(within(panel).queryByRole("button", { name: new RegExp(gone) })).toBeNull();
    }
  });

  it("перенесённые участники видны как список ответственных, без управления ролями", async () => {
    addWsMockMember("Борис Петров");
    const panel = await open();
    fireEvent.click(tile(panel, "Ответственные"));
    expect(within(panel).getByText("Борис Петров")).toBeTruthy();
    expect(within(panel).queryByRole("combobox")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Удалить из рабочего пространства" })).toBeNull();
  });

  it("«Другие рабочие пространства» открывает обзор, «Назад к плиткам» возвращает, Esc сначала возвращает, затем закрывает", async () => {
    const panel = await open();
    fireEvent.click(within(panel).getByRole("button", { name: /Другие рабочие пространства/ }));
    expect(within(panel).queryByRole("button", { name: /Воронки и этапы/ })).toBeNull();
    expect(within(panel).getByLabelText("Название нового рабочего пространства")).toBeTruthy();
    expect(within(panel).queryByLabelText("Код приглашения")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Назад к плиткам" }));
    expect(tile(panel, "Воронки и этапы")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: /Другие рабочие пространства/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tile(panel, "Воронки и этапы")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(getState().workspaceOpen).toBe(false);
  });

  it("новое пространство создаётся локально и становится текущим", async () => {
    const panel = await open();
    fireEvent.click(within(panel).getByRole("button", { name: /Другие рабочие пространства/ }));
    fireEvent.change(within(panel).getByLabelText("Название нового рабочего пространства"), { target: { value: "Филиал" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Создать" }));
    await waitFor(async () => {
      const ws = await api.wsState();
      expect(ws.workspaces.find((w) => w.id === ws.active)?.name).toBe("Филиал");
    });
    const ws = await api.wsState();
    expect(ws.workspaces.every((w) => !w.remote)).toBe(true);
  });

  it("крестик закрывает панель", async () => {
    const panel = await open();
    fireEvent.click(within(panel).getByRole("button", { name: "Закрыть" }));
    expect(getState().workspaceOpen).toBe(false);
  });
});

describe("закрытие панели", () => {
  it("переход в другой раздел или вкладку закрывает панель; смена того же раздела — нет", async () => {
    await open();
    setState({ section: getState().section });
    expect(getState().workspaceOpen).toBe(true);
    setState({ section: getState().section === "deals" ? "today" : "deals" });
    expect(getState().workspaceOpen).toBe(false);
  });
});
