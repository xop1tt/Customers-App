// Встроенные интеграции каталога: карточки, страница интеграции и настройка. Работают без облачной учётной записи.
// Мессенджеры настраиваются здесь (адрес вебхука или токен — в защищённом хранилище), Notion, Битрикс24, вебхук и диски — готовыми панелями.

import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { CrmState, DrivesState } from "../../api/types";
import { HUB_APPS, HUB_EVENTS, type HubApp, type HubEvent, type HubId, hubApp, isConfigured, isMessenger } from "../../lib/hub";
import { dateOnly } from "../../lib/format";
import { Button, Checkbox, Field, Notice, PasswordInput, Switch, Tag, TextInput } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { confirmDialog } from "../../ui/overlay";
import { attempt, toast } from "../../state/store";
import { useEvent } from "../../state/hooks";
import { openLink } from "../../state/actions";
import { removeIntegration, saveIntegration, useHub } from "../../state/hub";
import { CATEGORY_TEXT } from "../../state/market";
import { Connect, type CrmKind } from "../panels/CrmPanel";
import { DrivesPanel } from "../panels/DrivesPanel";

// ------------------------------------------------------------------ логотипы

/** Упрощённые знаки сервисов на плитке фирменного цвета. Простые фигуры, без копий товарных знаков. */
export function HubLogo({ app, size = 42 }: { app: HubApp; size?: number }) {
  const g = (() => {
    switch (app.id) {
      case "slack": return <g strokeLinecap="round" strokeWidth="3.2" fill="none"><path d="M9 14h8" stroke="#36C5F0" /><path d="M14 9v8" stroke="#2EB67D" /><path d="M20 14h8" stroke="#ECB22E" /><path d="M25 9v8" stroke="#E01E5A" /><path d="M9 22h8" stroke="#2EB67D" /><path d="M14 20v8" stroke="#36C5F0" /><path d="M20 22h8" stroke="#E01E5A" /><path d="M25 20v8" stroke="#ECB22E" /></g>;
      case "telegram": return <path d="M7 18.5 29 9.5l-4 19-7-5-3.5 3.5-.8-6L26 12l-12.5 8.5L7 18.5Z" fill="#fff" />;
      case "discord": return <path d="M10 12c3-1.6 6-2 8-2s5 .4 8 2c2 3.5 3 7 3 11-2 1.7-4 2.6-6 3l-1.4-2.4c1-.3 1.8-.8 2.4-1.4-3.4 1.4-8.6 1.4-12 0 .6.6 1.4 1.100 2.400 1.400L13 26c-2-.4-4-1.300-6-3 0-4 1-7.500 3-11Z" fill="#fff" />;
      case "teams": return <><rect x="8" y="12" width="14" height="14" rx="2.5" fill="#fff" /><path d="M12.500 16h5M15 16v7" stroke={app.color} strokeWidth="2" strokeLinecap="round" /><circle cx="26" cy="13" r="3" fill="#fff" opacity=".85" /><rect x="23" y="17" width="7" height="8" rx="3" fill="#fff" opacity=".85" /></>;
      case "notion": return <><rect x="9" y="8" width="20" height="22" rx="2.500" fill="#fff" /><path d="M14 25V14l10 11V14" stroke="#191919" strokeWidth="2.200" strokeLinecap="round" strokeLinejoin="round" fill="none" /></>;
      case "bitrix": return <><circle cx="19" cy="19" r="10" fill="none" stroke="#fff" strokeWidth="3" /><path d="M14.500 19.500l3 3 6-6.500" stroke="#fff" strokeWidth="2.600" strokeLinecap="round" strokeLinejoin="round" fill="none" /></>;
      case "webhook": return <g fill="none" stroke="#fff" strokeWidth="2.600" strokeLinecap="round"><circle cx="12" cy="24" r="3.500" /><circle cx="26" cy="24" r="3.500" /><circle cx="19" cy="12" r="3.500" /><path d="M17 15l-4 6M21 15l4 6M15.500 24h7" /></g>;
      default: return <path d="M12 26a6 6 0 0 1-.6-12A8 8 0 0 1 27 15a5.500 5.500 0 0 1-1 11H12Z" fill="#fff" />;
    }
  })();
  return (
    <span className="market-icon hub-logo" aria-hidden style={{ background: app.color, width: size, height: size, borderRadius: size / 4.2, borderColor: "transparent" }}>
      <svg viewBox="0 0 38 38" width={size * 0.8} height={size * 0.8}>{g}</svg>
    </span>
  );
}

// ------------------------------------------------------------------ состояние

export type HubStatus = "none" | "setup" | "on" | "off";

