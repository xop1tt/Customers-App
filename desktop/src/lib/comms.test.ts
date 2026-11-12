import { describe, expect, it } from "vitest";
import type { CrmRecord } from "../api/types";
import { contactPoints, fillTemplate, isEmail, nextAction, nextActions, quickDue, TEMPLATES } from "./comms";

const rec = (fields: Record<string, unknown>) => ({ id: String(Math.random()), version: 1, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", ...fields }) as unknown as CrmRecord;
const tpl = (id: string) => TEMPLATES.find((x) => x.id === id)!;

describe("куда звонить и писать", () => {
  it("собирает телефоны и адреса без повторов, с подписью владельца", () => {
    const company = rec({ name: "Ромашка", phones: ["+7 999 111-22-33"], emails: ["Info@romashka.ru"] });
    const person = rec({ full_name: "Иван Петров", phones: ["+79991112233", "8 800 000-00-00"], emails: ["info@romashka.ru", "ivan@romashka.ru", " "] });
    expect(contactPoints([company, person], "phones")).toEqual([
      { value: "+7 999 111-22-33", owner: "Ромашка" },
      { value: "8 800 000-00-00", owner: "Иван Петров" },
    ]);
    expect(contactPoints([company, person], "emails").map((x) => x.value)).toEqual(["Info@romashka.ru", "ivan@romashka.ru"]);
    expect(contactPoints([rec({ first_name: "Анна", emails: "не список" })], "emails")).toEqual([]);
  });

  it("проверяет адрес", () => {
    expect(isEmail(" ivan@romashka.ru ")).toBe(true);
    expect(isEmail("ivan@romashka")).toBe(false);
    expect(isEmail("")).toBe(false);
  });
});

describe("шаблоны писем", () => {
  it("подставляет имя, компанию, сделку и подпись", () => {
    const r = fillTemplate(tpl("offer"), { name: "Иван", company: "Ромашка", deal: "Сайт", signature: "С уважением,\nМаксим" });
    expect(r.subject).toBe("Предложение для Ромашка");
    expect(r.body.startsWith("Здравствуйте, Иван!\n\nКак договаривались, отправляю предложение по «Сайт».")).toBe(true);
    expect(r.body.endsWith("\n\nС уважением,\nМаксим")).toBe(true);
  });

  it("аккуратно убирает пустые подстановки", () => {
    const r = fillTemplate(tpl("after_meeting"), { name: "", company: "", deal: "", signature: " " });
    expect(r.subject).toBe("Итоги встречи");
    expect(r.body.startsWith("Здравствуйте!\n\n")).toBe(true);
    expect(fillTemplate(tpl("follow_up"), { name: "", company: "", deal: "", signature: "" }).subject).toBe("Напоминаю о");
    expect(fillTemplate(tpl("blank"), { name: "Анна", company: "", deal: "", signature: "" })).toEqual({ subject: "", body: "Здравствуйте, Анна!" });
  });
});

describe("следующее действие", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  it("берёт ближайшую открытую задачу со сроком, иначе самую раннюю без срока", () => {
    const later = rec({ title: "Отправить КП", due_at: "2026-11-15T10:00:00Z", status: "todo" });
    const sooner = rec({ title: "Позвонить", due_at: "2026-11-12T10:00:00Z", status: "in_progress" });
    const done = rec({ title: "Готово", due_at: "2026-11-01T10:00:00Z", status: "done" });
    const removed = rec({ title: "Удалена", due_at: "2026-11-02T10:00:00Z", status: "todo", deleted_at: "2026-11-03T00:00:00Z" });
    const undated = rec({ title: "Без срока", status: "todo" });
    expect(nextAction([later, done, undated, sooner, removed], now)).toMatchObject({ task: { title: "Позвонить" }, overdue: false, dated: true });
    expect(nextAction([undated, done], now)).toMatchObject({ task: { title: "Без срока" }, overdue: false, dated: false });
    expect(nextAction([done, rec({ status: "cancelled" })], now)).toBeNull();
    expect(nextAction([rec({ title: "Просрочена", due_at: "2026-11-10T10:00:00Z", status: "todo" })], now)?.overdue).toBe(true);
  });

  it("раскладывает задачи по сделкам и пропускает чужие", () => {
    const m = nextActions([
      rec({ title: "A", entity_type: "deal", entity_id: "d1", status: "todo", due_at: "2026-11-20T00:00:00Z" }),
      rec({ title: "B", entity_type: "deal", entity_id: "d1", status: "todo", due_at: "2026-11-13T00:00:00Z" }),
      rec({ title: "C", entity_type: "company", entity_id: "d1", status: "todo" }),
      rec({ title: "D", entity_type: "deal", entity_id: "d2", status: "done" }),
    ], now);
    expect([...m.keys()]).toEqual(["d1"]);
    expect(m.get("d1")?.task.title).toBe("B");
  });

  it("быстрые сроки", () => {
    const base = new Date(2026, 10, 11, 9, 30);
    expect(quickDue("today", base).getHours()).toBe(11);
    expect(quickDue("today", new Date(2026, 10, 11, 23, 10)).getDate()).toBe(11);
    const tomorrow = quickDue("tomorrow", base);
    expect([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([12, 10, 0]);
    expect(quickDue("week", base).getDate()).toBe(18);
  });
});
