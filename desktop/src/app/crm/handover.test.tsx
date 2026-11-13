// Передача записей сотрудника (A1) и подпись «Бывший участник» (A2) на демо-ядре облачной команды.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { resetWsMock } from "../../api/wsMock";
import { cellText, ENTITIES, memberName } from "../../lib/crm";
import { countOwned, describeCounts, totalOf, transferOwned } from "../../lib/handover";
import { setState } from "../../state/store";
import { HandoverDialog } from "./Handover";

vi.hoisted(() => { window.history.replaceState({}, "", "/?team"); });

const VERA = "00000000-0000-4000-8000-000000000003";
const BORIS = "00000000-0000-4000-8000-000000000002";

afterEach(cleanup);
beforeEach(() => resetWsMock());

async function give(table: string, field: string, n: number, extra: Record<string, unknown> = {}, who = VERA) {
  if (table === "deals" && !extra.pipeline_id) {
    const stages = (await api.wsList("pipeline_stages", {})).items;
    const stage = (extra.status === "won" ? stages.find((x) => x.kind === "won") : stages.find((x) => x.kind === "open")) ?? stages[0]!;
    extra = { pipeline_id: stage.pipeline_id, stage_id: stage.id, ...extra };
  }
  for (let i = 0; i < n; i += 1) await api.wsSave(table, null, { ...(table === "tasks" ? { title: `Задача ${i}`, status: "todo" } : table === "deals" ? { title: `Сделка ${i}`, status: "open" } : { name: `Клиент ${i}` }), ...extra, [field]: who });
}

describe("передача записей", () => {
  it("считает только то, что ещё в работе", async () => {
    await api.wsState();
    await give("deals", "owner_id", 2);
    await give("deals", "owner_id", 1, { status: "won" });
    await give("tasks", "assignee_id", 3);
    await give("tasks", "assignee_id", 1, { status: "done" });
    const c = await countOwned(VERA);
    expect(c.deals).toBe(2);
    expect(c.tasks).toBe(3);
    expect(totalOf(c)).toBeGreaterThanOrEqual(5);
    expect(describeCounts(c)).toContain("открытые сделки: 2");
  });

  it("передаёт выбранные таблицы и не трогает завершённое", async () => {
    await api.wsState();
    await give("deals", "owner_id", 2);
    await give("deals", "owner_id", 1, { status: "won" });
    await give("tasks", "assignee_id", 2);
    const steps: number[] = [];
    const r = await transferOwned(VERA, BORIS, ["deals"], (d) => steps.push(d));
    expect(r).toEqual({ moved: 2, failed: 0 });
    expect(steps).toEqual([1, 2]);
    const after = await countOwned(VERA);
    expect(after.deals).toBe(0);
    expect(after.tasks).toBe(2);
    const won = await api.wsList("deals", { filters: [{ field: "owner_id", op: "eq", value: VERA }, { field: "status", op: "eq", value: "won" }] });
    expect(won.total).toBe(1);
    expect((await countOwned(BORIS)).deals).toBe(2);
  });

  it("ошибка одной записи не останавливает остальные", async () => {
    await api.wsState();
    await give("tasks", "assignee_id", 3);
    const real = api.wsSave;
    let n = 0;
    vi.spyOn(api, "wsSave").mockImplementation((...a) => { n += 1; return n === 2 ? Promise.reject(new Error("нет прав")) : real(...a); });
    const r = await transferOwned(VERA, BORIS, ["tasks"]);
    vi.restoreAllMocks();
    expect(r).toEqual({ moved: 2, failed: 1 });
  });

  it("диалог показывает счётчики и передаёт коллеге", async () => {
    const ws = await api.wsState();
    setState({ ws });
    await give("deals", "owner_id", 2);
    const done = vi.fn();
    render(<HandoverDialog from={{ userId: VERA, displayName: "Вера Ким" }} onClose={done} />);
    expect(await screen.findByText(/Открытые сделки: 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Передать/ }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect((await countOwned(VERA)).deals).toBe(0);
  });

  it("при удалении без записей сразу предлагает удалить", async () => {
    const ws = await api.wsState();
    setState({ ws });
    const remove = vi.fn(async () => undefined);
    render(<HandoverDialog from={{ userId: "00000000-0000-4000-8000-000000000006", displayName: "Егор Сом" }} leaving onClose={() => undefined} onRemove={remove} />);
    expect(await screen.findByText(/Его можно удалить/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(remove).toHaveBeenCalled());
  });
});

describe("бывший участник", () => {
  const members = [{ userId: "a", displayName: "Алексей", role: "owner", roleName: "Владелец", rank: 100, avatarPath: null, email: null }];
  it("подписывает ответственного, которого нет в списке", () => {
    expect(memberName(members, "a")).toBe("Алексей");
    expect(memberName(members, "gone")).toBe("Бывший участник");
    expect(memberName([], "gone")).toBe("Участник");
    expect(memberName(members, null)).toBe("");
    const lk = { members, stages: new Map(), companies: new Map(), pipelines: new Map() };
    const r = { id: "1", workspace_id: "w", version: 1, created_at: "", updated_at: "", created_by: "a", owner_id: "gone" };
    expect(cellText(ENTITIES.deal, r, "owner_id", lk)).toBe("Бывший участник");
  });
});
