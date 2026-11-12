// Передача владения и удаление рабочего пространства (A5): подтверждение названием и правила владельца.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { resetWsMock, setWsMockRole } from "../../api/wsMock";
import { getState, setState } from "../../state/store";
import { DangerZone, DeleteDialog, TransferDialog } from "./Danger";

vi.hoisted(() => { window.history.replaceState({}, "", "/?team"); });

const VERA = "00000000-0000-4000-8000-000000000003";

afterEach(cleanup);
beforeEach(() => resetWsMock());

const NAME = "Отдел продаж";

describe("опасная зона", () => {
  it("видна владельцу и скрыта у остальных", async () => {
    setWsMockRole("manager");
    setState({ ws: await api.wsState() });
    const { container, unmount } = render(<DangerZone />);
    expect(container.textContent).toBe("");
    unmount();
    setWsMockRole("owner");
    setState({ ws: await api.wsState() });
    render(<DangerZone />);
    expect(screen.getByRole("button", { name: "Передать…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Удалить…" })).toBeTruthy();
  });

  it("владение передаётся только после точного ввода названия", async () => {
    setWsMockRole("owner");
    setState({ ws: await api.wsState() });
    const done = vi.fn();
    render(<TransferDialog name={NAME} onClose={done} />);
    const go = screen.getByRole("button", { name: "Передать владение" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    const box = screen.getByLabelText("Название рабочего пространства");
    fireEvent.change(box, { target: { value: "отдел" } });
    expect(go.disabled).toBe(true);
    fireEvent.change(box, { target: { value: NAME } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(done).toHaveBeenCalled());
    const ws = await api.wsState();
    expect(ws.workspaces.find((w) => w.id === ws.active)?.role).toBe("admin");
    expect(ws.members.find((m) => m.role === "owner")?.userId).not.toBe(ws.me);
  });

  it("не владелец не может передать или удалить", async () => {
    setWsMockRole("admin");
    await expect(api.wsTransferOwnership(VERA)).rejects.toThrow(/владелец/);
    await expect(api.wsDeleteWorkspace(NAME)).rejects.toThrow(/владелец/);
  });

  it("владельцем нельзя сделать себя или постороннего", async () => {
    setWsMockRole("owner");
    await expect(api.wsTransferOwnership((await api.wsState()).me)).rejects.toThrow(/другого участника/);
    await expect(api.wsTransferOwnership("нет-такого")).rejects.toThrow(/другого участника/);
  });

  it("удаление требует название и переключает на личное пространство", async () => {
    setWsMockRole("owner");
    setState({ ws: await api.wsState(), workspaceOpen: true });
    await expect(api.wsDeleteWorkspace("не то")).rejects.toThrow(/не совпадает/);
    render(<DeleteDialog name={NAME} onClose={() => undefined} />);
    expect(screen.getByRole("button", { name: "Выгрузить CRM" })).toBeTruthy();
    const go = screen.getByRole("button", { name: "Удалить навсегда" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Название рабочего пространства"), { target: { value: NAME } });
    fireEvent.click(go);
    await waitFor(() => expect(getState().workspaceOpen).toBe(false));
    const ws = await api.wsState();
    expect(ws.workspaces.some((w) => w.name === NAME)).toBe(false);
    expect(ws.workspaces.find((w) => w.id === ws.active)?.personal).toBe(true);
  });

  it("кнопка «Выгрузить CRM» ведёт в настройки «Данные»", async () => {
    setWsMockRole("owner");
    setState({ ws: await api.wsState(), workspaceOpen: true });
    render(<DeleteDialog name={NAME} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Выгрузить CRM" }));
    expect(getState().settings).toBe("data");
    expect(getState().settingsSub).toBe("portable");
    expect(getState().workspaceOpen).toBe(false);
  });
});