/** Состояние каждой интеграции: нет, установлена без настройки, работает, выключена. */
export function useHubStatus(): Record<HubId, HubStatus> {
  const { integrations } = useHub();
  const [crm, setCrm] = useState<CrmState | null>(null);
  const [drives, setDrives] = useState<DrivesState | null>(null);
  const load = useCallback(() => { void api.crmState().then(setCrm).catch(() => {}); void api.drivesState().then(setDrives).catch(() => {}); }, []);
  useEffect(load, [load]);
  useEvent("crm-changed", load);
  const out = {} as Record<HubId, HubStatus>;
  for (const a of HUB_APPS) {
    if (a.setup === "messenger") {
      const v = integrations[a.id];
      out[a.id] = !v ? "none" : !isConfigured(a, v) ? "setup" : v.enabled ? "on" : "off";
    } else if (a.setup === "crm") out[a.id] = crm?.[a.id as CrmKind]?.connected ? "on" : "none";
    else out[a.id] = drives?.drives.some((d) => d.connected) ? "on" : "none";
  }
  return out;
}

const STATUS_TAG: Record<HubStatus, { text: string; tone: "green" | "orange" | "gray" } | null> = {
  none: null, setup: { text: "Нужна настройка", tone: "orange" }, on: { text: "Установлена", tone: "green" }, off: { text: "Выключена", tone: "gray" },
};

/** Установка мессенджера: показывает, что именно будет уходить наружу. Остальные ставятся на странице интеграции. */
export async function installMessenger(app: HubApp): Promise<boolean> {
  const ok = await confirmDialog({
    title: `Установить «${app.name}»?`,
    message: `${app.sends}. Это произойдёт только после того, как вы введёте свои данные доступа и включите события. ${app.needs.join(". ")}.`,
    confirm: "Установить",
  });
  if (!ok) return false;
  return saveIntegration(app.id, { enabled: true, installedAt: new Date().toISOString(), events: HUB_EVENTS.map((e) => e.id) });
}

// ------------------------------------------------------------------ карточки

