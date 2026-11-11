import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { getState } from "../state/store";
import { BackupReminder } from "./BackupReminder";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { try { localStorage.clear(); } catch { /* нет хранилища */ } });

const old = (days: number) => [{ name: "leadgen.db", path: "/b/1", size: 1, modifiedAt: new Date(Date.now() - days * 86_400_000).toISOString() }];

describe("напоминание о копии на «Сегодня»", () => {
  it("свежая копия — ничего не показывает", async () => {
    const list = vi.spyOn(api, "listBackups").mockResolvedValue(old(1));
    const { container } = render(<BackupReminder />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("старая копия: «Сделать копию» вызывает ядро и убирает напоминание", async () => {
    const list = vi.spyOn(api, "listBackups").mockResolvedValueOnce(old(9)).mockResolvedValueOnce(old(0));
    const backup = vi.spyOn(api, "backupNow").mockResolvedValue("/b/new");
    render(<BackupReminder />);
    expect(await screen.findByText("Последняя резервная копия — 9 дней назад. Проверьте настройки копий или сделайте её сейчас.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сделать копию" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(backup).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(2);
    expect(getState().toasts.at(-1)?.text).toBe("Резервная копия создана");
  });

  it("копий нет: «Позже» скрывает и помнит это при следующем открытии", async () => {
    vi.spyOn(api, "listBackups").mockResolvedValue([]);
    const first = render(<BackupReminder />);
    await screen.findByText(/Резервной копии данных ещё нет/);
    fireEvent.click(screen.getByRole("button", { name: "Позже" }));
    expect(screen.queryByRole("status")).toBeNull();
    first.unmount();
    render(<BackupReminder />);
    await waitFor(() => expect(api.listBackups).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
