import { useRef, useState } from "react";
import { count, type SectionId, SECTIONS } from "../lib/leads";
import { integer } from "../lib/format";
import { CONFIGURABLE, MAIN_GROUP, WORK_GROUP, move, ordered, toggled } from "../lib/sidebarPrefs";
import { SOURCES } from "../lib/sources";
import { Avatar, Button, IconButton } from "../ui/kit";
import { Icon } from "../ui/icons";
import { type MenuItem, Popover, showMenu } from "../ui/overlay";
import { leaveSession, openSettings, openSource, patchDevice, setSection, setState, useStore } from "../state/store";
import { openLink } from "../state/actions";

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
  const accountBtn = useRef<HTMLButtonElement>(null);
  const [accountRect, setAccountRect] = useState<DOMRect | null>(null);

  const countOf = (id: SectionId) => (device.sidebarCounts && id !== "home" && id !== "sources" && id !== "runs" ? count(leads, id, true) : undefined);
  const visible = (id: string) => customize || !device.sidebarHidden.includes(id);

  const main = ordered(MAIN_GROUP, device.sidebarOrder).filter(visible) as SectionId[];
  const work = ordered(WORK_GROUP, device.sidebarOrder).filter(visible) as SectionId[];

  const perSource = new Map<string, number>();
  for (const l of leads) if (!l.archived && !l.excluded) perSource.set(l.data.source, (perSource.get(l.data.source) ?? 0) + 1);
  const sourceKeys = ordered(SOURCES.map((s) => s.key), device.sidebarSourceOrder).filter((k) => customize || !device.sidebarHiddenSources.includes(k));

  const helpItems = (): MenuItem[] => [
    { label: "Что нового", icon: "sparkles", onSelect: () => setState({ whatsNewOpen: true }) },
    { label: "Страница релизов", icon: "external", onSelect: () => void openLink(update?.releasesPage ?? "https://github.com/xop1tt/CLIENTS/releases") },
    { label: "Сообщить о проблеме", icon: "report", onSelect: () => openSettings("reports") },
  ];

  const updateReady = update && ["available", "downloading", "ready", "installing"].includes(update.phase);
  const syncIcon = sync?.enabled ? (sync.kind === "failed" || sync.kind === "offline" ? "cloudOff" : "cloud") : null;

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
        : <NavItem key={id} id={id} active={section === id && !(id === "all" && sourceFilter)} badge={countOf(id)} onClick={() => setSection(id)} />,
    );

  return (
    <aside className={`sidebar${overlay ? " overlay" : ""}`} style={{ width: device.navWidth }} aria-label="Навигация">
      <div className="side-head">
        <button ref={accountBtn} type="button" className="account-btn" onClick={() => setAccountRect(accountBtn.current?.getBoundingClientRect() ?? null)} aria-haspopup="menu">
          <Avatar name={session?.displayName ?? "?"} size={26} />
          <span className="col grow side-account">
            <span className="ellipsis side-name">{session?.displayName}</span>
            <span className="ellipsis faint side-sub">{session?.isCloud ? "Облачный аккаунт" : "Локальный аккаунт"}</span>
          </span>
          {syncIcon && <Icon name={syncIcon} size={14} className={sync?.kind === "syncing" ? "pulse" : "faint"} />}
          <Icon name="chevronDown" size={13} className="faint" />
        </button>
        <IconButton icon="sidebar" tip="Свернуть панель" onClick={() => (overlay ? setState({ navPeek: false }) : void patchDevice({ navOpen: false }))} />
      </div>
      {accountRect && (
        <Popover anchor={accountRect} onClose={() => setAccountRect(null)} ignore={accountBtn.current} minWidth={accountRect.width} className="popover-menu">
          <ul className="menu">
            <li><button className="menu-item" onClick={() => { setAccountRect(null); openSettings("account"); }}><span className="menu-icon"><Icon name="user" size={14} /></span>Аккаунт и синхронизация</button></li>
            <li><button className="menu-item" onClick={() => { setAccountRect(null); openSettings("data"); }}><span className="menu-icon"><Icon name="database" size={14} /></span>Данные и копии</button></li>
            <li className="menu-sep" />
            <li><button className="menu-item danger" onClick={() => { setAccountRect(null); void leaveSession(); }}><span className="menu-icon"><Icon name="logout" size={14} /></span>Выйти</button></li>
          </ul>
        </Popover>
      )}

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
        {updateReady && !customize && (
          <button type="button" className="update-btn" onClick={() => openSettings("updates")}>
            <Icon name="download" size={15} />
            <span className="col grow">
              <span className="ellipsis">{update.phase === "ready" ? "Обновление готово" : update.phase === "downloading" ? "Загрузка обновления…" : "Доступно обновление"}</span>
              {update.available && <span className="faint side-sub">Версия {update.available.version}</span>}
            </span>
          </button>
        )}
        {customize ? (
          <Button variant="primary" icon="check" onClick={() => setState({ customizeNav: false })}>Готово</Button>
        ) : (
          <div className="row side-tools">
            <button type="button" className="nav-item grow" onClick={() => openSettings("appearance")}><Icon name="settings" size={16} /><span>Настройки</span></button>
            <IconButton icon="edit" tip="Настроить панель" onClick={() => setState({ customizeNav: true })} />
            <IconButton icon="help" tip="Справка" onClick={(e) => showMenu(helpItems(), e.currentTarget.getBoundingClientRect(), "top-start")} />
          </div>
        )}
      </div>
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
