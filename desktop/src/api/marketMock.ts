// Демо-маркетплейс (ws_market) для браузера и тестов. Повторяет правила сервера (миграция 20261111100000_marketplace.sql),
// которые видны в интерфейсе: каталог только из одобренных версий, установка — право workspace.manage,
// установленная версия не меняется сама, подача ждёт модерации, модератор одобряет или отклоняет с причиной.

import type { MarketApp, MarketCategory, MarketInstalled, MarketManifest, MarketReview, MarketVersion } from "./types";

export interface MarketCtx { cloud: boolean; me: string; wsId: string | null; perms: string[]; moderator: boolean }

interface App extends Omit<MarketApp, "installed" | "version" | "manifest" | "versions" | "installs"> { developer_id: string; live: string | null }
interface Ver extends MarketVersion { app_id: string }
interface Install { ws: string; app: string; version: string; enabled: boolean; installed_at: string }

let apps: App[] = [];
let versions: Ver[] = [];
let installs: Install[] = [];
let n = 0;
const nid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`;
const iso = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const fail = (message: string, code = "error"): never => { throw { code, message }; };

function seedApp(a: Partial<App> & Pick<App, "slug" | "name" | "icon" | "category" | "tagline">, manifest: MarketManifest, version = "1.0.0", status: MarketVersion["status"] = "approved", dev = "dev-partner"): App {
  const app: App = {
    id: nid(), developer_id: dev, developer_name: "ООО Партнёр", description: "", website: "https://example.com", support_email: "help@example.com",
    status: status === "approved" ? "listed" : "draft", status_note: null, updated_at: iso(3), live: null, ...a,
  };
  const v: Ver = { id: nid(), app_id: app.id, version, manifest, status, review_note: null, created_at: iso(5) };
  if (status === "approved") app.live = v.id;
  apps.push(app);
  versions.push(v);
  return app;
}

export function resetMarketMock() {
  apps = []; versions = []; installs = []; n = 0;
  seedApp({ slug: "zvonilka", name: "Звонилка", icon: "📞", category: "telephony", tagline: "Звонки клиентам из карточки и запись разговоров",
    description: "Кнопка «Позвонить» в карточках компаний и контактов. История звонков приходит в CRM.\n\nНужен аккаунт Звонилки." },
    { schema: 1, scopes: ["crm.read"], webhooks: { url: "https://hooks.example.com/zvonilka", events: ["record.created", "record.updated"] },
      actions: [{ id: "call", label: "Позвонить", entity: "contact", url: "https://app.example.com/call/{id}?name={title}" },
                { id: "company", label: "Звонки компании", entity: "company", url: "https://app.example.com/company/{id}" }] });
  seedApp({ slug: "docs-plus", name: "Документы+", icon: "📄", category: "documents", tagline: "Счета и договоры по шаблонам",
    description: "Создаёт счёт или договор по сделке в один клик." },
    { schema: 1, scopes: [], actions: [{ id: "invoice", label: "Выставить счёт", entity: "deal", url: "https://docs.example.com/new?deal={id}" }] });
  seedApp({ slug: "metrics-pro", name: "Аналитика Pro", icon: "📊", category: "analytics", tagline: "Отчёты по воронке и менеджерам",
    description: "Получает события сделок и строит отчёты." },
    { schema: 1, scopes: ["crm.read"], webhooks: { url: "https://metrics.example.com/in", events: ["deal.stage_changed"] } });
  // Ждёт проверки: видна модератору, но не в каталоге.
  seedApp({ slug: "tg-notify", name: "Уведомления в Telegram", icon: "✈️", category: "messaging", tagline: "Новые лиды — в чат отдела",
    description: "Присылает новые лиды в Telegram-чат." },
    { schema: 1, scopes: ["crm.read"], webhooks: { url: "https://tg.example.com/hook", events: ["record.created"] } }, "0.9.0", "pending", "dev-other");
}
resetMarketMock();

function json(a: App, ws: string | null): MarketApp {
  const live = versions.find((v) => v.id === a.live);
  const inst = ws ? installs.find((i) => i.ws === ws && i.app === a.id) : undefined;
  const iv = inst && versions.find((v) => v.id === inst.version);
  const { developer_id: _d, live: _l, ...rest } = a;
  return {
    ...rest, version: live?.version ?? null, manifest: live?.manifest ?? null, installs: installs.filter((i) => i.app === a.id).length,
    installed: inst && iv ? { version: iv.version, manifest: iv.manifest, enabled: inst.enabled, installed_at: inst.installed_at, update_available: !!a.live && inst.version !== a.live } : null,
  };
}

const URL_OK = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{2,5})?(\/[^\s<>"]*)?$/;

/** Те же проверки манифеста, что на сервере (сокращённо). */
export function checkManifest(m: MarketManifest): string | null {
  if (!m || typeof m !== "object") return "Манифест — объект JSON.";
  if ((m.schema ?? 1) !== 1) return "Поддерживается только schema: 1.";
  if ((m.scopes ?? []).some((s) => s !== "crm.read")) return "Неизвестное право: доступно только crm.read.";
  if (m.webhooks) {
    if (!URL_OK.test(m.webhooks.url ?? "") || /^https:\/\/(localhost|[\d.]+)([:/]|$)/.test(m.webhooks.url)) return "webhooks.url — публичный адрес https.";
    const known = ["record.created", "record.updated", "record.deleted", "deal.stage_changed"];
    if (!m.webhooks.events?.length || m.webhooks.events.some((e) => !known.includes(e))) return `webhooks.events — из списка: ${known.join(", ")}.`;
  }
  if ((m.actions ?? []).length > 10) return "Не больше 10 действий.";
  for (const a of m.actions ?? []) {
    if (!/^[a-z0-9_-]{1,40}$/.test(a.id ?? "") || !a.label?.trim() || a.label.length > 40 || !["company", "contact", "crm_lead", "deal"].includes(a.entity) || !URL_OK.test(a.url ?? "")) {
      return "У действия нужны id, label (1–40), entity (company, contact, crm_lead, deal) и адрес https.";
    }
    if (a.url.includes("{title}") && !(m.scopes ?? []).includes("crm.read")) return "{title} в адресе требует права crm.read.";
    if (/[{}]/.test(a.url.replace(/\{(id|type|workspace_id|title)\}/g, ""))) return "В адресе можно только {id}, {type}, {workspace_id} и {title}.";
  }
  if (m.window && !URL_OK.test(m.window.url ?? "")) return "window.url — публичный адрес https.";
  return null;
}

export function marketCall(action: string, a: Record<string, unknown>, ctx: MarketCtx): unknown {
  if (!ctx.cloud) fail("Маркетплейс доступен в облачной учётной записи.", "cloudOnly");
  const needWs = () => ctx.wsId ?? fail("Интеграции устанавливаются в облачный Workspace: выберите общий Workspace.", "localWorkspace");
  const manage = () => { if (!ctx.perms.includes("workspace.manage")) fail("Устанавливать интеграции может владелец или администратор Workspace."); };
  const listed = (id: unknown) => apps.find((x) => x.id === id && x.status === "listed" && x.live) ?? fail("Интеграция не найдена.");
  const mod = () => { if (!ctx.moderator) fail("Нет прав модератора маркетплейса."); };
  switch (action) {
    case "market_catalog": {
      const q = String(a.query ?? "").trim().toLowerCase();
      return apps.filter((x) => x.status === "listed" && x.live && (!a.category || x.category === a.category)
        && (!q || `${x.name} ${x.tagline} ${x.developer_name}`.toLowerCase().includes(q)))
        .sort((x, y) => x.name.localeCompare(y.name)).map((x) => json(x, ctx.wsId));
    }
    case "market_installed": {
      if (!ctx.wsId) return [];
      return installs.filter((i) => i.ws === ctx.wsId && i.enabled).flatMap((i): MarketInstalled[] => {
        const app = apps.find((x) => x.id === i.app && x.status === "listed");
        const v = versions.find((x) => x.id === i.version);
        return app && v ? [{ app_id: app.id, name: app.name, icon: app.icon, actions: v.manifest.actions ?? [], scopes: v.manifest.scopes ?? [] }] : [];
      });
    }
    case "market_install": {
      const ws = needWs(); manage();
      const app = listed(a.app);
      const cur = installs.find((i) => i.ws === ws && i.app === app.id);
      if (cur) { cur.version = app.live!; cur.enabled = true; } else installs.push({ ws, app: app.id, version: app.live!, enabled: true, installed_at: iso() });
      return json(app, ws);
    }
    case "market_uninstall": {
      const ws = needWs(); manage();
      installs = installs.filter((i) => !(i.ws === ws && i.app === a.app));
      return null;
    }
    case "market_set_enabled": {
      const ws = needWs(); manage();
      const cur = installs.find((i) => i.ws === ws && i.app === a.app) ?? fail("Интеграция не установлена.");
      cur.enabled = Boolean(a.enabled);
      return null;
    }
    case "market_my_apps":
      return apps.filter((x) => x.developer_id === ctx.me).map((x) => ({
        ...json(x, null), status_note: x.status_note,
        versions: versions.filter((v) => v.app_id === x.id).sort((p, q) => q.created_at.localeCompare(p.created_at)).map(({ app_id: _a, ...v }) => v),
      }));
    case "market_submit": {
      const p = (a.app ?? {}) as { id?: string; slug?: string; name?: string; developer_name?: string; tagline?: string; description?: string;
        category?: string; icon?: string; website?: string; support_email?: string; version?: string; manifest: MarketManifest };
      const err = checkManifest(p.manifest);
      if (err) fail(err);
      if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(p.version ?? "")) fail("Версия — в виде 1.0.0.");
      const found = p.id ? apps.find((x) => x.id === p.id) : undefined;
      if (p.id && (!found || found.developer_id !== ctx.me)) fail("Интеграция не найдена.");
      if (found?.status === "suspended") fail("Интеграция снята модератором.");
      const version = p.version!;
      let app: App;
      if (!found) {
        if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(p.slug ?? "")) fail("Адрес интеграции: латиница, цифры и дефис, от 3 символов.");
        if (apps.some((x) => x.slug === p.slug)) fail("Такой адрес интеграции уже занят.");
        if (!p.name?.trim() || !p.developer_name?.trim()) fail("Укажите название и разработчика.");
        app = { id: nid(), slug: p.slug!, developer_id: ctx.me, developer_name: p.developer_name!, name: p.name!, tagline: p.tagline ?? "", description: p.description ?? "",
          category: (p.category as MarketCategory) ?? "other", icon: p.icon || "🧩", website: p.website || null, support_email: p.support_email || null,
          status: "draft", status_note: null, updated_at: iso(), live: null };
        apps.push(app);
      } else {
        app = found;
        Object.assign(app, { name: p.name || app.name, developer_name: p.developer_name || app.developer_name, tagline: p.tagline ?? app.tagline,
          description: p.description ?? app.description, category: p.category || app.category, icon: p.icon || app.icon,
          website: p.website || null, support_email: p.support_email || null, updated_at: iso() });
      }
      if (versions.some((v) => v.app_id === app.id && v.version === version)) fail("Такая версия уже подавалась: увеличьте номер.");
      versions.forEach((v) => { if (v.app_id === app.id && v.status === "pending") v.status = "superseded"; });
      versions.push({ id: nid(), app_id: app.id, version, manifest: p.manifest, status: "pending", review_note: null, created_at: iso() });
      return json(app, null);
    }
    case "market_is_moderator":
      return ctx.moderator;
    case "market_review_queue": {
      mod();
      return versions.filter((v) => v.status === "pending").map((v): MarketReview => {
        const app = apps.find((x) => x.id === v.app_id)!;
        return { version_id: v.id, version: v.version, manifest: v.manifest, created_at: v.created_at,
          live_manifest: versions.find((x) => x.id === app.live)?.manifest ?? null, developer_email: "dev@example.com", app: { ...json(app, null), status_note: app.status_note } };
      });
    }
    case "market_review": {
      mod();
      const v = versions.find((x) => x.id === a.version && x.status === "pending") ?? fail("Версия уже рассмотрена.");
      if (!a.approve && !String(a.note ?? "").trim()) fail("Напишите, почему версия отклонена.");
      v.status = a.approve ? "approved" : "rejected";
      v.review_note = String(a.note ?? "").trim() || null;
      if (a.approve) {
        versions.forEach((x) => { if (x.app_id === v.app_id && x.id !== v.id && x.status === "approved") x.status = "superseded"; });
        const app = apps.find((x) => x.id === v.app_id)!;
        app.live = v.id;
        if (app.status !== "suspended") app.status = "listed";
      }
      return null;
    }
    case "market_suspend": {
      mod();
      const app = apps.find((x) => x.id === a.app) ?? fail("Интеграция не найдена.");
      app.status = a.suspend ? "suspended" : app.live ? "listed" : "draft";
      app.status_note = String(a.note ?? "").trim() || null;
      return null;
    }
    default:
      return fail("Неизвестное действие маркетплейса.");
  }
}
