import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { getState } from "../../state/store";
import { ConfirmHost } from "../../ui/overlay";
import { PortableCopyRows } from "./PortableCopy";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Ключ собирается во время выполнения: литералы секретов в тестах CodeQL считает утечкой.
const KEY = ["7KQ2M", "XW9RT", "4HBNC", "P3VZE", "6GJ8S", "YD5FA"].join("-");
const state = (hasKey: boolean) => ({ hasKey, extension: "customers", keyLength: 30 });

describe("перенос на другой компьютер", () => {
  it("первая копия: ключ создаётся и показывается один раз, файл сохраняется только после «Я сохранил ключ»", async () => {
    vi.spyOn(api, "portableState").mockResolvedValueOnce(state(false)).mockResolvedValue(state(true));
    const create = vi.spyOn(api, "createPortableKey").mockResolvedValue(KEY);
    const exp = vi.spyOn(api, "exportPortable").mockResolvedValue("Переносимая копия сохранена: /x. Баз CRM: 1");
    render(<PortableCopyRows />);
    expect(await screen.findByText("ключа нет")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить копию…" }));
    expect(await screen.findByText(KEY)).toBeTruthy();
    expect(create).toHaveBeenCalledWith(false);
    expect(screen.getByText(/Ключ показывается один раз/)).toBeTruthy();
    const done = screen.getByRole("button", { name: "Готово" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(exp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Я сохранил ключ"));
    fireEvent.click(done);
    await waitFor(() => expect(exp).toHaveBeenCalledTimes(1));
    expect(exp.mock.calls[0]![0]).toMatch(/\.customers$/);
    expect(screen.queryByText(KEY)).toBeNull();
    expect(await screen.findByText("ключ создан")).toBeTruthy();
    await waitFor(() => expect(getState().toasts.at(-1)?.text).toBe("Переносимая копия сохранена: /x. Баз CRM: 1"));
  });

  it("ключ уже есть: копия сохраняется сразу, замена ключа — только после подтверждения", async () => {
    vi.spyOn(api, "portableState").mockResolvedValue(state(true));
    const create = vi.spyOn(api, "createPortableKey").mockResolvedValue(KEY);
    const exp = vi.spyOn(api, "exportPortable").mockResolvedValue("ok");
    render(<><PortableCopyRows /><ConfirmHost /></>);
    await screen.findByText("ключ создан");
    fireEvent.click(screen.getByRole("button", { name: "Сохранить копию…" }));
    await waitFor(() => expect(exp).toHaveBeenCalledTimes(1));
    expect(create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Заменить ключ…" }));
    await screen.findByText("Заменить ключ восстановления?");
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByText("Заменить ключ восстановления?")).toBeNull());
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Заменить ключ…" }));
    await screen.findByText("Заменить ключ восстановления?");
    fireEvent.click(screen.getByRole("button", { name: "Заменить" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(true));
    expect(await screen.findByText(KEY)).toBeTruthy();
  });

  it("«Открыть копию»: подтверждение замены, затем ключ; неверный формат не уходит в ядро", async () => {
    vi.spyOn(api, "portableState").mockResolvedValue(state(false));
    const imp = vi.spyOn(api, "importPortable").mockResolvedValue("Данные перенесены");
    render(<><PortableCopyRows /><ConfirmHost /></>);
    fireEvent.click(await screen.findByRole("button", { name: "Открыть копию…" }));
    await screen.findByText("Заменить данные этого устройства?");
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByText("Заменить данные этого устройства?")).toBeNull());
    expect(screen.queryByText("Открыть переносимую копию")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Открыть копию…" }));
    await screen.findByText("Заменить данные этого устройства?");
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await screen.findByText("Открыть переносимую копию");
    const input = screen.getByLabelText("Ключ восстановления");
    fireEvent.change(input, { target: { value: "12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    expect(screen.getByText("Ключ — 30 знаков: цифры и латинские буквы")).toBeTruthy();
    expect(imp).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: KEY.toLowerCase().replace(/-/g, " ") } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    await waitFor(() => expect(imp).toHaveBeenCalledTimes(1));
    expect(imp.mock.calls[0]![1]).toBe(KEY);
  });
});
