import { can } from "../lib/crm";
import { useRef, useState } from "react";
import { count, type SectionId, SECTIONS } from "../lib/leads";
import { useNewSince } from "../state/hooks";
import { integer } from "../lib/format";
import { CONFIGURABLE, MAIN_GROUP, WORK_GROUP, move, ordered, toggled } from "../lib/sidebarPrefs";
import { SOURCES } from "../lib/sources";
import { MODULES, moduleOf } from "../lib/modules";
import { Avatar, Button, IconButton } from "../ui/kit";
import { api } from "../api";
import { Icon } from "../ui/icons";
import { type MenuItem, Popover, showMenu } from "../ui/overlay";
import type { SyncStatus, UpdateInfo } from "../api/types";
import { attempt, leaveSession, openCollection, openProfile, openScore, openSettings, openSource, patchDevice, setSection, setState, useStore } from "../state/store";
import { CollectionsGroup } from "./crm/Collections";
import { openLink } from "../state/actions";
import { GroupTitle, useCollapsed } from "./SideGroup";
import { unreadNotifications, unreadTotal } from "../state/team";
import { openMarket } from "../state/market";

const SCORE_STEPS = [90, 70, 50, 30];

/** Кнопка «Обновить» появляется, когда обновление уже загружено и его можно установить. Пока оно скачивается, её нет. */
export function updateVisible(u: UpdateInfo | null): boolean {
  if (!u || u.phase === "upToDate") return false;
  if (u.phase === "ready" || u.phase === "installing") return true;
  return !!u.stagedVersion && u.phase !== "downloading";
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
  const since = useNewSince();
  const device = useStore((s) => s.device);
  const session = useStore((s) => s.session);
  const sync = useStore((s) => s.sync);
  const update = useStore((s) => s.update);
  const customizeFlag = useStore((s) => s.customizeNav);
  const sourceFilter = useStore((s) => s.filter.source);
  const minScore = useStore((s) => s.filter.minScore);
  const sourcesShut = useCollapsed("sources");
  const scoresShut = useCollapsed("scores");
  const workShut = useCollapsed("work");
  const teamShut = useCollapsed("team");
  const chat = useStore((s) => s.chat);
  const hasWs = useStore((s) => !!s.ws?.active);
  const perms = useStore((s) => s.ws?.permissions);
  const wsName = useStore((s) => s.ws?.workspaces.find((w) => w.id === s.ws?.active)?.name ?? null);
  // Панель разделов показывает группы открытого модуля рейки; в режиме настройки — все настраиваемые группы.
  const mod = moduleOf(section);
  // «Настроить панель» у каждой вкладки своя: настраивается только то, что показано в открытой вкладке.
  const canCustomize = mod === "search" || mod === "crm";
  const customize = customizeFlag && canCustomize;
  const showSearch = mod === "search";
  const showCrm = mod === "crm";
  const showTeam = !customize && (mod === "team" || mod === "messages");
  const incoming = useStore((s) => s.incoming.length);
  const accountBtn = useRef<HTMLButtonElement>(null);
  const [accountRect, setAccountRect] = useState<DOMRect | null>(null);

  const countOf = (id: SectionId) => (device.sidebarCounts && id !== "home" && id !== "sources" && id !== "runs" ? count(leads, id, true, since) : undefined);
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
    { label: "Страница релизов", icon: "external", onSelect: () => void openLink(update?.releasesPage ?? "https://github.com/xop1tt/Customers-App/releases") },
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
        <span className="side-brand side-module grow">{customize ? `Настройка: ${MODULES.find((m) => m.id === mod)!.title}` : MODULES.find((m) => m.id === mod)!.title}</span>
      </div>

      {mod === "crm" && !customize && wsName && (
        <div className="side-ws">
          <button type="button" className="ws-switch grow" onClick={() => setState({ workspaceOpen: true })} aria-haspopup="dialog" aria-label={`Рабочее пространство: ${wsName}`} data-tip="Управление рабочим пространством">
            <Avatar name={wsName} size={26} />
            <span className="col grow" style={{ gap: 0, minWidth: 0, textAlign: "left" }}>
              <span className="ellipsis ws-switch-name">{wsName}</span>
              <span className="ellipsis faint ws-switch-sub">Рабочее пространство</span>
            </span>
            <Icon name="chevronLeft" size={14} className="faint" />
          </button>
        </div>
      )}

      <nav className="side-scroll">
        {showSearch && <div className="nav-group">{groupFor(main, MAIN_GROUP)}</div>}

        {session && !customize && hasWs && mod === "crm" && (
          <div className="nav-group">
            {((["today", "calendar", "deals", "reports", "trash"] as SectionId[]).concat(can(perms ?? [], "audit") ? ["journal"] : [])).map((id) => <NavItem key={id} id={id} active={section === id} onClick={() => setSection(id)} />)}
          </div>
        )}

        {showCrm && <CollectionsGroup customize={customize} onOpen={openCollection} />}

        {showSearch && (device.sidebarSources || customize) && (
          <div className="nav-group">
            <GroupTitle id="sources" title="По источнику" />
            {sourceKeys.map((key, i) => {
              const meta = SOURCES.find((s) => s.key === key);
              if (!meta) return null;
              // В свёрнутой группе остаётся только открытый сейчас пункт.
              if (sourcesShut && !(section === "all" && sourceFilter === key)) return null;
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

        {!customize && mod === "search" && (
          <div className="nav-group">
            <GroupTitle id="scores" title="По оценке" />
            {SCORE_STEPS.filter((n) => !scoresShut || (section === "all" && !sourceFilter && minScore === n)).map((n) => (
              <button key={n} type="button" className={`nav-item${section === "all" && !sourceFilter && minScore === n ? " active" : ""}`} onClick={() => openScore(n)}>
                <Icon name="star" size={16} />
                <span className="ellipsis grow">Оценка {n}+</span>
                {device.sidebarCounts && <span className="nav-count num">{integer(perScore.get(n) ?? 0)}</span>}
              </button>
            ))}
          </div>
        )}

        {showTeam && (
          <div className="nav-group">
            {mod === "team" && <GroupTitle id="team" title="Команда" />}
            {((mod === "messages" ? ["chat"] : ["people", "notifications"]) as ("chat" | "people" | "notifications")[]).filter((id) => mod === "messages" || !teamShut || section === id || (id === "people" && section === "profile")).map((id) => {
              const n = id === "chat" ? unreadTotal(chat) : id === "notifications" ? unreadNotifications(chat) : 0;
              const active = section === id || (id === "people" && section === "profile");
              return (
                <button key={id} type="button" className={`nav-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined} onClick={() => setSection(id)}>
                  <Icon name={SECTIONS[id].icon} size={16} />
                  <span className="ellipsis grow">{SECTIONS[id].title}</span>
                  {n > 0 && <span className="nav-count accent num" aria-label={`Непрочитанных: ${n}`}>{integer(n)}</span>}
                </button>
              );
            })}
          </div>
        )}

        {showSearch && (
          <div className="nav-group">
            <GroupTitle id="work" title="Работа" />
            {groupFor(workShut ? work.filter((id) => id === section) : work, WORK_GROUP)}
          </div>
        )}

        {customize && mod === "search" && (
          <div className="nav-group nav-opts">
            <label className="nav-opt"><span className="grow">Числа у разделов</span><SwitchMini on={device.sidebarCounts} onChange={(v) => void patchDevice({ sidebarCounts: v })} /></label>
            <label className="nav-opt"><span className="grow">Список источников</span><SwitchMini on={device.sidebarSources} onChange={(v) => void patchDevice({ sidebarSources: v })} /></label>
          </div>
        )}
      </nav>

      <div className="side-foot">
        {customize ? (
          <Button variant="primary" icon="check" onClick={() => setState({ customizeNav: false })}>Готово</Button>
        ) : (
          <>
            {updateReady && <UpdateButton />}
            {canCustomize && <button type="button" className="nav-item" onClick={() => setState({ customizeNav: true })}><Icon name="edit" size={16} /><span>Настроить панель</span></button>}
          </>
        )}
        <div className="row side-account-row">
          <button ref={accountBtn} type="button" className="account-btn" onClick={() => setAccountRect(accountBtn.current?.getBoundingClientRect() ?? null)} aria-haspopup="menu" aria-label={incoming > 0 ? `Учётная запись, приглашений: ${incoming}` : "Учётная запись"}>
            <span className="avatar-wrap">
              <Avatar name={session?.displayName ?? "?"} src={session?.avatar} size={28} />
              {incoming > 0 && <span className="red-badge" aria-label={`Приглашений: ${incoming}`}>{incoming}</span>}
            </span>
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
            <li><button className="menu-item" onClick={() => { setAccountRect(null); openProfile(null); }}><span className="menu-icon"><Icon name="user" size={14} /></span>Профиль</button></li>
            <li><button className="menu-item" onClick={() => { setAccountRect(null); openSettings("appearance"); }}><span className="menu-icon"><Icon name="settings" size={14} /></span>Настройки</button></li>
            <li><button className="menu-item" onClick={() => { setAccountRect(null); setState({ workspaceOpen: true }); }}><span className="menu-icon"><Icon name="users" size={14} /></span>Рабочее пространство{incoming > 0 && <span className="red-badge menu-badge" aria-label={`Приглашений: ${incoming}`}>{incoming}</span>}</button></li>
            <li><button className="menu-item" onClick={() => { setAccountRect(null); openMarket(); }}><span className="menu-icon"><Icon name="store" size={14} /></span>Коннекторы</button></li>
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
  const busy = update.phase === "installing";
  const click = () => {
    if (!update.canUpdate) return void openLink(update.releasesPage);
    void attempt(() => api.installUpdate());
  };
  const version = update.stagedVersion ?? update.available?.version;
  const tip = version ? `Установить версию ${version} и перезапустить` : "Обновить приложение";
  return (
    <button type="button" className="update-btn" disabled={busy} onClick={click} data-tip={tip} aria-label={`Обновить. ${tip}`}>
      <Icon name={busy ? "refresh" : "download"} size={14} className={busy ? "pulse" : undefined} />
      <span>{busy ? "Установка…" : "Обновить"}</span>
    </button>
  );
}
