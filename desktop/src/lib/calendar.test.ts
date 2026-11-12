import { afterEach, describe, expect, it } from "vitest";
import type { CrmRecord } from "../api/types";
import { byDay, calendarItems, dayKey, defaultDue, moveToDay, periodTitle, queryRange, shift, visibleDays, weekdays, weekStart } from "./calendar";
import { setLanguage } from "./i18n";

afterEach(() => setLanguage("ru"));

const rec = (fields: Record<string, unknown>): CrmRecord => ({ id: "x", deleted_at: null, archived_at: null, ...fields }) as unknown as CrmRecord;
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

describe("сетка календаря", () => {
  it("неделя начинается с понедельника", () => {
    expect(dayKey(weekStart(local(2026, 11, 11)))).toBe("2026-11-09");
    expect(dayKey(weekStart(local(2026, 11, 15)))).toBe("2026-11-09");
    expect(dayKey(weekStart(local(2026, 11, 9)))).toBe("2026-11-09");
    expect(visibleDays("week", local(2026, 11, 11)).map(dayKey)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  });

  it("дни недели подписаны на языке интерфейса", () => {
    expect(weekdays()).toEqual(["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]);
    setLanguage("en");
    expect(weekdays()).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  it("месяц показывается целыми неделями", () => {
    const nov = visibleDays("month", local(2026, 11, 11));
    expect([nov.length, dayKey(nov[0]!), dayKey(nov.at(-1)!)]).toEqual([42, "2026-10-26", "2026-12-06"]);
    const feb = visibleDays("month", local(2027, 2, 10));
    expect([feb.length, dayKey(feb[0]!), dayKey(feb.at(-1)!)]).toEqual([28, "2027-02-01", "2027-02-28"]);
    const sep = visibleDays("month", local(2026, 9, 30));
    expect([sep.length, dayKey(sep[0]!), dayKey(sep.at(-1)!)]).toEqual([35, "2026-08-31", "2026-10-04"]);
  });

  it("листает месяц и неделю, подписывает период на двух языках", () => {
    expect(dayKey(shift("month", local(2026, 12, 31), 1))).toBe("2027-01-01");
    expect(dayKey(shift("month", local(2026, 3, 31), -1))).toBe("2026-02-01");
    expect(dayKey(shift("week", local(2026, 11, 11), -1))).toBe("2026-11-04");
    expect(periodTitle("month", local(2026, 11, 11))).toBe("Ноябрь 2026");
    expect(periodTitle("week", local(2026, 11, 11))).toBe("9–15 ноября 2026");
    expect(periodTitle("week", local(2026, 12, 1))).toBe("30 ноября – 6 декабря 2026");
    expect(periodTitle("week", local(2026, 12, 30))).toBe("28 декабря 2026 – 3 января 2027");
    setLanguage("en");
    expect(periodTitle("month", local(2026, 11, 11))).toBe("November 2026");
    expect(periodTitle("week", local(2026, 11, 11))).toBe("Nov 9 – 15, 2026");
    expect(periodTitle("week", local(2026, 12, 1))).toBe("Nov 30 – Dec 6, 2026");
    expect(periodTitle("week", local(2026, 12, 30))).toBe("Dec 28, 2026 – Jan 3, 2027");
  });
});

describe("записи календаря", () => {
  const now = local(2026, 11, 11, 12, 0);
  const tasks = [
    rec({ id: "t1", title: "Позвонить", due_at: local(2026, 11, 11, 15, 30).toISOString(), status: "todo", assignee_id: "me" }),
    rec({ id: "t2", title: "Просрочена", due_at: local(2026, 11, 10, 9, 0).toISOString(), status: "in_progress", assignee_id: null }),
    rec({ id: "t3", title: "Готова", due_at: local(2026, 11, 10, 8, 0).toISOString(), status: "done", assignee_id: "me" }),
    rec({ id: "t4", title: "Чужая", due_at: local(2026, 11, 12, 8, 0).toISOString(), status: "todo", assignee_id: "other" }),
    rec({ id: "t5", title: "Без срока", due_at: null, status: "todo" }),
    rec({ id: "t6", title: "Удалена", due_at: local(2026, 11, 11, 8, 0).toISOString(), status: "todo", deleted_at: "2026-11-01T00:00:00.000Z" }),
  ];
  const activities = [
    rec({ id: "a1", type: "meeting", summary: "Показ", occurred_at: local(2026, 11, 13, 11, 0).toISOString(), created_by: "me" }),
    rec({ id: "a2", type: "call", summary: "", occurred_at: local(2026, 11, 11, 9, 0).toISOString(), created_by: "other" }),
    rec({ id: "a3", type: "system", summary: "Перенесено", occurred_at: local(2026, 11, 11, 9, 0).toISOString(), created_by: "me" }),
  ];

  it("берёт задачи со сроком и события без служебных, отмечает просроченные и выполненные", () => {
    const items = calendarItems(tasks, activities, now);
    expect(items.map((i) => i.key)).toEqual(["task:t3", "task:t2", "activity:a2", "task:t1", "task:t4", "activity:a1"]);
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect([by["task:t2"]!.overdue, by["task:t3"]!.overdue, by["task:t3"]!.done, by["task:t1"]!.overdue]).toEqual([true, false, true, false]);
    expect([by["activity:a2"]!.title, by["activity:a1"]!.title, by["activity:a2"]!.done, by["activity:a1"]!.done]).toEqual(["Звонок", "Встреча: Показ", true, false]);
  });

  it("«Мои» оставляет свои задачи, задачи без исполнителя и свои события", () => {
    expect(calendarItems(tasks, activities, now, "me").map((i) => i.key)).toEqual(["task:t3", "task:t2", "task:t1", "activity:a1"]);
  });

  it("раскладывает по местным дням", () => {
    const map = byDay(calendarItems(tasks, activities, now));
    expect(map.get("2026-11-11")!.map((i) => i.key)).toEqual(["activity:a2", "task:t1"]);
    expect(map.get("2026-11-10")!.map((i) => i.key)).toEqual(["task:t3", "task:t2"]);
    expect(map.get("2026-11-14")).toBeUndefined();
  });

  it("перенос на другой день сохраняет время, тот же день ничего не меняет", () => {
    const due = local(2026, 11, 11, 15, 30).toISOString();
    expect(moveToDay(due, local(2026, 11, 20))).toBe(local(2026, 11, 20, 15, 30).toISOString());
    expect(moveToDay(due, local(2026, 11, 11, 23, 0))).toBeNull();
    expect(moveToDay("не дата", local(2026, 11, 20))).toBeNull();
    expect(defaultDue(local(2026, 11, 20, 18, 45))).toBe(local(2026, 11, 20, 10, 0).toISOString());
  });

  it("запрос к ядру покрывает видимые дни с запасом", () => {
    const days = visibleDays("week", local(2026, 11, 11));
    const r = queryRange(days);
    expect(r.from).toBe(local(2026, 11, 8).toISOString());
    expect(r.to).toBe(local(2026, 11, 17).toISOString());
  });
});
