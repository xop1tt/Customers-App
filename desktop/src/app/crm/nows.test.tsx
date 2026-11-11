import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetWsMock } from "../../api/wsMock";
import { api } from "../../api";
import { boot, setState } from "../../state/store";
import { App } from "../App";

// Приложение, открытое сразу на «Сегодня» (последний раздел), рисуется раньше, чем ядро вернуло Workspace.
// Селектор вида `s.ws?.members ?? []` в этот момент отдавал новый массив при каждом вызове, и React уходил в
// бесконечную перерисовку (ошибка #185): окно оставалось пустым (релиз 2.3.0).
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("экраны CRM до загрузки Workspace", () => {
  it("окно, открытое на «Сегодня» без Workspace, рисуется без бесконечной перерисовки", async () => {
    resetWsMock();
    try { localStorage.clear(); } catch { /* нет хранилища */ }
    await boot();
    // Workspace не приходит: ядро ещё отвечает.
    vi.spyOn(api, "wsState").mockImplementation(() => new Promise(() => {}));
    setState({ phase: "ready", section: "today", ws: null, collections: [], record: null });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<App />)).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/Maximum update depth|getSnapshot should be cached/);
  });
});
