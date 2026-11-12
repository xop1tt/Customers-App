import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock } from "../../api/wsMock";
import { setState } from "../../state/store";
import { JournalPage, journalRow } from "./JournalPage";

afterEach(cleanup);
beforeEach(async () => {
  resetWsMock();
  setState({ ws: await api.wsState() });
});

describe("журнал действий", () => {
  it("определяет действие по данным записи", () => {
    const base = { id: "1", created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z", created_by: "a", updated_by: "a", version: 1 } as never;
    expect(journalRow("companies", "Компания", "А", base).action).toBe("created");
    expect(journalRow("companies", "Компания", "А", { ...(base as object), version: 3, updated_at: "2026-11-02T10:00:00Z", updated_by: "b" } as never)).toMatchObject({ action: "changed", by: "b" });
    expect(journalRow("companies", "Компания", "", { ...(base as object), deleted_at: "2026-11-03T10:00:00Z" } as never)).toMatchObject({ action: "deleted", title: "Без названия", at: "2026-11-03T10:00:00Z" });
  });

  it("показывает действия над записями тем, у кого есть право", async () => {
    const c = await api.wsSave("companies", null, { name: "Журнальная компания" });
    await api.wsSave("companies", c.id, { name: "Журнальная компания 2" });
    render(<JournalPage />);
    const row = (await screen.findByText("Журнальная компания 2")).closest("[role=row]") as HTMLElement;
    expect(within(row).getByText("Компания")).toBeInTheDocument();
    expect(within(row).getByText(/Изменено|Создано/)).toBeInTheDocument();
  });

  it("без права «Журнал действий» страница закрыта", async () => {
    const st = await api.wsState();
    setState({ ws: { ...st, permissions: st.permissions.filter((p) => p !== "audit.view") } });
    render(<JournalPage />);
    expect(await screen.findByText("Нет доступа к журналу")).toBeInTheDocument();
  });
});
