// «Коннекторы» (прежде «Интеграции» и «Маркетплейс»): каталог только из одобренных коннекторов сторонних компаний, установленные в Workspace,
// вкладка «На проверке» (заявки и проверка), «Для разработчиков» (проверка компании и подача коннекторов).
// Коннектор работает по манифесту: кнопки в карточках CRM и события на сервер разработчика, без чужого кода. Процесс — как у каталогов
// приложений Slack, Notion, Discord, ChatGPT: проверенная компания → описание и права → автоматическая проверка → модерация → каталог (ADR-083).

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import type { MarketApp, MarketCategory, MarketCompany, MarketCompanyReview, MarketManifest, MarketReview, MarketSubmission } from "../../api/types";
import { type Check, checkCompany, checkConnector, failedChecks } from "../../lib/connectors";
import { dateOnly } from "../../lib/format";
import { ENTITIES } from "../../lib/crm";
import { Button, EmptyState, Field, IconButton, Notice, Select, Spinner, Switch, Tag, TextArea, TextInput } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { Dialog, confirmDialog } from "../../ui/overlay";
import { attempt, toast, useStore, NONE } from "../../state/store";
import { CATEGORY_TEXT, EVENT_TEXT, SCOPE_TEXT, type MarketPage, closeMarket, openMarket, refreshMarketInstalled } from "../../state/market";
import { openLink } from "../../state/actions";

const CATEGORIES = Object.keys(CATEGORY_TEXT) as MarketCategory[];