export function HubTile({ app, status, onOpen }: { app: HubApp; status: HubStatus; onOpen: () => void }) {
  const tag = STATUS_TAG[status];
  const install = async () => {
    if (isMessenger(app.id) && status === "none" && !(await installMessenger(app))) return;
    onOpen();
  };
  return (
    <div className="market-tile hub-tile">
      <button type="button" className="hub-tile-main" onClick={onOpen} aria-label={`${app.name}: подробнее`}>
        <HubLogo app={app} />
        <span className="col grow" style={{ gap: 3, minWidth: 0 }}>
          <span className="row" style={{ gap: 6 }}>
            <span className="ellipsis market-name">{app.name}</span>
            {tag && <Tag tone={tag.tone} icon={status === "on" ? "check" : undefined}>{tag.text}</Tag>}
          </span>
          <span className="faint market-dev ellipsis">{app.developer} · {CATEGORY_TEXT[app.category]}</span>
          <span className="market-tagline">{app.tagline}</span>
        </span>
      </button>
      <div className="hub-tile-foot">
        {status === "none" ? <Button small variant="primary" icon="download" onClick={() => void install()} aria-label={`Установить ${app.name}`}>Установить</Button>
          : <Button small onClick={onOpen} aria-label={`Настроить ${app.name}`}>{status === "setup" ? "Настроить" : "Открыть"}</Button>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ страница

export function HubPage({ id, onBack }: { id: string; onBack: () => void }) {
  const app = hubApp(id);
  const status = useHubStatus();
  if (!app) return null;
  const st = status[app.id];
  const install = async () => { if (isMessenger(app.id)) await installMessenger(app); };
  const uninstall = async () => {
    if (!(await confirmDialog({ title: `Удалить «${app.name}»?`, message: "Данные доступа будут удалены с этого устройства. Уже отправленные сообщения останутся у сервиса.", confirm: "Удалить", danger: true }))) return;
    if (isMessenger(app.id)) await removeIntegration(app.id);
    else if (app.setup === "crm") await attempt(() => api.disconnectCrm(app.id));
  };
  const tag = STATUS_TAG[st];
  return (
    <div className="col market-app" style={{ gap: 18, alignItems: "stretch" }}>
      <div><Button small variant="ghost" icon="chevronLeft" onClick={onBack}>Назад</Button></div>
      <header className="market-app-head">
        <HubLogo app={app} size={72} />
        <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
          <h1>{app.name}</h1>
          <span className="faint">{app.developer} · {CATEGORY_TEXT[app.category]} · версия {app.version}</span>
          <span>{app.tagline}</span>
        </div>
        <div className="col" style={{ gap: 8, alignItems: "flex-end" }}>
          {tag && <Tag tone={tag.tone} icon={st === "on" ? "check" : undefined}>{tag.text}</Tag>}
          {st === "none" && isMessenger(app.id) && <Button variant="primary" icon="download" onClick={() => void install()}>Установить</Button>}
          {st !== "none" && app.setup !== "drives" && <Button icon="trash" onClick={() => void uninstall()}>Удалить</Button>}
        </div>
      </header>
      <p className="market-desc selectable">{app.description}</p>
      <div className="market-facts">
        <section className="market-fact"><h4>Что добавляет</h4>{app.adds.map((x) => <div key={x}><Icon name="check" size={13} /> {x}</div>)}</section>
        <section className="market-fact"><h4>Что понадобится от вас</h4>{app.needs.map((x) => <div key={x}><Icon name="eye" size={13} /> {x}</div>)}</section>
        <section className="market-fact"><h4>Куда уходят данные</h4><div>{app.sends}</div><div className="faint">Ключи и адреса хранятся в защищённом хранилище системы и не покидают компьютер.</div></section>
        <section className="market-fact"><h4>О версии</h4><div>Версия {app.version}</div><div className="faint">Обновлена {dateOnly(app.updated)}</div><div className="faint">Входит в приложение, без облака и платы</div></section>
      </div>
      <section className="col" style={{ gap: 8 }}>
        <h3>Как подключить</h3>
        <ol className="hub-steps">{app.steps.map((x) => <li key={x}>{x}</li>)}</ol>
        {app.consoleUrl && <div><Button small icon="external" onClick={() => void openLink(app.consoleUrl!)}>Открыть страницу сервиса</Button></div>}
      </section>
      <section className="col" style={{ gap: 10 }}>
        <h3>Настройка</h3>
        {app.setup === "messenger" ? (st === "none" ? <Notice>Нажмите «Установить», чтобы ввести данные доступа.</Notice> : <MessengerSetup app={app} />)
          : app.setup === "crm" ? <CrmSetup kind={app.id as CrmKind} />
          : <DrivesPanel />}
      </section>
    </div>
  );
}

function CrmSetup({ kind }: { kind: CrmKind }) {
  const [crm, setCrm] = useState<CrmState | null>(null);
  const load = useCallback(() => { void api.crmState().then(setCrm).catch(() => {}); }, []);
  useEffect(load, [load]);
  useEvent("crm-changed", load);
  if (!crm) return null;
  const info = crm[kind];
  return info.connected
    ? <Notice tone="ok">Подключено{kind === "notion" && crm.notion.title ? `: ${crm.notion.title}` : info.connected && "target" in info && info.target ? `: ${info.target}` : ""}. Лиды отправляются командой «Экспорт» в списках.</Notice>
    : <div className="crm-form"><Connect kind={kind} onDone={load} /></div>;
}

function MessengerSetup({ app }: { app: HubApp }) {
  const { integrations } = useHub();
  const saved = integrations[app.id]!;
  const [form, setForm] = useState({ webhook: saved.webhook ?? "", token: saved.token ?? "", chat: saved.chat ?? "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm({ webhook: saved.webhook ?? "", token: saved.token ?? "", chat: saved.chat ?? "" }), [saved.webhook, saved.token, saved.chat]);
  const filled = isConfigured(app, form);
  const dirty = form.webhook !== (saved.webhook ?? "") || form.token !== (saved.token ?? "") || form.chat !== (saved.chat ?? "");
  const cfg = () => Object.fromEntries(app.fields.map((f) => [f.key, form[f.key].trim()]));
  const test = async () => {
    setBusy(true);
    const r = await attempt(() => api.hubSend(app.id, "Customers: проверка связи. Если вы видите это сообщение, интеграция настроена.", cfg()));
    setBusy(false);
    if (r) toast(`${app.name}: ${r}`, "success");
  };
  const save = async () => { if (await saveIntegration(app.id, { ...cfg() })) toast("Настройки сохранены.", "success"); };
  const toggleEvent = (e: HubEvent, on: boolean) => void saveIntegration(app.id, { events: on ? [...new Set([...saved.events, e])] : saved.events.filter((x) => x !== e) });
  return (
    <div className="col" style={{ gap: 12, alignItems: "stretch", maxWidth: 620 }}>
      {app.fields.map((f) => (
        <Field key={f.key} label={f.label}>
          {f.secret
            ? <PasswordInput value={form[f.key]} onChange={(v) => setForm((s) => ({ ...s, [f.key]: v }))} placeholder={f.placeholder} aria-label={f.label} />
            : <TextInput value={form[f.key]} onChange={(v) => setForm((s) => ({ ...s, [f.key]: v }))} placeholder={f.placeholder} aria-label={f.label} />}
        </Field>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <Button icon="send" busy={busy} disabled={!filled} onClick={() => void test()}>Проверить</Button>
        <Button variant="primary" disabled={!filled || !dirty} onClick={() => void save()}>Сохранить</Button>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <h4 style={{ margin: 0 }}>О чём сообщать</h4>
        {HUB_EVENTS.map((e) => <Checkbox key={e.id} checked={saved.events.includes(e.id)} onChange={(v) => toggleEvent(e.id, v)} label={`${e.title} — ${e.hint}`} />)}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <Switch checked={saved.enabled} onChange={(v) => void saveIntegration(app.id, { enabled: v })} label="Включена" />
        <span>{saved.enabled ? "Включена" : "Выключена: сообщения не отправляются"}</span>
      </div>
    </div>
  );
}
