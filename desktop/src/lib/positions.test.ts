import { describe, expect, it } from "vitest";
import type { TeamMember } from "../api/types";
import { approversOf, assignable, canManageDepartments, isApprover, isHr, nameError, nameLocked, nameRequestRecipients, positionOf, POSITIONS, requestText, roleFor } from "./positions";

const m = (id: string, role: string, rank: number, title = "", extra: Partial<TeamMember> = {}): TeamMember => ({
  user_id: id, display_name: id, avatar: null, email: null, role, role_name: role, rank, joined_at: null, title, department: "", manager_id: null,
  hired_on: null, last_seen: null, online: false, can_edit: true, ...extra,
});

describe("справочник должностей", () => {
  it("находит должность по названию без учёта регистра и ё; прежний текст — не из справочника", () => {
    expect(positionOf(" руководитель отдела КАДРОВ ")?.hr).toBe(true);
    expect(positionOf("Менеджер по продажам")).toBeNull();
    expect(positionOf("")).toBeNull();
  });
  it("названия и ключи уникальны, руководящие — с рангом от 70", () => {
    expect(new Set(POSITIONS.map((p) => p.key)).size).toBe(POSITIONS.length);
    expect(new Set(POSITIONS.map((p) => p.name)).size).toBe(POSITIONS.length);
    for (const p of POSITIONS.filter((x) => x.lead)) expect(p.rank).toBeGreaterThanOrEqual(70);
    expect(POSITIONS.find((p) => p.key === "lead")?.role).toBe("team_lead");
  });
  it("роль по должности: точная, иначе ближайшая ниже по рангу, владельца не выдаёт", () => {
    const lead = POSITIONS.find((p) => p.key === "lead")!;
    expect(roleFor(lead, [{ key: "team_lead", rank: 70 }, { key: "manager", rank: 60 }])).toBe("team_lead");
    expect(roleFor(lead, [{ key: "owner", rank: 100 }, { key: "admin", rank: 80 }, { key: "manager", rank: 60 }, { key: "employee", rank: 40 }])).toBe("manager");
    expect(roleFor(lead, [{ key: "owner", rank: 100 }])).toBeNull();
    expect(roleFor(lead, [])).toBe("team_lead");
  });
});

describe("кто что может", () => {
  const owner = m("o", "owner", 100);
  const deputy = m("d", "admin", 80, "Заместитель владельца");
  const lead = m("l", "team_lead", 70, "Руководитель");
  const hr = m("h", "manager", 60, "Специалист отдела кадров");
  const worker = m("w", "employee", 40, "Сотрудник");

  it("отделы создают владелец, заместитель и старший по должности; рядовой и кадровик — нет", () => {
    expect(canManageDepartments(owner)).toBe(true);
    expect(canManageDepartments(deputy)).toBe(true);
    expect(canManageDepartments(lead)).toBe(true);
    expect(canManageDepartments(worker)).toBe(false);
    expect(canManageDepartments(hr)).toBe(false);
  });
  it("кадровик работает только запросом; владелец и заместитель — сами", () => {
    expect(isHr(hr)).toBe(true);
    expect(isHr(owner)).toBe(false);
    expect(isHr(m("x", "admin", 80, "Руководитель отдела кадров"))).toBe(false);
    expect(isApprover(deputy)).toBe(true);
    expect(isApprover(lead)).toBe(false);
  });
  it("заместителя назначает только владелец, назначают строго ниже своего ранга, себе равного не назначить", () => {
    expect(assignable(owner, worker).some((p) => p.deputy)).toBe(true);
    expect(assignable(deputy, worker).some((p) => p.deputy)).toBe(false);
    expect(assignable(deputy, worker).every((p) => p.rank < 80)).toBe(true);
    expect(assignable(lead, worker).every((p) => p.rank < 70)).toBe(true);
    expect(assignable(lead, deputy)).toEqual([]);
    expect(assignable(hr, worker)).toEqual([]);
    expect(assignable(worker, worker)).toEqual([]);
  });
  it("адресаты запросов: владелец и заместители; запрос на имя — ещё и руководитель", () => {
    const team = [owner, deputy, lead, hr, m("w", "employee", 40, "", { manager_id: "l" })];
    expect(approversOf(team, "d").map((x) => x.user_id)).toEqual(["o"]);
    expect(nameRequestRecipients(team, team[4]!).map((x) => x.user_id)).toEqual(["l", "o", "d"]);
  });
  it("имя профиля блокируется у всех, кроме владельца и заместителя", () => {
    expect(nameLocked(worker)).toBe(true);
    expect(nameLocked(hr)).toBe(true);
    expect(nameLocked(owner)).toBe(false);
    expect(nameLocked(deputy)).toBe(false);
    expect(nameError(" ", "Алексей")).not.toBeNull();
    expect(nameError("Алексей", "Алексей ")).not.toBeNull();
    expect(nameError("Алексей Ким", "Алексей")).toBeNull();
  });
  it("тексты запросов", () => {
    expect(requestText({ kind: "hire", author: "H", email: "a@b.ru", name: "Алексей Ким", position: "Менеджер", reason: "новый отдел" })).toBe(
      "Запрос на оформление: прошу создать учётную запись для a@b.ru, имя профиля «Алексей Ким», должность «Менеджер». Причина: новый отдел");
    expect(requestText({ kind: "access", author: "H", target: "Вера" })).toBe("Запрос на закрытие доступа: Вера.");
    expect(requestText({ kind: "name", author: "W", name: "Вера Ким" })).toContain("«Вера Ким»");
  });
});
