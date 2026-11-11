import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock, setWsMockRole } from "../../api/wsMock";
import { translate } from "../../lib/i18n";
import { getState } from "../../state/store";
import { CrmExportDialog, exportFileName } from "./CrmExport";

afterEach(cleanup);
beforeEach(() => resetWsMock());

describe("экспорт CRM", () => {
  it("демо-ядро отдаёт колонки со своими полями и считает записи коллекции", async () => {
    const fields = await api.wsExportFields("companies", "ru");
    expect(fields[0]).toEqual({ key: "name", title: "Компания", default: true, custom: false });
    expect(fields.find((f) => f.key === "updated_at")?.default).toBe(false);
    const def = await api.wsSave("custom_fields", null, { entity_type: "company", label: "Сегмент", kind: "text", options: [], position: 1 });
    expect((await api.wsExportFields("companies", "ru")).at(-1)).toEqual({ key: `cf:${def.id}`, title: "Сегмент", default: true, custom: true });
    expect((await api.wsExportFields("contacts", "ru")).some((f) => f.custom)).toBe(false);

    const all = (await api.wsCollections()).find((c) => c.builtin === "all_clients")!;
    const shown = await api.wsCollectionItems(all.id, { search: "ветер" });
    const request = { entity: "companies", collection: all.id, query: { search: "ветер" }, format: "xlsx" as const, fields: ["name"], lang: "ru" };
    expect((await api.wsExport(request, "/tmp/a.xlsx")).count).toBe(shown.total);
    expect(shown.total).toBeGreaterThan(0);
    await expect(api.wsExport({ ...request, fields: [] }, "/tmp/a.xlsx")).rejects.toMatchObject({ message: expect.stringContaining("хотя бы одну") });
    await expect(api.wsExport({ ...request, fields: ["нет"] }, "/tmp/a.xlsx")).rejects.toMatchObject({ message: expect.stringContaining("Неизвестная колонка") });
    await expect(api.wsExportFields("notes", "ru")).rejects.toMatchObject({ message: expect.stringContaining("не выгружаются") });
  });

  it("без права на экспорт выгрузка запрещена", async () => {
    setWsMockRole("employee");
    await expect(api.wsExport({ entity: "companies", format: "csv", fields: ["name"], lang: "ru" }, "/tmp/a.csv")).rejects.toMatchObject({ message: expect.stringContaining("прав") });
  });

  it("окно: колонки по умолчанию, выбор формата и сохранение", async () => {
    let closed = false;
    const total = (await api.wsList("deals")).total;
    render(<CrmExportDialog source={{ entity: "deals", total }} onClose={() => { closed = true; }} />);
    await screen.findByText("Колонки");
    expect(screen.getByRole("dialog").textContent).toContain(`Экспорт: ${total}`);
    const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
    expect([box("Сделка").checked, box("Этап").checked, box("Воронка").checked]).toEqual([true, true, false]);

    fireEvent.click(screen.getByRole("button", { name: "Все" }));
    expect(box("Воронка").checked).toBe(true);
    for (const b of screen.getAllByRole("checkbox")) if ((b as HTMLInputElement).checked) fireEvent.click(b);
    expect((screen.getByRole("button", { name: "Сохранить файл…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "По умолчанию" }));
    expect(box("Воронка").checked).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: "CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить файл…" }));
    await waitFor(() => expect(closed).toBe(true));
    expect(getState().toasts.at(-1)).toMatchObject({ kind: "success", text: `Сохранено записей: ${total}` });
  });

  it("пустой список не выгружается, имя файла безопасно для Windows", async () => {
    render(<CrmExportDialog source={{ entity: "companies", total: 0 }} onClose={() => {}} />);
    await screen.findByText("Колонки");
    expect((screen.getByRole("button", { name: "Сохранить файл…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(exportFileName("Сделки: «А/Б»?", "csv", new Date(2026, 10, 11))).toBe("Сделки «А Б» 2026-11-11.csv");
    expect(exportFileName("  ", "xlsx", new Date(2026, 0, 5))).toBe("CRM 2026-01-05.xlsx");
  });

  it("новые тексты окна переведены", () => {
    for (const ru of ["Колонки", "Сохранено записей: 12", "Экспорт: 3 записи", "В файл попадёт то, что сейчас показывает список, с учётом поиска «кофе»."]) {
      expect(translate(ru), ru).not.toBeNull();
    }
  });
});
