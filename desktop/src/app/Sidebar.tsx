import { useRef, useState } from "react";
import { count, type SectionId, SECTIONS } from "../lib/leads";
import { integer } from "../lib/format";
import { CONFIGURABLE, MAIN_GROUP, WORK_GROUP, move, ordered, toggled } from "../lib/sidebarPrefs";
import { SOURCES } from "../lib/sources";
import appIcon from "../assets/app-icon.png";
import { Avatar, Button, IconButton } from "../ui/kit";
import { api } from "../api";
import { Icon } from "../ui/icons";
import { type MenuItem, Popover, showMenu } from "../ui/overlay";
import type { SyncStatus, UpdateInfo } from "../api/types";
import { attempt, leaveSession, openDebug, openScore, openSettings, openSource, patchDevice, setSection, setState, useStore } from "../state/store";
import { openLink } from "../state/actions";

const SCORE_STEPS = [90, 70, 50, 30];

/** Кнопка «Обновить» нужна, пока есть найденная или скачанная версия. Проверка и ошибка не должны её прятать. */
export function updateVisible(u: UpdateInfo | null): boolean {
  if (!u || u.phase === "upToDate") return false;
  if (["available", "downloading", "ready", "installing"].includes(u.phase)) return true;
  return !!(u.available || u.stagedVersion);
}

/** Облачко рядом с именем: показывает, что сейчас с синхронизацией. */
export function syncView(s: SyncStatus | null): { tone: "ok" | "sync" | "pending" | "offline" | "failed"; icon: string; label: string } | null {
  if (!s?.enabled) return null;
  if (s.kind === "syncing") return { tone: "sync", icon: "refresh", label: "Синхронизация…" };
  if (s.kind === "offline") return { tone: "offline", icon: "cloudOff", label: "Потеряно соединение с облаком" };
  if (s.kind === "failed") return { tone: "failed", icon: "cloudAlert", label: s.message ? `Не синхронизировано: ${s.message}` : "Не синхронизировано" };
  if (s.pending > 0) return { tone: "pending", icon: "cloudAlert", label: "Не синхронизировано: изменения ждут отправки" };
  return { tone: "ok", icon: "cloudCheck", label: "Синхронизировано" };
}

function SyncBadge({ sync }: { sync: SyncStatus | null }) {
  const v = syncView(sync);
  if (!v) return null;
  return (
    <span className={`sync-badge ${v.tone}`} role="img" aria-label={v.label} data-tip={v.label}>
      <Icon name={v.icon} size={15} />
    </span>
  );
}

