// «Данные → Резервные копии»: выбор частоты автоматических копий.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { getState, setState } from "../../state/store";
import { DataSection } from "./DataSection";

beforeEach(async () => {
  setState({ session: { id: "c", displayName: "Алексей", avatar: null, databasePath: "" }, account: await api.accountPrefs() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); setState({ session: null, account: null }); });

describe("частота резервных копий", () => {
  it("показывает текущую частоту и сохраняет новую в настройках аккаунта", async () => {
    vi.spyOn(api, "listBackups").mockResolvedValue([]);
    const patch = vi.spyOn(api, "patchAccountPrefs").mockImplementation(async (c) => ({ ...getState().account!, ...c }));
    setState({ account: { ...getState().account!, autoBackup: true, backupHours: 24 } });
    render(<DataSection />);
    fireEvent.click(screen.getByRole("button", { name: /Раз в сутки/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Раз в неделю" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ backupHours: 168 }));
    expect(getState().account!.backupHours).toBe(168);
  });

  it("при выключенных автоматических копиях частота недоступна", () => {
    vi.spyOn(api, "listBackups").mockResolvedValue([]);
    setState({ account: { ...getState().account!, autoBackup: false, backupHours: 6 } });
    render(<DataSection />);
    expect(screen.getByRole("button", { name: /Каждые 6 часов/ })).toBeDisabled();
  });
});
