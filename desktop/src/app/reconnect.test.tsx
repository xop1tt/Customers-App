import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { mockQueued, resetWsMock, setMockOffline } from "../api/wsMock";
import { connectionLost, tryReconnect } from "../state/connection";
import { getState, setState } from "../state/store";
import { ReconnectToast } from "./Reconnect";

vi.hoisted(() => { window.history.replaceState({}, "", "/?team"); });

afterEach(() => { cleanup(); setMockOffline(false); setState({ conn: "online" }); });
beforeEach(async () => { resetWsMock(); setState({ conn: "online", ws: await api.wsState() }); });

describe("потеря связи", () => {
  it("пока связь есть, плашки нет", () => {
    render(<ReconnectToast />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("нет интернета: красная плашка «Переподключение…»; попытка неудачна — плашка остаётся", async () => {
    setMockOffline(true);
    render(<ReconnectToast />);
    act(() => connectionLost());
    const toast = await screen.findByRole("status");
    expect(toast).toHaveTextContent("Переподключение…");
    expect(toast.className).toContain("lost");
    expect(await tryReconnect()).toBe(false);
    expect(getState().conn).toBe("reconnecting");
  });

  it("связь вернулась: галочка и «Подключено», затем плашка исчезает", async () => {
    setMockOffline(true);
    render(<ReconnectToast />);
    act(() => connectionLost());
    setMockOffline(false);
    await act(async () => { expect(await tryReconnect()).toBe(true); });
    const toast = await screen.findByRole("status");
    expect(toast).toHaveTextContent("Подключено");
    expect(toast.className).toContain("ok");
    expect(toast.querySelector(".reconnect-tick")).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull(), { timeout: 4000 });
  });

  it("изменения без связи сохраняются локально и уходят в очередь до подключения", async () => {
    const [stage] = (await api.wsList("pipeline_stages", { sort: [{ field: "position", dir: "asc" }] })).items;
    setMockOffline(true);
    const a = await api.wsSave("deals", null, { pipeline_id: stage!.pipeline_id, title: "Сделка без сети", stage_id: stage!.id, currency: "RUB" });
    await api.wsSave("deals", a.id, { title: "Сделка без сети (правка)" });
    expect(mockQueued()).toBe(2);
    expect((await api.wsState()).pending).toBe(2);
    expect((await api.wsList("deals", {})).items.some((d) => d.title === "Сделка без сети (правка)")).toBe(true);
    await expect(api.wsSyncNow()).rejects.toThrow(/Нет связи/);
    expect(mockQueued()).toBe(2);
    setMockOffline(false);
    await api.wsSyncNow();
    expect(mockQueued()).toBe(0);
    expect((await api.wsState()).pending).toBe(0);
    expect((await api.wsList("deals", {})).items.some((d) => d.title === "Сделка без сети (правка)")).toBe(true);
  });

  it("события браузера offline/online включают и убирают плашку", async () => {
    const { App } = await import("./App");
    render(<App />);
    await screen.findByLabelText("Навигация");
    setMockOffline(true);
    fireEvent(window, new Event("offline"));
    expect(await screen.findByText("Переподключение…")).toBeInTheDocument();
    setMockOffline(false);
    fireEvent(window, new Event("online"));
    expect(await screen.findByText("Подключено")).toBeInTheDocument();
  });
});