export function Marketplace() {
  const page = useStore((s) => s.market);
  const cloud = useStore((s) => s.ws?.isCloud ?? false);
  const [moderator, setModerator] = useState(false);
  const [category, setCategory] = useState<MarketCategory | null>(null);
  const [openApp, setOpenApp] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!page || !cloud) return;
    void api.wsMarket<boolean>("market_is_moderator").then(setModerator, () => setModerator(false));
  }, [page, cloud]);
  useEffect(() => {
    if (!page) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector(".dialog")) closeMarket(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [page]);
  if (!page) return null;
  const go = (p: MarketPage, cat: MarketCategory | null = null) => { setOpenApp(null); setCategory(cat); openMarket(p); };
  const titles: Record<MarketPage, string> = { catalog: "Каталог", installed: "Установленные", review: "На проверке", developer: "Для разработчиков" };
  const items: { id: MarketPage; icon: string }[] = [
    { id: "catalog", icon: "store" },
    { id: "installed", icon: "check" },
    { id: "review", icon: "shield" },
    { id: "developer", icon: "edit" },
  ];

  return createPortal(
    <div className="settings-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) closeMarket(); }}>
      <div className="settings market" role="dialog" aria-modal="true" aria-label="Коннекторы">
        <nav className="settings-nav" aria-label="Разделы коннекторов">
          <h3 className="settings-title">Коннекторы</h3>
          <div className="settings-cat">
            {items.map((x) => (
              <div key={x.id} className="settings-item">
                <button type="button" className={`nav-item${page === x.id && !(x.id === "catalog" && category) ? " active" : ""}`} aria-current={page === x.id ? "page" : undefined} onClick={() => go(x.id)}>
                  <Icon name={x.icon} size={16} /><span className="grow ellipsis" style={{ textAlign: "left" }}>{titles[x.id]}</span>
                </button>
                {x.id === "catalog" && page === "catalog" && (
                  <div className="settings-subs" role="group" aria-label="Категории">
                    {CATEGORIES.map((c) => (
                      <button key={c} type="button" className={`nav-sub${category === c ? " active" : ""}`} aria-current={category === c ? "true" : undefined} onClick={() => go("catalog", category === c ? null : c)}>{CATEGORY_TEXT[c]}</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </nav>
        <div className="settings-main">
          <header className="settings-head">
            <h2>{titles[page]}{page === "catalog" && category && <span className="settings-crumb"> / {CATEGORY_TEXT[category]}</span>}</h2>
            <span className="grow" />
            <IconButton icon="x" tip="Закрыть (Esc)" onClick={closeMarket} />
          </header>
          <div className="settings-scroll">
            <div className="settings-content market-content">
              {!cloud ? (
                <EmptyState icon="store" title="Коннекторы доступны в облачной учётной записи">Войдите в облачную учётную запись, чтобы устанавливать коннекторы компаний и отправлять свои на проверку.</EmptyState>
              ) : openApp ? (
                <AppPage id={openApp} onBack={() => setOpenApp(null)} onChanged={() => setVersion((v) => v + 1)} />
              ) : page === "catalog" ? (
                <Catalog key={`c-${version}`} category={category} onOpen={setOpenApp} />
              ) : page === "installed" ? (
                <Installed key={`i-${version}`} onOpen={setOpenApp} />
              ) : page === "review" ? (
                <Review moderator={moderator} onGoDeveloper={() => go("developer")} />
              ) : (
                <Developer onGoReview={() => go("review")} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- каталог

function useCatalog(category: MarketCategory | null, query: string) {
  const [apps, setApps] = useState<MarketApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void api.wsMarket<MarketApp[]>("market_catalog", { query: query.trim() || null, category }).then(
        (a) => { if (live) { setApps(a); setError(null); } },
        (e: { message?: string }) => { if (live) { setApps([]); setError(e?.message ?? "Каталог не загрузился."); } });
    }, query ? 200 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [category, query, tick]);
  return { apps, error, reload: () => setTick((x) => x + 1) };
}

function Catalog({ category, onOpen }: { category: MarketCategory | null; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const { apps, error } = useCatalog(category, query);
  return (
    <div className="col" style={{ gap: 16, alignItems: "stretch" }}>
      <div className="market-hero">
        <div className="col" style={{ gap: 4 }}>
          <h2>Коннекторы для Customers</h2>
          <span className="faint">Подключения к сервисам от проверенных компаний. Каждый коннектор прошёл автоматическую проверку и модерацию; права и адреса видны до установки.</span>
        </div>
        <TextInput value={query} onChange={setQuery} icon="search" placeholder="Название, задача или разработчик" aria-label="Поиск коннекторов" wrapClass="market-search" onClear={query ? () => setQuery("") : undefined} />
      </div>
      {error && <Notice tone="warn">{error}</Notice>}
      {apps === null ? <div className="center-fill"><Spinner /></div> : apps.length === 0 ? (
        <EmptyState icon="store" title={query || category ? "Ничего не нашлось" : "Каталог пока пуст"}>{query || category ? "Измените запрос или категорию." : "Здесь появятся коннекторы, когда проверенные компании их опубликуют и модератор одобрит."}</EmptyState>
      ) : (
        <ul className="market-grid" aria-label="Коннекторы">
          {apps.map((a) => <li key={a.id}><AppTile app={a} onOpen={() => onOpen(a.id)} /></li>)}
        </ul>
      )}
    </div>
  );
}

function AppTile({ app, onOpen }: { app: MarketApp; onOpen: () => void }) {
  return (
    <button type="button" className="market-tile" onClick={onOpen}>
      <span className="market-icon" aria-hidden>{app.icon}</span>
      <span className="col grow" style={{ gap: 3, minWidth: 0 }}>
        <span className="row" style={{ gap: 6 }}>
          <span className="ellipsis market-name">{app.name}</span>
          {app.installed && <Tag tone="green" icon="check">Установлен</Tag>}
        </span>
        <span className="faint market-dev ellipsis">{app.developer_name} · {CATEGORY_TEXT[app.category]}</span>
        <span className="market-tagline">{app.tagline}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- страница коннектора

function AppPage({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const perms = useStore((s) => s.ws?.permissions ?? NONE);
  const remote = useStore((s) => s.ws?.workspaces.find((w) => w.id === s.ws?.active)?.remote ?? false);
  const wsName = useStore((s) => s.ws?.workspaces.find((w) => w.id === s.ws?.active)?.name ?? "");
  const [app, setApp] = useState<MarketApp | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const all = await attempt(() => api.wsMarket<MarketApp[]>("market_catalog", {}));
    setApp(all?.find((x) => x.id === id) ?? null);
  };
  useEffect(() => { void load(); }, [id]);
  if (!app) return <div className="center-fill"><Spinner /></div>;
  const manage = perms.includes("workspace.manage") && remote;
  const m = app.manifest ?? { schema: 1 };
  const inst = app.installed;

  const install = async () => {
    const scopes = m.scopes ?? [];
    const ok = await confirmDialog({
      title: inst ? `Обновить «${app.name}» до ${app.version}?` : `Установить «${app.name}» в «${wsName}»?`,
      message: [
        scopes.length ? `Коннектор получит: ${scopes.map((s) => SCOPE_TEXT[s] ?? s).join("; ")}.` : "Коннектор не получает поля записей: только их идентификаторы.",
        m.webhooks ? `События (${m.webhooks.events.map((e) => EVENT_TEXT[e] ?? e).join(", ").toLowerCase()}) уйдут на ${new URL(m.webhooks.url).host}.` : "",
      ].filter(Boolean).join(" "),
      confirm: inst ? "Обновить" : "Установить",
    });
    if (!ok) return;
    setBusy(true);
    const r = await attempt(() => api.wsMarket<MarketApp>("market_install", { app: app.id }));
    setBusy(false);
    if (r) { setApp(r); toast(inst ? "Коннектор обновлён." : "Коннектор установлен.", "success"); void refreshMarketInstalled(); onChanged(); }
  };
  const uninstall = async () => {
    if (!(await confirmDialog({ title: `Удалить «${app.name}»?`, message: "Кнопки пропадут из карточек, события перестанут отправляться. Разработчик получит уведомление об удалении.", confirm: "Удалить", danger: true }))) return;
    if ((await attempt(() => api.wsMarket("market_uninstall", { app: app.id }))) !== undefined) { void load(); void refreshMarketInstalled(); onChanged(); }
  };
  const toggle = async (enabled: boolean) => {
    if ((await attempt(() => api.wsMarket("market_set_enabled", { app: app.id, enabled }))) !== undefined) { void load(); void refreshMarketInstalled(); }
  };

  return (
    <div className="col market-app" style={{ gap: 18, alignItems: "stretch" }}>
      <div><Button small variant="ghost" icon="chevronLeft" onClick={onBack}>Назад</Button></div>
      <header className="market-app-head">
        <span className="market-icon big" aria-hidden>{app.icon}</span>
        <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
          <h1>{app.name}</h1>
          <span className="faint">{app.developer_name} · {CATEGORY_TEXT[app.category]} · версия {app.version}</span>
          <span>{app.tagline}</span>
        </div>
        <div className="col" style={{ gap: 8, alignItems: "flex-end" }}>
          {!remote ? <Notice>Установка — в облачное рабочее пространство.</Notice> : !inst ? (
            <Button variant="primary" icon="download" busy={busy} disabled={!manage} onClick={() => void install()}>Установить</Button>
          ) : (
            <>
              {inst.update_available && <Button variant="primary" icon="refresh" busy={busy} disabled={!manage} onClick={() => void install()}>Обновить до {app.version}</Button>}
              <div className="row" style={{ gap: 8 }}>
                <Switch checked={inst.enabled} onChange={(v) => void toggle(v)} disabled={!manage} label="Включена" />
                <Button icon="trash" disabled={!manage} onClick={() => void uninstall()}>Удалить</Button>
              </div>
            </>
          )}
          {remote && !manage && <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Устанавливает владелец или администратор рабочего пространства</span>}
        </div>
      </header>

      {app.description && <p className="market-desc selectable">{app.description}</p>}

      <div className="market-facts">
        <ManifestFacts m={inst && !inst.update_available ? inst.manifest : m} />
        <section className="market-fact">
          <h4>Разработчик</h4>
          <div className="col" style={{ gap: 6 }}>
            <span>{app.developer_name}</span>
            {app.website && <button type="button" className="link-btn" onClick={() => void openLink(app.website!)}>{new URL(app.website).host}</button>}
            {app.support_email && <button type="button" className="link-btn" onClick={() => void openLink(`mailto:${app.support_email}`)}>{app.support_email}</button>}
            <span className="faint">Установок: {app.installs} · обновлена {dateOnly(app.updated_at)}</span>
          </div>
        </section>
      </div>
      {inst?.update_available && <Notice>Новая версия {app.version} запрашивает такие права: {(m.scopes ?? []).length ? (m.scopes ?? []).map((s) => SCOPE_TEXT[s] ?? s).join("; ") : "без доступа к полям записей"}. Сейчас работает версия {inst.version}.</Notice>}
    </div>
  );
}

/** Что коннектор делает и к чему получает доступ — словами, без JSON. */
function ManifestFacts({ m }: { m: MarketManifest }) {
  const actions = m.actions ?? [];
  return (
    <>
      <section className="market-fact">
        <h4>Доступ к данным</h4>
        {(m.scopes ?? []).length ? (m.scopes ?? []).map((s) => <div key={s}><Icon name="eye" size={13} /> {SCOPE_TEXT[s] ?? s}</div>) : <div className="faint">Только идентификаторы записей, без их полей</div>}
      </section>
      <section className="market-fact">
        <h4>Кнопки в карточках</h4>
        {actions.length ? actions.map((a) => <div key={a.id}><Icon name={ENTITIES[a.entity].icon} size={13} /> {a.label} <span className="faint">· {ENTITIES[a.entity].one.toLowerCase()}</span></div>) : <div className="faint">Нет</div>}
      </section>
      <section className="market-fact">
        <h4>События</h4>
        {m.webhooks ? <>{m.webhooks.events.map((e) => <div key={e}>{EVENT_TEXT[e] ?? e}</div>)}<div className="faint">на {new URL(m.webhooks.url).host}, с подписью</div></> : <div className="faint">Не получает</div>}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- установленные

function Installed({ onOpen }: { onOpen: (id: string) => void }) {
  const remote = useStore((s) => s.ws?.workspaces.find((w) => w.id === s.ws?.active)?.remote ?? false);
  const { apps, error } = useCatalog(null, "");
  const mine = (apps ?? []).filter((a) => a.installed);
  return (
    <div className="col" style={{ gap: 12, alignItems: "stretch" }}>
      {error && <Notice tone="warn">{error}</Notice>}
      {!remote && <Notice>Коннекторы ставятся в облачное рабочее пространство: переключитесь на общее пространство команды.</Notice>}
      {remote && apps === null && <div className="center-fill"><Spinner /></div>}
      {apps !== null && mine.length === 0 && <EmptyState icon="store" title="Ничего не установлено">Выберите коннектор в каталоге.</EmptyState>}
      {mine.length > 0 && (
        <ul className="market-grid" aria-label="Установленные коннекторы">
          {mine.map((a) => (
            <li key={a.id}>
              <AppTile app={a} onOpen={() => onOpen(a.id)} />
              {(!a.installed!.enabled || a.installed!.update_available) && (
                <div className="row market-tile-note">{!a.installed!.enabled && <Tag>Выключен</Tag>}{a.installed!.update_available && <Tag tone="blue">Есть обновление</Tag>}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- проверка качества

function CheckList({ checks, label = "Автоматическая проверка" }: { checks: Check[]; label?: string }) {
  return (
    <ul className="check-list" aria-label={label}>
      {checks.map((c) => (
        <li key={c.id} className={`check check-${c.level}`}>
          <Icon name={c.level === "ok" ? "check" : c.level === "warn" ? "alert" : "x"} size={13} />
          <span className="check-label">{c.label}</span>
          {c.level !== "ok" && <span className="faint check-detail">{c.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

const checksOf = (app: MarketApp, manifest: MarketManifest, version: string): Check[] => checkConnector({
  slug: app.slug, name: app.name, tagline: app.tagline, description: app.description, icon: app.icon, website: app.website ?? "", support_email: app.support_email ?? "", version,
}, manifest);

function ChecksSummary({ checks }: { checks: Check[] }) {
  const bad = failedChecks(checks).length;
  const warn = checks.filter((c) => c.level === "warn").length;
  return <Tag tone={bad ? "red" : warn ? "orange" : "green"} icon={bad ? "x" : warn ? "alert" : "check"}>{bad ? `Замечаний: ${bad}` : warn ? `Автопроверка: предупреждений ${warn}` : "Автопроверка пройдена"}</Tag>;
}

// ---------------------------------------------------------------- черновики (на этом компьютере)

interface Draft { id: string; form: Omit<MarketSubmission, "manifest">; manifest: string; saved: string }
const DRAFTS_KEY = "customers.connectorDrafts";
function loadDrafts(): Draft[] {
  try { const v = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function storeDrafts(d: Draft[]) { try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(d.slice(0, 20))); } catch { /* без хранилища черновики не сохраняются */ } }

// ---------------------------------------------------------------- проверка компании

const COMPANY_TEXT: Record<MarketCompany["status"], { text: string; tone: "gray" | "green" | "red" | "orange" }> = {
  none: { text: "Не проверена", tone: "gray" },
  submitted: { text: "Заявка на проверке", tone: "orange" },
  verified: { text: "Проверена", tone: "green" },
  rejected: { text: "Проверка не пройдена", tone: "red" },
};

function useCompany() {
  const [company, setCompany] = useState<MarketCompany | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const load = () => void api.wsMarket<MarketCompany>("market_company").then((c) => { setCompany(c); setUnavailable(null); },
    (e: { message?: string }) => { setCompany(null); setUnavailable(e?.message ?? "Проверка компаний сейчас недоступна."); });
  useEffect(load, []);
  return { company, unavailable, reload: load };
}

function CompanyDialog({ initial, onClose, onDone }: { initial: MarketCompany; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ legal_name: initial.legal_name, country: initial.country, reg_number: initial.reg_number, website: initial.website, contact_name: initial.contact_name, contact_email: initial.contact_email, privacy_url: initial.privacy_url });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const checks = useMemo(() => checkCompany(f), [f]);
  const bad = failedChecks(checks);
  const submit = async () => {
    setBusy(true);
    const r = await attempt(() => api.wsMarket<MarketCompany>("market_company_save", { company: f }));
    setBusy(false);
    if (r) { toast("Заявка на проверку компании отправлена.", "success"); onDone(); }
  };
  return (
    <Dialog title="Проверка компании" onClose={onClose} width={720} footer={
      <>
        <span className="grow faint">{bad[0]?.detail ?? "Данные в порядке"}</span>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" icon="upload" busy={busy} disabled={bad.length > 0} onClick={() => void submit()}>Отправить на проверку</Button>
      </>
    }>
      <div className="col" style={{ gap: 12, alignItems: "stretch" }}>
        <Notice>Коннекторы могут отправлять только проверенные компании и ИП. Модератор сверяет данные с открытыми реестрами и сайтом; домен рабочей почты должен совпадать с доменом сайта.</Notice>
        <div className="market-form">
          <div className="wide"><Field label="Юридическое название"><TextInput aria-label="Юридическое название" value={f.legal_name} onChange={(v) => set("legal_name", v)} maxLength={160} placeholder="ООО «Компания»" autoFocus /></Field></div>
          <Field label="Страна регистрации"><TextInput aria-label="Страна регистрации" value={f.country} onChange={(v) => set("country", v)} maxLength={60} /></Field>
          <Field label="Регистрационный номер" hint="ИНН, ОГРН или номер из реестра страны"><TextInput aria-label="Регистрационный номер" value={f.reg_number} onChange={(v) => set("reg_number", v)} maxLength={20} /></Field>
          <Field label="Сайт компании"><TextInput aria-label="Сайт компании" value={f.website} onChange={(v) => set("website", v)} placeholder="https://" /></Field>
          <Field label="Политика конфиденциальности" hint="Страница на вашем сайте"><TextInput aria-label="Политика конфиденциальности" value={f.privacy_url} onChange={(v) => set("privacy_url", v)} placeholder="https://" /></Field>
          <Field label="Контактное лицо"><TextInput aria-label="Контактное лицо" value={f.contact_name} onChange={(v) => set("contact_name", v)} maxLength={80} /></Field>
          <Field label="Рабочая почта" hint="На домене компании"><TextInput aria-label="Рабочая почта" value={f.contact_email} onChange={(v) => set("contact_email", v)} placeholder="name@company.com" /></Field>
        </div>
        <CheckList checks={checks} label="Проверка данных компании" />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- для разработчиков

const STATUS_TEXT: Record<string, { text: string; tone: "gray" | "green" | "red" | "orange" | "blue" }> = {
  draft: { text: "Черновик", tone: "gray" },
  pending: { text: "Отправлена на проверку", tone: "orange" },
  approved: { text: "Одобрена", tone: "green" },
  rejected: { text: "Отклонена", tone: "red" },
  superseded: { text: "Заменена", tone: "gray" },
};

const EXAMPLE: MarketManifest = {
  schema: 1,
  scopes: ["crm.read"],
  webhooks: { url: "https://example.com/customers/hook", events: ["record.created", "deal.stage_changed"] },
  actions: [{ id: "open", label: "Открыть в сервисе", entity: "company", url: "https://example.com/company/{id}?name={title}" }],
};

function Developer({ onGoReview }: { onGoReview: () => void }) {
  const { company, unavailable, reload } = useCompany();
  const [apps, setApps] = useState<MarketApp[] | null>(null);
  const [editing, setEditing] = useState<MarketApp | "new" | null>(null);
  const [verifying, setVerifying] = useState(false);
  const load = () => void api.wsMarket<MarketApp[]>("market_my_apps").then(setApps, () => setApps([]));
  useEffect(load, []);
  const verified = company?.status === "verified";
  const st = company ? COMPANY_TEXT[company.status] : null;
  return (
    <div className="col" style={{ gap: 16, alignItems: "stretch" }}>
      <div className="market-hero">
        <div className="col" style={{ gap: 4 }}>
          <h2>Опубликуйте свой коннектор</h2>
          <span className="faint">Путь такой же, как в каталогах Slack, Notion или Discord: проверка компании, описание и манифест с правами, автоматическая проверка качества, затем модератор. Каждую версию проверяют отдельно.</span>
        </div>
        <Button variant="primary" icon="plus" disabled={!verified} onClick={() => setEditing("new")}>Новый коннектор</Button>
      </div>
      <section className="market-fact" aria-label="Проверка компании">
        <h4>1. Проверка компании</h4>
        {unavailable ? <Notice tone="warn">{unavailable}</Notice> : !company ? <Spinner /> : (
          <div className="col" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="market-name">{company.legal_name || "Компания не указана"}</span>
              {st && <Tag tone={st.tone} icon={company.status === "verified" ? "check" : undefined}>{st.text}</Tag>}
            </div>
            {company.status === "verified" && <span className="faint">Можно отправлять коннекторы на проверку.</span>}
            {company.status === "submitted" && <span className="faint">Модератор рассмотрит заявку, обычно в течение рабочего дня. Статус виден на вкладке «На проверке».</span>}
            {company.status === "rejected" && <span className="faint">Модератор: {company.note}</span>}
            {company.status === "none" && <span className="faint">Пока компания не проверена, отправить коннектор нельзя.</span>}
            {(company.status === "none" || company.status === "rejected") && <div><Button icon="shield" onClick={() => setVerifying(true)}>{company.status === "none" ? "Пройти проверку компании" : "Подать заявку снова"}</Button></div>}
            {company.status === "submitted" && <div><Button variant="ghost" onClick={onGoReview}>Открыть «На проверке»</Button></div>}
          </div>
        )}
      </section>
      <h3>2. Мои коннекторы</h3>
      {apps === null ? <div className="center-fill"><Spinner /></div> : apps.length === 0 ? (
        <EmptyState icon="edit" title="У вас пока нет коннекторов">{verified ? "Нажмите «Новый коннектор», заполните описание и отправьте на проверку." : "Сначала пройдите проверку компании."}</EmptyState>
      ) : (
        <ul className="market-list" aria-label="Мои коннекторы">
          {apps.map((a) => {
            const last = a.versions?.[0];
            return (
              <li key={a.id} className="market-row">
                <span className="market-icon" aria-hidden>{a.icon}</span>
                <span className="col grow" style={{ gap: 3, minWidth: 0 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="market-name ellipsis">{a.name}</span>
                    {a.status === "listed" && <Tag tone="green">В каталоге · {a.version}</Tag>}
                    {a.status === "suspended" && <Tag tone="red">Снят модератором</Tag>}
                    {last && last.status !== "approved" && last.status !== "superseded" && <Tag tone={STATUS_TEXT[last.status]!.tone}>{last.version}: {STATUS_TEXT[last.status]!.text}</Tag>}
                  </span>
                  {last?.review_note && <span className="faint">Модератор: {last.review_note}</span>}
                  {a.status_note && <span className="faint">Модератор: {a.status_note}</span>}
                  <span className="faint">Установок: {a.installs}</span>
                </span>
                <Button small icon="upload" disabled={a.status === "suspended" || !verified} onClick={() => setEditing(a)}>Новая версия</Button>
              </li>
            );
          })}
        </ul>
      )}
      <section className="market-fact">
        <h4>Как устроен коннектор</h4>
        <div className="faint">Манифест описывает кнопки в карточках (ссылки с {"{id}"}, {"{type}"}, {"{workspace_id}"} и, при праве crm.read, {"{title}"}) и события. События приходят POST-запросом с заголовком X-Customers-Signature: sha256=HMAC тела по секрету установки. Секрет приходит в событии app.installed.</div>
      </section>
      {verifying && company && <CompanyDialog initial={company} onClose={() => setVerifying(false)} onDone={() => { setVerifying(false); reload(); }} />}
      {editing && company && <SubmitDialog app={editing === "new" ? null : editing} company={company} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function bumpVersion(v: string | null | undefined): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "1.0.0";
}

export function SubmitDialog({ app, company, draft, onClose, onDone }: { app: MarketApp | null; company: MarketCompany; draft?: Draft; onClose: () => void; onDone: () => void }) {
  const latest = app?.versions?.[0];
  const [f, setF] = useState<Omit<MarketSubmission, "manifest">>(draft?.form ?? {
    id: app?.id, slug: app?.slug ?? "", name: app?.name ?? "", developer_name: company.legal_name, tagline: app?.tagline ?? "",
    description: app?.description ?? "", category: app?.category ?? "other", icon: app?.icon ?? "🧩", website: app?.website ?? company.website,
    support_email: app?.support_email ?? company.contact_email, version: bumpVersion(latest?.version),
  });
  const [manifest, setManifest] = useState(draft?.manifest ?? JSON.stringify(latest?.manifest ?? EXAMPLE, null, 2));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const parsed = useMemo((): { m: MarketManifest | null; checks: Check[] } => {
    let m: MarketManifest | null = null;
    try { m = JSON.parse(manifest) as MarketManifest; } catch { /* ниже — замечание */ }
    const checks = m ? checkConnector(f, m) : [{ id: "json", label: "Манифест", level: "fail" as const, detail: "Манифест — неверный JSON." }, ...checkConnector(f, null).filter((c) => c.id !== "manifest")];
    return { m, checks };
  }, [manifest, f]);
  const bad = failedChecks(parsed.checks);
  const submit = async () => {
    if (!parsed.m || bad.length) return;
    setBusy(true);
    const r = await attempt(() => api.wsMarket<MarketApp>("market_submit", { app: { ...f, manifest: parsed.m } }));
    setBusy(false);
    if (r) {
      if (draft) storeDrafts(loadDrafts().filter((d) => d.id !== draft.id));
      toast("Отправлено на проверку. Результат появится на вкладке «На проверке».", "success");
      onDone();
    }
  };
  const saveDraft = () => {
    const d: Draft = { id: draft?.id ?? `d${Date.now()}`, form: f, manifest, saved: new Date().toISOString() };
    storeDrafts([d, ...loadDrafts().filter((x) => x.id !== d.id)]);
    toast("Черновик сохранён на этом компьютере.", "success");
    onClose();
  };
  return (
    <Dialog title={app ? `Новая версия: ${app.name}` : "Новый коннектор"} onClose={onClose} width={760} footer={
      <>
        <span className="grow faint">{bad.length ? `Замечаний: ${bad.length}. ${bad[0]!.detail}` : "Автоматическая проверка пройдена"}</span>
        {!app && <Button variant="ghost" onClick={saveDraft}>Сохранить черновик</Button>}
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" icon="upload" busy={busy} disabled={bad.length > 0} onClick={() => void submit()}>Отправить на проверку</Button>
      </>
    }>
      <div className="market-form">
        <div className="wide"><Notice>Компания «{company.legal_name}» проверена. Версию рассмотрит модератор после автоматической проверки.</Notice></div>
        <Field label="Название"><TextInput aria-label="Название" value={f.name} onChange={(v) => set("name", v)} maxLength={60} autoFocus /></Field>
        <Field label="Адрес в каталоге" hint={app ? "Не меняется" : "Латиница, цифры и дефис"}><TextInput aria-label="Адрес в каталоге" value={f.slug} onChange={(v) => set("slug", v.toLowerCase())} maxLength={40} disabled={!!app} placeholder="my-connector" /></Field>
        <Field label="Разработчик" hint="Из проверенной компании"><TextInput aria-label="Разработчик" value={f.developer_name} onChange={(v) => set("developer_name", v)} maxLength={160} disabled /></Field>
        <Field label="Категория"><Select aria-label="Категория" value={f.category} onChange={(v) => set("category", v)} options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_TEXT[c] ?? c }))} /></Field>
        <Field label="Значок" hint="Один эмодзи"><TextInput aria-label="Значок" value={f.icon} onChange={(v) => set("icon", v)} maxLength={8} /></Field>
        <Field label="Версия" hint={latest ? `Прошлая: ${latest.version}` : "Например, 1.0.0"}><TextInput aria-label="Версия" value={f.version} onChange={(v) => set("version", v)} maxLength={20} /></Field>
        <div className="wide"><Field label="Кратко"><TextInput aria-label="Кратко" value={f.tagline} onChange={(v) => set("tagline", v)} maxLength={140} placeholder="Что делает коннектор, в одной строке" /></Field></div>
        <div className="wide"><Field label="Описание"><TextArea aria-label="Описание" value={f.description} onChange={(v) => set("description", v)} maxLength={5000} rows={4} /></Field></div>
        <Field label="Сайт"><TextInput aria-label="Сайт" value={f.website} onChange={(v) => set("website", v)} placeholder="https://" /></Field>
        <Field label="Почта поддержки"><TextInput aria-label="Почта поддержки" value={f.support_email} onChange={(v) => set("support_email", v)} placeholder="support@" /></Field>
        <div className="wide"><Field label="Манифест (JSON)" hint="Права, события и кнопки в карточках. Поле window зарезервировано для будущих веб-плагинов.">
          <TextArea className="mono" value={manifest} onChange={setManifest} rows={10} aria-label="Манифест" />
        </Field></div>
        <div className="wide"><CheckList checks={parsed.checks} /></div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- на проверке

function Review({ moderator, onGoDeveloper }: { moderator: boolean; onGoDeveloper: () => void }) {
  const { company } = useCompany();
  const [mine, setMine] = useState<MarketApp[] | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>(loadDrafts);
  const [resume, setResume] = useState<Draft | null>(null);
  const load = () => void api.wsMarket<MarketApp[]>("market_my_apps").then(setMine, () => setMine([]));
  useEffect(load, []);
  const rows = (mine ?? []).flatMap((a) => (a.versions ?? []).filter((v) => v.status === "pending" || v.status === "rejected").map((v) => ({ a, v })));
  return (
    <div className="col" style={{ gap: 16, alignItems: "stretch" }}>
      <div className="market-hero">
        <div className="col" style={{ gap: 4 }}>
          <h2>Заявки на проверку</h2>
          <span className="faint">Состояния заявки: черновик → отправлена → одобрена или отклонена. Одобренные версии попадают в каталог.</span>
        </div>
      </div>
      {company && company.status !== "verified" && (
        <Notice tone={company.status === "rejected" ? "warn" : "info"}>
          Компания: {COMPANY_TEXT[company.status].text.toLowerCase()}. {company.status === "submitted" ? "Коннекторы можно отправить после проверки." : <button type="button" className="link-btn" onClick={onGoDeveloper}>Перейти к проверке компании</button>}
        </Notice>
      )}
      <h3>Мои заявки</h3>
      {mine === null ? <div className="center-fill"><Spinner /></div> : rows.length === 0 && drafts.length === 0 ? (
        <div className="faint">Заявок нет. Новый коннектор отправляется на вкладке «Для разработчиков».</div>
      ) : (
        <ul className="market-list" aria-label="Мои заявки">
          {drafts.map((d) => (
            <li key={d.id} className="market-row">
              <span className="market-icon" aria-hidden>{d.form.icon}</span>
              <span className="col grow" style={{ gap: 3, minWidth: 0 }}>
                <span className="row" style={{ gap: 6 }}><span className="market-name ellipsis">{d.form.name || "Без названия"}</span><Tag>{d.form.version}: Черновик</Tag></span>
                <span className="faint">Сохранён на этом компьютере {dateOnly(d.saved)}</span>
              </span>
              {company?.status === "verified" && <Button small onClick={() => setResume(d)}>Продолжить</Button>}
              <Button small variant="ghost" icon="trash" aria-label={`Удалить черновик ${d.form.name}`} onClick={() => { const next = drafts.filter((x) => x.id !== d.id); storeDrafts(next); setDrafts(next); }} />
            </li>
          ))}
          {rows.map(({ a, v }) => (
            <li key={v.id} className="market-review">
              <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                <span className="market-icon" aria-hidden>{a.icon}</span>
                <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
                  <span className="row" style={{ gap: 6 }}><span className="market-name">{a.name}</span><Tag tone={STATUS_TEXT[v.status]!.tone}>{v.version}: {STATUS_TEXT[v.status]!.text}</Tag><ChecksSummary checks={checksOf(a, v.manifest, v.version)} /></span>
                  <span className="faint">Подана {dateOnly(v.created_at)}</span>
                  {v.review_note && <span>Модератор: {v.review_note}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {moderator && <ModerationQueues />}
      {resume && company && <SubmitDialog app={null} company={company} draft={resume} onClose={() => setResume(null)} onDone={() => { setResume(null); setDrafts(loadDrafts()); load(); }} />}
    </div>
  );
}

function ModerationQueues() {
  const [queue, setQueue] = useState<MarketReview[] | null>(null);
  const [companies, setCompanies] = useState<MarketCompanyReview[] | null>(null);
  const [rejecting, setRejecting] = useState<MarketReview | null>(null);
  const [rejectingCompany, setRejectingCompany] = useState<MarketCompanyReview | null>(null);
  const [suspend, setSuspend] = useState<MarketApp | null>(null);
  const { apps, reload } = useCatalog(null, "");
  const load = () => {
    void api.wsMarket<MarketReview[]>("market_review_queue").then(setQueue, () => setQueue([]));
    void api.wsMarket<MarketCompanyReview[]>("market_company_queue").then(setCompanies, () => setCompanies([]));
  };
  useEffect(load, []);
  const approve = async (r: MarketReview) => {
    if (!(await confirmDialog({ title: `Опубликовать «${r.app.name}» ${r.version}?`, message: "Версия появится в каталоге. Уже установленные копии обновят владельцы рабочего пространства.", confirm: "Опубликовать" }))) return;
    if ((await attempt(() => api.wsMarket("market_review", { version: r.version_id, approve: true }))) !== undefined) { load(); reload(); }
  };
  const approveCompany = async (r: MarketCompanyReview) => {
    if (!(await confirmDialog({ title: `Подтвердить компанию «${r.company.legal_name}»?`, message: "Она сможет отправлять коннекторы на проверку. Убедитесь, что данные совпадают с реестром и сайтом.", confirm: "Подтвердить" }))) return;
    if ((await attempt(() => api.wsMarket("market_company_review", { user: r.user_id, approve: true }))) !== undefined) load();
  };
  return (
    <div className="col" style={{ gap: 16, alignItems: "stretch" }}>
      <h3>Модерация: компании{companies ? ` · ${companies.length}` : ""}</h3>
      {companies === null ? <Spinner /> : companies.length === 0 ? <div className="faint">Заявок компаний нет.</div> : (
        <ul className="market-list" aria-label="Заявки компаний">
          {companies.map((r) => (
            <li key={r.user_id} className="market-review">
              <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
                  <span className="market-name">{r.company.legal_name}</span>
                  <span className="faint">{r.company.country} · № {r.company.reg_number} · {r.company.contact_name}, {r.company.contact_email}</span>
                  <span className="faint">{r.company.website} · {r.company.privacy_url}</span>
                </div>
                <Button small icon="x" onClick={() => setRejectingCompany(r)}>Отклонить</Button>
                <Button small variant="primary" icon="check" aria-label={`Подтвердить компанию ${r.company.legal_name}`} onClick={() => void approveCompany(r)}>Подтвердить</Button>
              </div>
              <CheckList checks={checkCompany(r.company)} label="Проверка данных компании" />
            </li>
          ))}
        </ul>
      )}
      <h3>Модерация: коннекторы{queue ? ` · ${queue.length}` : ""}</h3>
      {queue === null ? <Spinner /> : queue.length === 0 ? <div className="faint">Заявок нет.</div> : (
        <ul className="market-list" aria-label="Заявки">
          {queue.map((r) => {
            const checks = checksOf(r.app, r.manifest, r.version);
            const blocked = failedChecks(checks).length > 0;
            return (
              <li key={r.version_id} className="market-review">
                <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                  <span className="market-icon" aria-hidden>{r.app.icon}</span>
                  <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
                    <span className="market-name">{r.app.name} <span className="faint">· {r.version}{r.live_manifest ? " (обновление)" : " (новая)"}</span></span>
                    <span className="faint">{r.app.developer_name}{r.developer_email ? ` · ${r.developer_email}` : ""} · {CATEGORY_TEXT[r.app.category]} · подана {dateOnly(r.created_at)}</span>
                    <span>{r.app.tagline}</span>
                  </div>
                  <Button small icon="x" onClick={() => setRejecting(r)}>Отклонить</Button>
                  <Button small variant="primary" icon="check" disabled={blocked} onClick={() => void approve(r)}>Опубликовать</Button>
                </div>
                <div className="market-facts compact"><ManifestFacts m={r.manifest} /></div>
                <CheckList checks={checks} />
                {r.live_manifest && JSON.stringify(r.live_manifest.scopes ?? []) !== JSON.stringify(r.manifest.scopes ?? []) && (
                  <Notice tone="warn">Права меняются: было «{(r.live_manifest.scopes ?? []).join(", ") || "нет"}», станет «{(r.manifest.scopes ?? []).join(", ") || "нет"}».</Notice>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <h3>Опубликованные</h3>
      {apps === null ? <Spinner /> : (
        <ul className="market-list" aria-label="Опубликованные коннекторы">
          {apps.map((a) => (
            <li key={a.id} className="market-row">
              <span className="market-icon" aria-hidden>{a.icon}</span>
              <span className="col grow" style={{ gap: 2, minWidth: 0 }}><span className="market-name">{a.name}</span><span className="faint">{a.developer_name} · установок: {a.installs}</span></span>
              <Button small icon="ban" onClick={() => setSuspend(a)}>Снять с каталога</Button>
            </li>
          ))}
        </ul>
      )}
      {rejecting && <ReasonDialog title={`Отклонить «${rejecting.app.name}» ${rejecting.version}`} action="Отклонить" onClose={() => setRejecting(null)}
        onSubmit={async (note) => { if ((await attempt(() => api.wsMarket("market_review", { version: rejecting.version_id, approve: false, note }))) !== undefined) { setRejecting(null); load(); } }} />}
      {rejectingCompany && <ReasonDialog title={`Отклонить компанию «${rejectingCompany.company.legal_name}»`} action="Отклонить" onClose={() => setRejectingCompany(null)}
        onSubmit={async (note) => { if ((await attempt(() => api.wsMarket("market_company_review", { user: rejectingCompany.user_id, approve: false, note }))) !== undefined) { setRejectingCompany(null); load(); } }} />}
      {suspend && <ReasonDialog title={`Снять «${suspend.name}» с каталога`} action="Снять" hint="Коннектор пропадёт из каталога, его кнопки и события остановятся во всех рабочих пространствах." onClose={() => setSuspend(null)}
        onSubmit={async (note) => { if ((await attempt(() => api.wsMarket("market_suspend", { app: suspend.id, suspend: true, note }))) !== undefined) { setSuspend(null); reload(); } }} />}
    </div>
  );
}

function ReasonDialog({ title, action, hint, onClose, onSubmit }: { title: string; action: string; hint?: string; onClose: () => void; onSubmit: (note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={title} onClose={onClose} width={480} footer={
      <>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" busy={busy} disabled={!note.trim()} onClick={async () => { setBusy(true); await onSubmit(note.trim()); setBusy(false); }}>{action}</Button>
      </>
    }>
      <Field label="Причина" hint={hint ?? "Разработчик увидит её в своём кабинете."}><TextArea aria-label="Причина" value={note} onChange={setNote} rows={4} maxLength={1000} autoFocus /></Field>
    </Dialog>
  );
}
