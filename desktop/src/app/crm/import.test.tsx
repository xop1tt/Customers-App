import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock } from "../../api/wsMock";
import { ImportDialog } from "./ImportDialog";

afterEach(cleanup);
beforeEach(() => resetWsMock());

const CSV = "Компания;Контакт;Телефон\nКофейня Зерно;Анна Петрова;+7 900 000-00-01\nПекарня;;\n";
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe("импорт таблиц", () => {
  it("демо-ядро предлагает сопоставление, находит дубли и отменяет импорт", async () => {
    const read = await api.wsImportRead("clients.csv", b64(CSV));
    expect(read.mapping).toEqual(["company.name", "contact.full_name", "contact.phone"]);
    const options = { mapping: read.mapping, duplicates: "link" as const };
    const first = await api.wsImportRun("clients.csv", b64(CSV), options);
    expect([first.companies, first.contacts]).toEqual([2, 1]);
    const again = await api.wsImportPreview("clients.csv", b64(CSV), options);
    expect(again.existing).toBe(2);
    const undo = await api.wsImportUndo(first.batchId!);
    expect(undo.removed).toBe(3);
    expect((await api.wsImportUndo(first.batchId!)).alreadyUndone).toBe(true);
    expect((await api.wsImportHistory())[0]?.undoneAt).not.toBeNull();
  });

  it("мастер ведёт от файла к результату", async () => {
    render(<ImportDialog onClose={() => {}} />);
    const file = new File([CSV], "clients.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Файл для импорта"), { target: { files: [file] } });
    await screen.findByText(/Укажите, что лежит в каждой колонке/);
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Новых: 2");
    fireEvent.click(screen.getByRole("button", { name: "Импортировать" }));
    await screen.findByText(/Загружено: 2 компании, 1 контакт, 0 сделок/);
    fireEvent.click(screen.getByRole("button", { name: "Отменить импорт" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Отменить импорт" })).toBeNull());
  });
});
