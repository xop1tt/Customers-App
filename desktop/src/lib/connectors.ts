// Проверки коннекторов и компаний-разработчиков (ADR-083): чистая логика без сети. Те же правила выполняются перед отправкой
// в окне «Новый коннектор» и в демо-сервере; настоящий сервер перепроверит их при подаче (нужна база, см. DECISIONS).

import type { MarketManifest, MarketCompany } from "../api/types";

export type CheckLevel = "ok" | "warn" | "fail";
export interface Check { id: string; label: string; level: CheckLevel; detail: string }

export interface ConnectorMeta {
  slug: string; name: string; tagline: string; description: string; icon: string; website: string; support_email: string; version: string;
}

const HTTPS = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{2,5})?(\/[^\s<>"]*)?$/i;
const PRIVATE_HOST = /^https:\/\/(localhost|[\d.]+|\[[0-9a-f:]+\]|[^/:]+\.(local|internal|lan))([:/]|$)/i;
const EVENTS = ["record.created", "record.updated", "record.deleted", "deal.stage_changed"];
const ENTITIES = ["company", "contact", "crm_lead", "deal"];
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const FREE_MAIL = ["gmail.com", "mail.ru", "yandex.ru", "ya.ru", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "bk.ru", "inbox.ru", "list.ru", "proton.me", "protonmail.com", "rambler.ru"];

export const hostOf = (url: string): string | null => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
const emailDomain = (e: string) => e.split("@")[1]?.toLowerCase() ?? "";
const sameSite = (host: string, dom: string) => host === dom || host.endsWith(`.${dom}`) || dom.endsWith(`.${host}`);
const item = (id: string, label: string, ok: boolean, detail: string, level: CheckLevel = "fail"): Check => ({ id, label, level: ok ? "ok" : level, detail: ok ? "В порядке" : detail });

/** Автоматическая проверка качества: структура манифеста, права, адреса https, описание, значок, версия, контакты. */
export function checkConnector(meta: ConnectorMeta, m: MarketManifest | null): Check[] {
  const out: Check[] = [];
  out.push(item("name", "Название", meta.name.trim().length >= 2 && meta.name.trim().length <= 60, "Название — от 2 до 60 символов."));
  out.push(item("slug", "Адрес в каталоге", /^[a-z0-9][a-z0-9-]{2,39}$/.test(meta.slug), "Латиница, цифры и дефис, от 3 символов."));
  out.push(item("version", "Версия", SEMVER.test(meta.version), "Версия — в виде 1.0.0."));
  out.push(item("tagline", "Краткое описание", meta.tagline.trim().length >= 10 && meta.tagline.trim().length <= 140, "Кратко — от 10 до 140 символов: что делает коннектор."));
  out.push(item("description", "Полное описание", meta.description.trim().length >= 40, "Опишите коннектор подробнее: не короче 40 символов.", "warn"));
  out.push(item("icon", "Значок", [...meta.icon.trim()].length >= 1 && [...meta.icon.trim()].length <= 4 && !/[a-z0-9]/i.test(meta.icon), "Значок — один эмодзи."));
  out.push(item("website", "Сайт", HTTPS.test(meta.website.trim()) && !PRIVATE_HOST.test(meta.website.trim()), "Сайт — публичный адрес https."));
  out.push(item("support", "Почта поддержки", EMAIL.test(meta.support_email.trim()), "Укажите рабочую почту поддержки."));
  if (!m || typeof m !== "object") {
    out.push({ id: "manifest", label: "Манифест", level: "fail", detail: "Манифест — объект JSON." });
    return out;
  }
  out.push(item("schema", "Версия манифеста", (m.schema ?? 1) === 1, "Поддерживается только schema: 1."));
  const scopes = m.scopes ?? [];
  out.push(item("scopes", "Права доступа", scopes.every((s) => s === "crm.read") && new Set(scopes).size === scopes.length, "Неизвестное или повторяющееся право: доступно только crm.read."));
  if (m.webhooks) {
    const w = m.webhooks;
    out.push(item("webhook-url", "Адрес событий", HTTPS.test(w.url ?? "") && !PRIVATE_HOST.test(w.url ?? ""), "webhooks.url — публичный адрес https, не localhost и не IP."));
    out.push(item("webhook-events", "События", !!w.events?.length && w.events.every((e) => EVENTS.includes(e)), `webhooks.events — из списка: ${EVENTS.join(", ")}.`));
    if (scopes.length === 0 && w.events?.length) out.push({ id: "webhook-scope", label: "Права и события", level: "warn", detail: "События придут без полей записей: только идентификаторы. Добавьте crm.read, если поля нужны." });
  }
  const actions = m.actions ?? [];
  out.push(item("actions-count", "Число кнопок", actions.length <= 10, "Не больше 10 действий."));
  const bad = actions.find((a) => !/^[a-z0-9_-]{1,40}$/.test(a.id ?? "") || !a.label?.trim() || a.label.length > 40 || !ENTITIES.includes(a.entity) || !HTTPS.test(a.url ?? "")
    || PRIVATE_HOST.test(a.url ?? "") || /[{}]/.test((a.url ?? "").replace(/\{(id|type|workspace_id|title)\}/g, "")) || ((a.url ?? "").includes("{title}") && !scopes.includes("crm.read")));
  out.push(item("actions", "Кнопки в карточках", !bad, bad ? `Проверьте кнопку «${bad.label || bad.id}»: id, название до 40 символов, тип записи, адрес https; {title} требует crm.read; других подстановок нет.` : ""));
  out.push(item("actions-unique", "Уникальные id кнопок", new Set(actions.map((a) => a.id)).size === actions.length, "id кнопок не должны повторяться."));
  if (m.window) out.push(item("window", "Окно плагина", HTTPS.test(m.window.url ?? "") && !PRIVATE_HOST.test(m.window.url ?? ""), "window.url — публичный адрес https."));
  if (!m.webhooks && actions.length === 0 && !m.window) out.push({ id: "empty", label: "Что делает коннектор", level: "fail", detail: "Нужны кнопки в карточках или события: пустой манифест ничего не делает." });
  // Совпадение сайта разработчика с адресами манифеста: частая ошибка и признак чужого сервиса.
  const site = hostOf(meta.website.trim());
  const hosts = [m.webhooks?.url, ...actions.map((a) => a.url)].filter((u): u is string => !!u).map((u) => hostOf(u.replace(/\{[a-z_]+\}/g, "x")));
  if (site && hosts.some((h) => h && !sameSite(h, site))) out.push({ id: "hosts", label: "Адреса и сайт", level: "warn", detail: "Часть адресов ведёт не на домен вашего сайта: модератор уточнит, чей это сервис." });
  return out;
}

export const failedChecks = (c: Check[]) => c.filter((x) => x.level === "fail");
export const firstFailure = (c: Check[]): string | null => failedChecks(c)[0]?.detail ?? null;

/** Проверка заявки компании: данные юридического лица, домен рабочей почты совпадает с сайтом, политика конфиденциальности. */
export function checkCompany(c: Omit<MarketCompany, "status" | "note" | "submitted_at">): Check[] {
  const site = hostOf(c.website.trim());
  const dom = emailDomain(c.contact_email.trim());
  return [
    item("legal", "Юридическое название", c.legal_name.trim().length >= 3, "Укажите полное название компании или ИП."),
    item("country", "Страна регистрации", c.country.trim().length >= 2, "Укажите страну регистрации."),
    item("reg", "Регистрационный номер", /^[0-9A-Za-z\- ]{8,20}$/.test(c.reg_number.trim()), "ИНН, ОГРН или номер из реестра вашей страны: 8–20 знаков."),
    item("site", "Сайт компании", HTTPS.test(c.website.trim()) && !PRIVATE_HOST.test(c.website.trim()), "Сайт — публичный адрес https."),
    item("person", "Контактное лицо", c.contact_name.trim().length >= 3, "Укажите имя ответственного за коннекторы."),
    item("email", "Рабочая почта", EMAIL.test(c.contact_email.trim()) && !FREE_MAIL.includes(dom), "Нужна рабочая почта на домене компании, не личная (gmail, mail.ru и подобные)."),
    item("domain", "Домен почты и сайта", !!site && !!dom && sameSite(site, dom), "Домен почты должен совпадать с доменом сайта: так подтверждается, что вы представляете компанию."),
    item("privacy", "Политика конфиденциальности", HTTPS.test(c.privacy_url.trim()) && hostOf(c.privacy_url.trim()) !== null && !!site && sameSite(hostOf(c.privacy_url.trim())!, site), "Адрес политики конфиденциальности на сайте компании (https)."),
  ];
}
