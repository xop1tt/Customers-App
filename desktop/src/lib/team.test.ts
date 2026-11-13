import { describe, expect, it } from "vitest";
import type { TeamMember } from "../api/types";
import { buildTree, insertMention, mentionMatches, mentionQuery, mentionedIds, notificationText, presenceText, reportsOf, tenure } from "./team";

const m = (id: string, name: string, manager: string | null = null, email = `${id}@example.com`): TeamMember => ({
  user_id: id, display_name: name, avatar: null, email, role: "employee", role_name: "Сотрудник", rank: 40, joined_at: null, title: "", department: "",
  manager_id: manager, hired_on: null, last_seen: null, online: false, can_edit: false,
});

describe("сотрудники", () => {
  it("стаж в годах и месяцах", () => {
    const now = new Date(2026, 10, 10);
    expect(tenure("2024-08-01", now)).toBe("2 года 3 месяца");
    expect(tenure("2026-05-10", now)).toBe("6 месяцев");
    expect(tenure("2021-11-10", now)).toBe("5 лет");
    expect(tenure("2026-11-01", now)).toBe("меньше месяца");
    expect(tenure("2025-11-11", now)).toBe("11 месяцев");
    expect(tenure(null, now)).toBe("");
    expect(tenure("мусор", now)).toBe("");
  });

  it("дерево подчинения: корни, вложенность, руководитель не из рабочего пространства, цикл", () => {
    const team = [m("a", "Алексей"), m("b", "Борис", "a"), m("c", "Вера", "b"), m("d", "Глеб", "zzz"), m("x", "Икс", "y"), m("y", "Игрек", "x")];
    const tree = buildTree(team);
    expect(tree.map((n) => n.member.user_id)).toEqual(["a", "d", "x"]);
    expect(tree[0]!.children[0]!.member.user_id).toBe("b");
    expect(tree[0]!.children[0]!.children[0]!.member.user_id).toBe("c");
    expect(tree[2]!.children.map((n) => n.member.user_id)).toEqual(["y"]);
    const all: string[] = [];
    const walk = (ns: typeof tree) => ns.forEach((n) => { all.push(n.member.user_id); walk(n.children); });
    walk(tree);
    expect(all.sort()).toEqual(["a", "b", "c", "d", "x", "y"]);
    expect(reportsOf(team, "a").map((x) => x.user_id)).toEqual(["b"]);
  });

  it("статус в сети", () => {
    expect(presenceText({ online: true, last_seen: null }, () => "")).toBe("В сети");
    expect(presenceText({ online: false, last_seen: "2026-11-10T10:00:00Z" }, () => "10:00")).toBe("Был(а) в сети: 10:00");
    expect(presenceText({ online: false, last_seen: null }, () => "")).toBe("Не в сети");
    expect(presenceText({ online: false, last_seen: null, offline: true }, () => "")).toBe("Нет связи с облаком");
  });
});

describe("упоминания", () => {
  it("находит набираемое @упоминание перед курсором", () => {
    expect(mentionQuery("Привет @Ве", 10)).toEqual({ start: 7, query: "Ве" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("почта alex@example.com", 22)).toBeNull();
    expect(mentionQuery("без собаки", 10)).toBeNull();
    expect(mentionQuery("@Вера\nдальше", 12)).toBeNull();
  });

  it("подсказка ищет по началу имени, фамилии и почты", () => {
    const team = [m("a", "Алексей Смирнова"), m("b", "Борис Петров", null, "boris@x.ru"), m("c", "Вера Ким")];
    expect(mentionMatches(team, "пе").map((x) => x.user_id)).toEqual(["b"]);
    expect(mentionMatches(team, "bor").map((x) => x.user_id)).toEqual(["b"]);
    expect(mentionMatches(team, "").length).toBe(3);
    expect(mentionMatches(team, "", ["a"]).map((x) => x.user_id)).toEqual(["b", "c"]);
  });

  it("вставляет @Имя и пробел, курсор после", () => {
    expect(insertMention("Привет @Ве и всё", 7, 10, "Вера Ким")).toEqual({ text: "Привет @Вера Ким  и всё", caret: 17 });
  });

  it("упомянутые: по @имени и по почте, без учёта регистра", () => {
    const team = [m("a", "Алексей"), m("b", "Борис Петров", null, "boris@x.ru"), m("c", "Вера")];
    expect(mentionedIds("@борис петров и ANNA? нет. BORIS@X.RU", team)).toEqual(["b"]);
    expect(mentionedIds("@Алексей, @Вера", team)).toEqual(["a", "c"]);
  });

  it("тексты уведомлений", () => {
    expect(notificationText({ kind: "mention", actor_name: "Вера" })).toBe("Вера упоминает вас в обсуждении");
    expect(notificationText({ kind: "added_to_group", actor_name: "Глеб" })).toBe("Глеб добавляет вас в обсуждение");
    expect(notificationText({ kind: "note_mention", actor_name: "Глеб" })).toBe("Глеб упоминает вас в заметке");
    expect(notificationText({ kind: "comment_mention", actor_name: "Глеб" })).toBe("Глеб упоминает вас в комментарии");
  });
});
