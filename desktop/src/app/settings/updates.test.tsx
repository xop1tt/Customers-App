// «Обновления»: индикатор загрузки на кнопке «Проверить», пока идёт проверка новой версии.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import type { UpdateInfo } from "../../api/types";
import { setState } from "../../state/store";
import { UpdatesSection } from "./SystemSections";

const info = (phase: UpdateInfo["phase"]): UpdateInfo =>
  ({ phase, current: "1.1.0", canUpdate: true, available: null, stagedVersion: null, lastCheck: null, releasesPage: "https://example.org" });

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); setState({ update: null }); });

describe("проверка обновлений", () => {
  it("по нажатию кнопка сразу показывает индикатор и «Проверяем…», после ответа — снова «Проверить»", async () => {
    vi.spyOn(api, "recentReleases").mockResolvedValue([]);
    vi.spyOn(api, "updateIntervals").mockResolvedValue([]);
    let finish: (v: UpdateInfo) => void = () => {};
    vi.spyOn(api, "checkUpdates").mockImplementation(() => new Promise((r) => { finish = r; }));
    setState({ update: info("idle") });
    render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    const btn = await screen.findByRole("button", { name: /Проверяем…/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.querySelector(".spinner")).not.toBeNull();
    expect(screen.getByText(/Проверяем наличие обновлений…/)).toBeInTheDocument();
    // Ядро присылает «checking» событием: индикатор один, на кнопке, без второго спиннера в строке.
    act(() => setState({ update: info("checking") }));
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    act(() => { setState({ update: info("upToDate") }); finish(info("upToDate")); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Проверить" })).toBeEnabled(), { timeout: 2000 });
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(/Установлена последняя версия/)).toBeInTheDocument();
  });

  it("быстрый ответ не мигает: индикатор держится минимальное время", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.spyOn(api, "recentReleases").mockResolvedValue([]);
    vi.spyOn(api, "updateIntervals").mockResolvedValue([]);
    vi.spyOn(api, "checkUpdates").mockResolvedValue(info("upToDate"));
    setState({ update: info("idle") });
    render(<UpdatesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByRole("button", { name: /Проверяем…/ })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByRole("button", { name: "Проверить" })).toBeEnabled();
  });

  it("фоновая проверка ядра (phase «checking») тоже показывает индикатор на кнопке", () => {
    vi.spyOn(api, "recentReleases").mockResolvedValue([]);
    vi.spyOn(api, "updateIntervals").mockResolvedValue([]);
    setState({ update: info("checking") });
    render(<UpdatesSection />);
    const btn = screen.getByRole("button", { name: /Проверяем…/ });
    expect(btn).toBeDisabled();
    expect(btn.querySelector(".spinner")).not.toBeNull();
  });
});
