// Видимость записей роли (ADR-095) в редакторе ролей на демо-ядре облачной команды.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { resetWsMock, setWsMockRole } from "../../api/wsMock";
import { setState } from "../../state/store";
import { RolesEditor } from "./Editors";

vi.hoisted(() => { window.history.replaceState({}, "", "/?team"); });

afterEach(cleanup);
beforeEach(() => resetWsMock());

describe("видимость записей роли", () => {
  it("владелец переключает «Сотрудника» на «Свой отдел»; свою роль и роль выше не изменить", async () => {
    setWsMockRole("owner");
    setState({ ws: await api.wsState() });
    render(<RolesEditor onClose={() => undefined} />);
    const emp = await screen.findByRole("button", { name: /Какие записи видит роль «Сотрудник»/ });
    expect(emp).toHaveTextContent("Все записи");
    fireEvent.click(emp);
    fireEvent.click(await screen.findByRole("option", { name: "Свой отдел и подотделы" }));
    await waitFor(() => expect(emp).toHaveTextContent("Свой отдел и подотделы"));
    expect((await api.wsRoles()).roles.find((r) => r.key === "employee")?.scope).toBe("department");
    expect(screen.getAllByText("видит все записи").length).toBe(1); // владелец видит всё всегда
  });

  it("администратор не меняет видимость своей роли", async () => {
    setWsMockRole("admin");
    setState({ ws: await api.wsState() });
    await expect(api.wsSetRoleScope("admin", "own")).rejects.toThrow(/ниже вашей/);
    render(<RolesEditor onClose={() => undefined} />);
    expect(await screen.findByRole("button", { name: /Какие записи видит роль «Администратор»/ })).toBeDisabled();
  });
});
