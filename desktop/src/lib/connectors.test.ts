import { describe, expect, it } from "vitest";
import { checkCompany, checkConnector, failedChecks, firstFailure } from "./connectors";

const meta = { slug: "sklad-online", name: "Склад онлайн", tagline: "Остатки товаров в сделке", description: "Показывает остатки товаров на складе прямо в карточке сделки.", icon: "📦",
  website: "https://sklad.example.com", support_email: "help@sklad.example.com", version: "1.0.0" };
const manifest = { schema: 1 as const, scopes: ["crm.read"], webhooks: { url: "https://sklad.example.com/hook", events: ["record.created"] },
  actions: [{ id: "stock", label: "Остатки", entity: "deal" as const, url: "https://sklad.example.com/{id}?n={title}" }] };

describe("автоматическая проверка коннектора", () => {
  it("исправный коннектор проходит без замечаний", () => {
    expect(failedChecks(checkConnector(meta, manifest))).toEqual([]);
  });
  it("ловит неверные поля описания, версию, значок и контакты", () => {
    const c = checkConnector({ ...meta, name: "A", slug: "Ab", version: "1.0", tagline: "коротко", icon: "x", website: "http://a.com", support_email: "нет" }, manifest);
    expect(failedChecks(c).map((x) => x.id).sort()).toEqual(["icon", "name", "slug", "support", "tagline", "version", "website"]);
  });
  it("адреса — только публичный https; localhost, IP и http отклоняются", () => {
    for (const url of ["http://sklad.example.com/hook", "https://localhost/hook", "https://10.0.0.5/hook", "https://srv.internal/hook"]) {
      expect(failedChecks(checkConnector(meta, { ...manifest, webhooks: { url, events: ["record.created"] } })).map((x) => x.id)).toContain("webhook-url");
    }
  });
  it("права, события, подстановки и число кнопок проверяются", () => {
    expect(firstFailure(checkConnector(meta, { ...manifest, scopes: ["crm.write"] }))).toContain("crm.read");
    expect(firstFailure(checkConnector(meta, { ...manifest, webhooks: { url: "https://sklad.example.com/h", events: ["nope"] } }))).toContain("webhooks.events");
    expect(failedChecks(checkConnector(meta, { ...manifest, scopes: [] })).map((x) => x.id)).toContain("actions");
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, label: "A", entity: "deal" as const, url: "https://sklad.example.com/x" }));
    expect(failedChecks(checkConnector(meta, { schema: 1, actions: many })).map((x) => x.id)).toContain("actions-count");
    expect(failedChecks(checkConnector(meta, { schema: 1, actions: [{ id: "a", label: "A", entity: "deal", url: "https://sklad.example.com/{secret}" }] })).map((x) => x.id)).toContain("actions");
    expect(failedChecks(checkConnector(meta, { schema: 1 })).map((x) => x.id)).toContain("empty");
  });
  it("чужой домен в адресах — предупреждение, не отказ", () => {
    const c = checkConnector(meta, { ...manifest, webhooks: { url: "https://other.example.org/hook", events: ["record.created"] } });
    expect(failedChecks(c)).toEqual([]);
    expect(c.find((x) => x.id === "hosts")?.level).toBe("warn");
  });
});

describe("проверка компании", () => {
  const company = { legal_name: "ООО Склад", country: "Россия", reg_number: "7712345678", website: "https://sklad.example.com", contact_name: "Пётр Складов",
    contact_email: "petr@sklad.example.com", privacy_url: "https://sklad.example.com/privacy" };
  it("полная заявка без замечаний", () => expect(failedChecks(checkCompany(company))).toEqual([]));
  it("личная почта и чужой домен не принимаются", () => {
    expect(failedChecks(checkCompany({ ...company, contact_email: "petr@gmail.com" })).map((x) => x.id)).toContain("email");
    expect(failedChecks(checkCompany({ ...company, contact_email: "petr@other.org" })).map((x) => x.id)).toEqual(["domain"]);
    expect(failedChecks(checkCompany({ ...company, privacy_url: "https://other.org/p" })).map((x) => x.id)).toEqual(["privacy"]);
    expect(failedChecks(checkCompany({ ...company, reg_number: "1" })).map((x) => x.id)).toEqual(["reg"]);
  });
});
