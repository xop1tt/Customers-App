import { describe, expect, it } from "vitest";
import type { CrmRecord } from "../api/types";
import { ENTITIES } from "./crm";
import { defaultChoice, differences, mergeValues, union } from "./merge";

const rec = (f: Record<string, unknown>) => ({ id: "x", ...f }) as unknown as CrmRecord;

describe("объединение дубликатов: выбор значений", () => {
  it("списки объединяются без повторов: телефоны по цифрам, почта без регистра", () => {
    expect(union(["+7 (999) 111-22-33", "a@b.ru"], ["+79991112233", "A@B.RU", "c@d.ru"])).toEqual(["+7 (999) 111-22-33", "a@b.ru", "c@d.ru"]);
    expect(union(null, ["x"])).toEqual(["x"]);
  });

  it("решение нужно только там, где значения различаются и у дубликата значение есть", () => {
    const keep = rec({ name: "Ромашка", inn: null, phones: ["+7 999 111-22-33"], industry: "Ритейл", emails: [] });
    const other = rec({ name: "ООО «Ромашка»", inn: "1655000000", phones: ["+79991112233"], industry: null, emails: ["info@romashka.ru"] });
    const d = differences(ENTITIES.company, keep, other);
    expect(d.map((x) => x.field.name)).toEqual(["name", "inn", "emails"]);
    expect(d.map(defaultChoice)).toEqual(["keep", "other", "other"]);
    expect(mergeValues(d, {})).toEqual({ inn: "1655000000", emails: ["info@romashka.ru"] });
    expect(mergeValues(d, { name: "other", emails: "keep" })).toEqual({ name: "ООО «Ромашка»", inn: "1655000000" });
  });

  it("у списков с обеих сторон по умолчанию «оба»", () => {
    const d = differences(ENTITIES.contact, rec({ phones: ["1"] }), rec({ phones: ["2"] }));
    expect(defaultChoice(d[0]!)).toBe("both");
    expect(mergeValues(d, {})).toEqual({ phones: ["1", "2"] });
    expect(mergeValues(d, { phones: "other" })).toEqual({ phones: ["2"] });
  });
});