function NavItem({ id, active, badge, onClick }: { id: SectionId; active: boolean; badge?: number; onClick: () => void }) {
  const meta = SECTIONS[id];
  return (
    <button type="button" className={`nav-item${active ? " active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined}>
      <Icon name={meta.icon} size={16} />
      <span className="ellipsis grow">{meta.title}</span>
      {badge !== undefined && badge > 0 && <span className={`nav-count${id === "new" ? " accent" : ""} num`}>{integer(badge)}</span>}
    </button>
  );
}

export function Sidebar({ overlay }: { overlay?: boolean }) {
  const section = useStore((s) => s.section);
  const leads = useStore((s) => s.snap.leads);
  const device = useStore((s) => s.device);
  const session = useStore((s) => s.session);
  const sync = useStore((s) => s.sync);
  const update = useStore((s) => s.update);
  const customize = useStore((s) => s.customizeNav);
  const sourceFilter = useStore((s) => s.filter.source);
  const minScore = useStore((s) => s.filter.minScore);
  const beta = useStore((s) => s.boot?.channel === "beta");
  const accountBtn = useRef<HTMLButtonElement>(null);
  const [accountRect, setAccountRect] = useState<DOMRect | null>(null);

  const countOf = (id: SectionId) => (device.sidebarCounts && id !== "home" && id !== "sources" && id !== "runs" ? count(leads, id, true) : undefined);
  const visible = (id: string) => customize || !device.sidebarHidden.includes(id);

  const main = ordered(MAIN_GROUP, device.sidebarOrder).filter(visible) as SectionId[];
  const work = ordered(WORK_GROUP, device.sidebarOrder).filter(visible) as SectionId[];

  const perSource = new Map<string, number>();
  for (const l of leads) if (!l.archived && !l.excluded) perSource.set(l.data.source, (perSource.get(l.data.source) ?? 0) + 1);
  const sourceKeys = ordered(SOURCES.map((s) => s.key), device.sidebarSourceOrder).filter((k) => customize || !device.sidebarHiddenSources.includes(k));

  const perScore = new Map<number, number>();
  for (const n of SCORE_STEPS) perScore.set(n, leads.filter((l) => !l.archived && !l.excluded && l.data.score >= n).length);

  const helpItems = (): MenuItem[] => [
    { label: "Что нового", icon: "sparkles", onSelect: () => setState({ whatsNewOpen: true }) },
    { label: "Страница релизов", icon: "external", onSelect: () => void openLink(update?.releasesPage ?? "https://github.com/xop1tt/CLIENTS/releases") },
    { label: "Сообщить о проблеме", icon: "report", onSelect: () => setState({ reportOpen: true }) },
  ];

  const updateReady = updateVisible(update);

  /** Перетаскивание строк в режиме настройки панели. */
  const [drag, setDrag] = useState<{ group: string; from: number; over: number } | null>(null);
  const reorder = (group: readonly string[], key: "sidebarOrder" | "sidebarSourceOrder", from: number, to: number) => {
    const next = move(group, from, to);
    const base = key === "sidebarOrder" ? device.sidebarOrder : device.sidebarSourceOrder;
    const others = base.filter((x) => !group.includes(x));
    void patchDevice({ [key]: [...others, ...next] });
  };

  const row = (id: string, idx: number, list: readonly string[], key: "sidebarOrder" | "sidebarSourceOrder", content: React.ReactNode, hiddenKey: "sidebarHidden" | "sidebarHiddenSources", locked = false) => {
    const hidden = device[hiddenKey].includes(id);
    return (
      <div
        key={id}
        className={`nav-edit${hidden ? " off" : ""}${drag?.group === key && drag.over === idx ? " drop" : ""}`}
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDrag({ group: key, from: idx, over: idx }); }}
        onDragOver={(e) => { e.preventDefault(); if (drag?.group === key && drag.over !== idx) setDrag({ ...drag, over: idx }); }}
        onDrop={(e) => { e.preventDefault(); if (drag?.group === key) reorder(list, key, drag.from, drag.over); setDrag(null); }}
        onDragEnd={() => setDrag(null)}
      >
        <span className="nav-grip" data-tip="Перетащить"><Icon name="grip" size={14} /></span>
        <span className="row grow nav-edit-label">{content}</span>
        <IconButton
          icon={hidden ? "eyeOff" : "eye"}
          tip={locked ? "Этот раздел нельзя скрыть" : hidden ? "Показать" : "Скрыть"}
          disabled={locked}
          onClick={() => void patchDevice({ [hiddenKey]: toggled(device[hiddenKey], id, hidden) })}
        />
      </div>
    );
  };

  const groupFor = (items: SectionId[], list: readonly string[]) =>
    items.map((id, i) =>
      customize
        ? row(id, i, list, "sidebarOrder", <><Icon name={SECTIONS[id].icon} size={16} /><span className="ellipsis">{SECTIONS[id].title}</span></>, "sidebarHidden", !(CONFIGURABLE as readonly string[]).includes(id))
        : <NavItem key={id} id={id} active={section === id && !(id === "all" && (sourceFilter || minScore > 0))} badge={countOf(id)} onClick={() => setSection(id)} />,
    );

  return (
    <aside className={`sidebar${overlay ? " overlay" : ""}`} style={{ width: "var(--nav-w)" }} aria-label="Навигация">
      <div className="side-head">
        <span className="side-brand grow"><img src={appIcon} width={20} height={20} alt="" draggable={false} />Customers{beta && <span className="channel-badge" data-tip="Отдельная версия для проверки: свои данные и настройки">Beta</span>}</span>
        <IconButton icon="sidebar" tip="Свернуть панель" onClick={() => (overlay ? setState({ navPeek: false }) : void patchDevice({ navOpen: false }))} />
      </div>

      <nav className="side-scroll">
        <div className="nav-group">{groupFor(main, MAIN_GROUP)}</div>

        {(device.sidebarSources || customize) && (
          <div className="nav-group">
            <div className="nav-title">По источнику</div>
            {sourceKeys.map((key, i) => {
              const meta = SOURCES.find((s) => s.key === key);
              if (!meta) return null;
              const n = perSource.get(key) ?? 0;
              if (customize) return row(key, i, SOURCES.map((s) => s.key), "sidebarSourceOrder", <><Icon name={meta.icon} size={16} /><span className="ellipsis">{meta.title}</span></>, "sidebarHiddenSources");
              return (
                <button key={key} type="button" className={`nav-item${section === "all" && sourceFilter === key ? " active" : ""}`} onClick={() => openSource(key)}>
                  <Icon name={meta.icon} size={16} />
                  <span className="ellipsis grow">{meta.title}</span>
                  {device.sidebarCounts && n > 0 && <span className="nav-count num">{integer(n)}</span>}
                </button>
              );
            })}
          </div>
        )}

        {!customize && (
          <div className="nav-group">
            <div className="nav-title">По оценке</div>
            {SCORE_STEPS.map((n) => (
              <button key={n} type="button" className={`nav-item${section === "all" && !sourceFilter && minScore === n ? " active" : ""}`} onClick={() => openScore(n)}>
                <Icon name="star" size={16} />
                <span className="ellipsis grow">Оценка {n}+</span>
                {device.sidebarCounts && <span className="nav-count num">{integer(perScore.get(n) ?? 0)}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="nav-group">
          <div className="nav-title">Работа</div>
          {groupFor(work, WORK_GROUP)}
        </div>

        {customize && (
          <div className="nav-group nav-opts">
            <label className="nav-opt"><span className="grow">Числа у разделов</span><SwitchMini on={device.sidebarCounts} onChange={(v) => void patchDevice({ sidebarCounts: v })} /></label>
            <label className="nav-opt"><span className="grow">Список источников</span><SwitchMini on={device.sidebarSources} onChange={(v) => void patchDevice({ sidebarSources: v })} /></label>
            <label className="nav-opt"><span className="grow">Показ при наведении</span><SwitchMini on={device.sidebarHover} onChange={(v) => void patchDevice({ sidebarHover: v })} /></label>
          </div>
        )}
      </nav>

      <div className="side-foot">
        {customize ? (
          <Button variant="primary" icon="check" onClick={() => setState({ customizeNav: false })}>Готово</Button>
        ) : (
          <>
            {updateReady && <UpdateButton />}
            <button type="button" className="nav-item" onClick={() => setState({ customizeNav: true })}><Icon name="edit" size={16} /><span>Настроить панель</span></button>
          </>
        )}
        <div className="row side-account-row">
          <button ref={accountBtn} type="button" className="account-btn" onClick={() => setAccountRect(accountBtn.current?.getBoundingClientRect() ?? null)} aria-haspopup="menu" aria-label="Учётная запись">
            <Avatar name={session?.displayName ?? "?"} src={session?.avatar} size={28} />
            <span className="side-name-row grow">
              <span className="ellipsis side-name">{session?.displayName}</span>
              {session?.isCloud && <SyncBadge sync={sync} />}
            </span>
          </button>
          <IconButton icon="help" tip="Справка" onClick={(e) => showMenu(helpItems(), e.currentTarget.getBoundingClientRect(), "top-start")} />
        </div>
      </div>
      {accountRect && (
        <Popover anchor={accountRect} onClose={() => setAccountRect(null)} ignore={accountBtn.current} minWidth={Math.max(accountRect.width, 220)} className="popover-menu" placement="top-start">
          <ul className="menu">
            <li><button className="menu-item" onClick={() => { setAccountRect(null); openSettings("appearance"); }}><span className="menu-icon"><Icon name="settings" size={14} /></span>Настройки</button></li>
            <li><button className="menu-item" onClick={() => { setAccountRect(null); openSettings("account"); }}><span className="menu-icon"><Icon name="user" size={14} /></span>Аккаунт и синхронизация</button></li>
            <li><button className="menu-item" onClick={() => { setAccountRect(null); openSettings("data"); }}><span className="menu-icon"><Icon name="database" size={14} /></span>Данные и копии</button></li>
            {beta && <li><button className="menu-item" onClick={() => { setAccountRect(null); openDebug(true); }}><span className="menu-icon"><Icon name="settings" size={14} /></span>Debug Menu</button></li>}
            <li className="menu-sep" />
            <li><button className="menu-item danger" onClick={() => { setAccountRect(null); void leaveSession(); }}><span className="menu-icon"><Icon name="logout" size={14} /></span>Выйти</button></li>
          </ul>
        </Popover>
      )}
    </aside>
  );
}

function SwitchMini({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`switch${on ? " on" : ""}`} onClick={() => onChange(!on)}>
      <span className="switch-knob" />
    </button>
  );
}

/** Единственное, что показывается о новой версии: кнопка рядом с учётной записью. Без всплывающих сообщений. */
function UpdateButton() {
  const update = useStore((s) => s.update);
  if (!update) return null;
  const busy = update.phase === "downloading" || update.phase === "installing";
  const click = () => {
    if (!update.canUpdate) return void openLink(update.releasesPage);
    if (update.phase === "ready" || (update.stagedVersion && update.phase !== "checking")) void attempt(() => api.installUpdate());
    else if (update.phase === "available" || update.phase === "failed" || update.phase === "checking") void attempt(() => api.prepareUpdate());
  };
  const tip = update.phase === "failed" ? `Не удалось скачать. Нажмите, чтобы повторить` : update.available ? `Версия ${update.available.version}` : "Обновить приложение";
  return (
    <button type="button" className="update-btn" disabled={busy} onClick={click} data-tip={tip} aria-label={`Обновить. ${tip}`}>
      <Icon name={busy ? "refresh" : "download"} size={14} className={busy ? "pulse" : undefined} />
      <span>{busy ? "Загрузка…" : "Обновить"}</span>
    </button>
  );
}
