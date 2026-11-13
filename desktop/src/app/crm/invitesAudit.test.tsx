// Открытые приглашения (список, повтор, отзыв) и журнал действий на демо-ядре облачной команды.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { resetWsMock, setWsMockRole } from "../../api/wsMock";
import { actionText, detailText } from "../../lib/audit";
import { setState } from "../../state/store";
import { AuditDialog } from "./AuditLog";
import { WorkspaceDialog } from "./WorkspaceDialog";

vi.hoisted(() => { window.history.replaceState({}, "", "/?team"); });

afterEach(cleanup);
beforeEach(() => resetWsMock());

describe("приглашения", () => {
  it("список открытых, повтор не чаще раза в 10 минут, отзыв", async () => {
    setWsMockRole("owner");
    const inv = await api.wsInvite("new@firma.ru", "employee");
    let list = await api.wsInvitations();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: inv.id, email: "new@firma.ru", sentCount: 1 });
    expect(JSON.stringify(list)).not.toContain(inv.token);
    await expect(api.wsResendInvitation(inv.id)).rejects.toThrow(/10 минут/);
    await api.wsRevokeInvitation(inv.id);
    list = await api.wsInvitations();
    expect(list).toHaveLength(0);
  });

  it("второе приглашение на тот же адрес отклоняется", async () => {
    setWsMockRole("owner");
    await api.wsInvite("a@b.ru", "viewer");
    await expect(api.wsInvite("A@b.ru", "viewer")).rejects.toThrow(/уже отправлено/);
  });

  it("диалог рабочего пространства показывает открытые приглашения", async () => {
    setWsMockRole("owner");
    const ws = await api.wsState();
    setState({ ws, workspaceOpen: true });
    await api.wsInvite("kolya@firma.ru", "employee");
    render(<WorkspaceDialog />);
    expect(screen.getByRole("button", { name: /Журнал действий/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Приглашения/ }));
    expect(await screen.findByText("kolya@firma.ru")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Отправить ещё раз" })).toBeTruthy();
  });
});

describe("журнал действий", () => {
  it("без права audit.view журнал не открывается", async () => {
    setWsMockRole("employee");
    await expect(api.wsAudit()).rejects.toThrow(/журнал/);
  });

  it("пишет смену роли и удаление участника, отбирает по действию и сотруднику", async () => {
    setWsMockRole("owner");
    const VERA = "00000000-0000-4000-8000-000000000003";
    await api.wsSetMemberRole(VERA, "viewer");
    await api.wsRemoveMember("00000000-0000-4000-8000-000000000006");
    const all = await api.wsAudit();
    expect(all.items.map((i) => i.action)).toEqual(expect.arrayContaining(["member_role", "member_removed", "member_join"]));
    const only = await api.wsAudit({ action: "member_role" });
    expect(only.items).toHaveLength(1);
    expect(only.items[0]!.entity_id).toBe(VERA);
    expect((await api.wsAudit({ actor: "никто" })).items).toHaveLength(0);
  });

  it("диалог показывает записи с понятными подписями", async () => {
    setWsMockRole("owner");
    const ws = await api.wsState();
    setState({ ws });
    await api.wsSetMemberRole("00000000-0000-4000-8000-000000000003", "viewer");
    render(<AuditDialog onClose={() => undefined} />);
    const list = await screen.findByRole("list", { name: "Журнал действий" });
    await waitFor(() => expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(1));
    expect(within(list).getAllByText(/изменена роль/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
  });

  it("подписи действий и смены ответственного", () => {
    expect(actionText("owner_change")).toBe("сменил(а) ответственного");
    expect(actionText("new.thing")).toBe("new.thing");
    const members = [{ userId: "a", displayName: "Алексей", role: "owner", roleName: "В", rank: 1, avatarPath: null, email: null }];
    const i = { id: 1, actor_id: "a", action: "owner_change", entity_type: "deals", entity_id: "x", at: "", details: { from: "a", to: null } };
    expect(detailText(i, members)).toBe("Алексей → никого");
  });
});
