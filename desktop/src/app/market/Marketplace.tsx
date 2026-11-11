// «Маркетплейс»: каталог интеграций сторонних компаний, установленные в Workspace, подача своих интеграций
// и (для модераторов) проверка заявок. Окно — как «Настройки», но крупнее: каталогу нужно место.
// Интеграция работает по манифесту: кнопки в карточках CRM и события на сервер разработчика, без чужого кода.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import type { MarketApp, MarketCategory, MarketManifest, MarketReview, MarketSubmission } from "../../api/types";
import { checkManifest } from "../../api/marketMock";
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
  const titles: Record<MarketPage, string> = { catalog: "Каталог", installed: "Установленные", developer: "Для разработчиков", moderation: "Модерация" };
  const items: { id: MarketPage; icon: string; show: boolean }[] = [
    { id: "catalog", icon: "store", show: true },
    { id: "installed", icon: "check", show: true },
    { id: "developer", icon: "edit", show: true },
    { id: "moderation", icon: "shield", show: moderator },
  ];

  return createPortal(
    <div className="settings-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) closeMarket(); }}>
      <div className="settings market" role="dialog" aria-modal="true" aria-label="Маркетплейс">
        <nav className="settings-nav" aria-label="Разделы маркетплейса">
          <h3 className="settings-title">Маркетплейс</h3>
          <div className="settings-cat">
            {items.filter((x) => x.show).map((x) => (
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
                <EmptyState icon="store" title="Маркетплейс доступен в облачной учётной записи">Войдите в облачную учётную запись, чтобы устанавливать интеграции и публиковать свои.</EmptyState>
              ) : openApp ? (
                <AppPage id={openApp} onBack={() => setOpenApp(null)} onChanged={() => setVersion((v) => v + 1)} />
              ) : page === "catalog" ? (
                <Catalog key={`c-${version}`} category={category} onOpen={setOpenApp} />
              ) : page === "installed" ? (
                <Installed key={`i-${version}`} onOpen={setOpenApp} />
              ) : page === "developer" ? (
                <Developer />
              ) : (
                <Moderation />
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
          <h2>Интеграции для Customers</h2>
          <span className="faint">Телефония, документы, аналитика и мессенджеры от сторонних компаний. Каждая интеграция проверена модератором.</span>
        </div>
        <TextInput value={query} onChange={setQuery} icon="search" placeholder="Название, задача или разработчик" aria-label="Поиск интеграций" wrapClass="market-search" onClear={query ? () => setQuery("") : undefined} />
      </div>
      {error && <Notice tone="warn">{error}</Notice>}
      {apps === null ? <div className="center-fill"><Spinner /></div> : apps.length === 0 ? (
        <EmptyState icon="store" title={query || category ? "Ничего не нашлось" : "Пока пусто"}>{query || category ? "Измените запрос или категорию." : "Здесь появятся интеграции, когда разработчики их опубликуют."}</EmptyState>
      ) : (
        <ul className="market-grid" aria-label="Интеграции">
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
          {app.installed && <Tag tone="green" icon="check">Установлена</Tag>}
        </span>
        <span className="faint market-dev ellipsis">{app.developer_name} · {CATEGORY_TEXT[app.category]}</span>
        <span className="market-tagline">{app.tagline}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------- страница интеграции

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
        scopes.length ? `Интеграция получит: ${scopes.map((s) => SCOPE_TEXT[s] ?? s).join("; ")}.` : "Интеграция не получает поля записей: только их идентификаторы.",
        m.webhooks ? `События (${m.webhooks.events.map((e) => EVENT_TEXT[e] ?? e).join(", ").toLowerCase()}) уйдут на ${new URL(m.webhooks.url).host}.` : "",
      ].filter(Boolean).join(" "),
      confirm: inst ? "Обновить" : "Установить",
    });
    if (!ok) return;
    setBusy(true);
    const r = await attempt(() => api.wsMarket<MarketApp>("market_install", { app: app.id }));
    setBusy(false);
    if (r) { setApp(r); toast(inst ? "Интеграция обновлена." : "Интеграция установлена.", "success"); void refreshMarketInstalled(); onChanged(); }
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
          {!remote ? <Notice>Установка — в облачный Workspace.</Notice> : !inst ? (
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
          {remote && !manage && <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Устанавливает владелец или администратор Workspace</span>}
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

/** Что интеграция делает и к чему получает доступ — словами, без JSON. */
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
        {actions.length ? actions.map((a) => <div key={a.id}>{ENTITIES[a.entity].emoji} {a.label} <span className="faint">· {ENTITIES[a.entity].one.toLowerCase()}</span></div>) : <div className="faint">Нет</div>}
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
  if (!remote) return <EmptyState icon="store" title="Интеграции ставятся в облачный Workspace">Переключитесь на общий Workspace команды.</EmptyState>;
  const mine = (apps ?? []).filter((a) => a.installed);
  return (
    <div className="col" style={{ gap: 12, alignItems: "stretch" }}>
      {error && <Notice tone="warn">{error}</Notice>}
      {apps === null ? <div className="center-fill"><Spinner /></div> : mine.length === 0 ? (
        <EmptyState icon="store" title="Ничего не установлено">Выберите интеграцию в каталоге: её кнопки появятся в карточках CRM этого Workspace.</EmptyState>
      ) : (
        <ul className="market-grid" aria-label="Установленные интеграции">
          {mine.map((a) => (
            <li key={a.id}>
              <AppTile app={a} onOpen={() => onOpen(a.id)} />
              {(!a.installed!.enabled || a.installed!.update_available) && (
                <div className="row market-tile-note">{!a.installed!.enabled && <Tag>Выключена</Tag>}{a.installed!.update_available && <Tag tone="blue">Есть обновление</Tag>}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- для разработчиков

const STATUS_TEXT: Record<string, { text: string; tone: "gray" | "green" | "red" | "orange" | "blue" }> = {
  pending: { text: "На проверке", tone: "orange" },
  approved: { text: "Опубликована", tone: "green" },
  rejected: { text: "Отклонена", tone: "red" },
  superseded: { text: "Заменена", tone: "gray" },
};

const EXAMPLE: MarketManifest = {
  schema: 1,
  scopes: ["crm.read"],
  webhooks: { url: "https://example.com/customers/hook", events: ["record.created", "deal.stage_changed"] },
  actions: [{ id: "open", label: "Открыть в сервисе", entity: "company", url: "https://example.com/company/{id}?name={title}" }],
};

function Developer() {
  const [apps, setApps] = useState<MarketApp[] | null>(null);
  const [editing, setEditing] = useState<MarketApp | "new" | null>(null);
  const load = () => void api.wsMarket<MarketApp[]>("market_my_apps").then(setApps, () => setApps([]));
  useEffect(load, []);
  return (
    <div className="col" style={{ gap: 16, alignItems: "stretch" }}>
      <div className="market-hero">
        <div className="col" style={{ gap: 4 }}>
          <h2>Опубликуйте свою интеграцию</h2>
          <span className="faint">Опишите интеграцию и её манифест: кнопки в карточках и события, которые получит ваш сервер. Каждую версию проверяет модератор, обычно в течение рабочего дня.</span>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Новая интеграция</Button>
      </div>
      {apps === null ? <div className="center-fill"><Spinner /></div> : apps.length === 0 ? (
        <EmptyState icon="edit" title="У вас пока нет интеграций">Нажмите «Новая интеграция», заполните описание и отправьте на проверку.</EmptyState>
      ) : (
        <ul className="market-list" aria-label="Мои интеграции">
          {apps.map((a) => {
            const last = a.versions?.[0];
            return (
              <li key={a.id} className="market-row">
                <span className="market-icon" aria-hidden>{a.icon}</span>
                <span className="col grow" style={{ gap: 3, minWidth: 0 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="market-name ellipsis">{a.name}</span>
                    {a.status === "listed" && <Tag tone="green">В каталоге · {a.version}</Tag>}
                    {a.status === "suspended" && <Tag tone="red">Снята модератором</Tag>}
                    {last && last.status !== "approved" && <Tag tone={STATUS_TEXT[last.status]!.tone}>{last.version}: {STATUS_TEXT[last.status]!.text}</Tag>}
                  </span>
                  {last?.review_note && <span className="faint">Модератор: {last.review_note}</span>}
                  {a.status_note && <span className="faint">Модератор: {a.status_note}</span>}
                  <span className="faint">Установок: {a.installs}</span>
                </span>
                <Button small icon="upload" disabled={a.status === "suspended"} onClick={() => setEditing(a)}>Новая версия</Button>
              </li>
            );
          })}
        </ul>
      )}
      <section className="market-fact">
        <h4>Как устроена интеграция</h4>
        <div className="faint">Манифест описывает кнопки в карточках (ссылки с {"{id}"}, {"{type}"}, {"{workspace_id}"} и, при праве crm.read, {"{title}"}) и события. События приходят POST-запросом с заголовком X-Customers-Signature: sha256=HMAC тела по секрету установки. Секрет приходит в событии app.installed.</div>
      </section>
      {editing && <SubmitDialog app={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function bumpVersion(v: string | null | undefined): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "1.0.0";
}

function SubmitDialog({ app, onClose, onDone }: { app: MarketApp | null; onClose: () => void; onDone: () => void }) {
  const latest = app?.versions?.[0];
  const [f, setF] = useState<Omit<MarketSubmission, "manifest">>({
    id: app?.id, slug: app?.slug ?? "", name: app?.name ?? "", developer_name: app?.developer_name ?? "", tagline: app?.tagline ?? "",
    description: app?.description ?? "", category: app?.category ?? "other", icon: app?.icon ?? "🧩", website: app?.website ?? "",
    support_email: app?.support_email ?? "", version: bumpVersion(latest?.version),
  });
  const [manifest, setManifest] = useState(JSON.stringify(latest?.manifest ?? EXAMPLE, null, 2));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const parsed = useMemo((): { m: MarketManifest | null; error: string | null } => {
    try {
      const m = JSON.parse(manifest) as MarketManifest;
      return { m, error: checkManifest(m) };
    } catch {
      return { m: null, error: "Манифест — неверный JSON." };
    }
  }, [manifest]);
  const submit = async () => {
    if (!parsed.m || parsed.error) return;
    setBusy(true);
    const r = await attempt(() => api.wsMarket<MarketApp>("market_submit", { app: { ...f, manifest: parsed.m } }));
    setBusy(false);
    if (r) { toast("Отправлено на проверку. Результат появится здесь.", "success"); onDone(); }
  };
  return (
    <Dialog title={app ? `Новая версия: ${app.name}` : "Новая интеграция"} onClose={onClose} width={720} footer={
      <>
        <span className="grow faint">{parsed.error ?? "Манифест в порядке"}</span>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" icon="upload" busy={busy} disabled={!!parsed.error || !f.name.trim() || !f.developer_name.trim() || (!app && !f.slug.trim())} onClick={() => void submit()}>Отправить на проверку</Button>
      </>
    }>
      <div className="market-form">
        <Field label="Название"><TextInput aria-label="Название" value={f.name} onChange={(v) => set("name", v)} maxLength={60} autoFocus /></Field>
        <Field label="Адрес в каталоге" hint={app ? "Не меняется" : "Латиница, цифры и дефис"}><TextInput aria-label="Адрес в каталоге" value={f.slug} onChange={(v) => set("slug", v.toLowerCase())} maxLength={40} disabled={!!app} placeholder="my-integration" /></Field>
        <Field label="Разработчик"><TextInput aria-label="Разработчик" value={f.developer_name} onChange={(v) => set("developer_name", v)} maxLength={120} placeholder="ООО «Компания»" /></Field>
        <Field label="Категория"><Select aria-label="Категория" value={f.category} onChange={(v) => set("category", v)} options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_TEXT[c] ?? c }))} /></Field>
        <Field label="Значок" hint="Один эмодзи"><TextInput aria-label="Значок" value={f.icon} onChange={(v) => set("icon", v)} maxLength={8} /></Field>
        <Field label="Версия" hint={latest ? `Прошлая: ${latest.version}` : "Например, 1.0.0"}><TextInput aria-label="Версия" value={f.version} onChange={(v) => set("version", v)} maxLength={20} /></Field>
        <div className="wide"><Field label="Кратко"><TextInput aria-label="Кратко" value={f.tagline} onChange={(v) => set("tagline", v)} maxLength={140} placeholder="Что делает интеграция, в одной строке" /></Field></div>
        <div className="wide"><Field label="Описание"><TextArea aria-label="Описание" value={f.description} onChange={(v) => set("description", v)} maxLength={5000} rows={4} /></Field></div>
        <Field label="Сайт"><TextInput aria-label="Сайт" value={f.website} onChange={(v) => set("website", v)} placeholder="https://" /></Field>
        <Field label="Почта поддержки"><TextInput aria-label="Почта поддержки" value={f.support_email} onChange={(v) => set("support_email", v)} placeholder="support@" /></Field>
        <div className="wide"><Field label="Манифест (JSON)" hint="Права, события и кнопки в карточках. Поле window зарезервировано для будущих веб-плагинов.">
          <TextArea className="mono" value={manifest} onChange={setManifest} rows={12} aria-label="Манифест" />
        </Field></div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- модерация

function Moderation() {
  const [queue, setQueue] = useState<MarketReview[] | null>(null);
  const [rejecting, setRejecting] = useState<MarketReview | null>(null);
  const [suspend, setSuspend] = useState<MarketApp | null>(null);
  const { apps, reload } = useCatalog(null, "");
  const load = () => void api.wsMarket<MarketReview[]>("market_review_queue").then(setQueue, () => setQueue([]));
  useEffect(load, []);
  const approve = async (r: MarketReview) => {
    if (!(await confirmDialog({ title: `Опубликовать «${r.app.name}» ${r.version}?`, message: "Версия появится в каталоге. Уже установленные копии обновят владельцы Workspace.", confirm: "Опубликовать" }))) return;
    if ((await attempt(() => api.wsMarket("market_review", { version: r.version_id, approve: true }))) !== undefined) { load(); reload(); }
  };
  return (
    <div className="col" style={{ gap: 16, alignItems: "stretch" }}>
      <h3>Ждут проверки{queue ? ` · ${queue.length}` : ""}</h3>
      {queue === null ? <div className="center-fill"><Spinner /></div> : queue.length === 0 ? (
        <div className="faint">Заявок нет.</div>
      ) : (
        <ul className="market-list" aria-label="Заявки">
          {queue.map((r) => (
            <li key={r.version_id} className="market-review">
              <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                <span className="market-icon" aria-hidden>{r.app.icon}</span>
                <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
                  <span className="market-name">{r.app.name} <span className="faint">· {r.version}{r.live_manifest ? " (обновление)" : " (новая)"}</span></span>
                  <span className="faint">{r.app.developer_name}{r.developer_email ? ` · ${r.developer_email}` : ""} · {CATEGORY_TEXT[r.app.category]} · подана {dateOnly(r.created_at)}</span>
                  <span>{r.app.tagline}</span>
                </div>
                <Button small icon="x" onClick={() => setRejecting(r)}>Отклонить</Button>
                <Button small variant="primary" icon="check" onClick={() => void approve(r)}>Опубликовать</Button>
              </div>
              <div className="market-facts compact"><ManifestFacts m={r.manifest} /></div>
              {r.live_manifest && JSON.stringify(r.live_manifest.scopes ?? []) !== JSON.stringify(r.manifest.scopes ?? []) && (
                <Notice tone="warn">Права меняются: было «{(r.live_manifest.scopes ?? []).join(", ") || "нет"}», станет «{(r.manifest.scopes ?? []).join(", ") || "нет"}».</Notice>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3>Опубликованные</h3>
      {apps === null ? <Spinner /> : (
        <ul className="market-list" aria-label="Опубликованные интеграции">
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
      {suspend && <ReasonDialog title={`Снять «${suspend.name}» с каталога`} action="Снять" hint="Интеграция пропадёт из каталога, её кнопки и события остановятся во всех Workspace." onClose={() => setSuspend(null)}
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
