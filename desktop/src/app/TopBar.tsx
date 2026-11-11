import { SECTIONS, isLeadList } from "../lib/leads";
import { integer, shortRelative } from "../lib/format";
import { Avatar, Button, IconButton, Spinner, TextInput } from "../ui/kit";
import { Icon } from "../ui/icons";
import { sourceTitle } from "../lib/sources";
import { patchDevice, setFilter, setState, useStore } from "../state/store";
import { startSearch, stopSearch } from "../state/actions";
import { visibleLeads } from "../lib/leads";
import { useMemo, useRef, useState } from "react";
import { Popover } from "../ui/overlay";
import { useViewportWidth } from "../state/hooks";
import { modKey } from "../lib/platform";
import { toggleQuick } from "./QuickSearch";

export function TopBar({ narrow }: { narrow: boolean }) {
  const navPeek = useStore((s) => s.navPeek);
  const section = useStore((s) => s.section);
  const filter = useStore((s) => s.filter);
  const leads = useStore((s) => s.snap.leads);
  const device = useStore((s) => s.device);
  const search = useStore((s) => s.search);
  const sync = useStore((s) => s.sync);
  const ws = useStore((s) => s.ws);
  const sourceTitleKey = filter.source;
  const collection = useStore((s) => (s.section === "collection" ? s.collections.find((c) => c.id === s.collectionId) : undefined));
  const lead = isLeadList(section);
  const shown = useMemo(() => (lead ? visibleLeads(leads, section, filter).length : 0), [leads, section, filter, lead]);

  const syncText = sync?.enabled
    ? sync.kind === "syncing" ? "Синхронизация…" : sync.kind === "offline" ? "Нет сети" : sync.kind === "failed" ? "Ошибка синхронизации" : sync.lastSync ? `Синхронизировано ${shortRelative(sync.lastSync)}` : "Синхронизация включена"
    : null;

  return (
    <header className="topbar">
      {/* Кнопка левой панели всегда на левом краю строки: свернуть или показать. */}
      <IconButton
        icon="sidebar"
        tip={(narrow ? navPeek : device.navOpen) ? "Свернуть панель" : "Показать панель"}
        aria-label={(narrow ? navPeek : device.navOpen) ? "Свернуть панель" : "Показать панель"}
        onClick={() => (narrow ? setState({ navPeek: !navPeek }) : void patchDevice({ navOpen: !device.navOpen }))}
      />
      <div className="topbar-title">
        <span className="topbar-emoji" aria-hidden="true">{collection?.emoji || SECTIONS[section].emoji}</span>
        <h2 className="ellipsis">{collection ? collection.name : SECTIONS[section].title}{sourceTitleKey && section === "all" ? <span className="muted"> · {sourceTitle(sourceTitleKey)}</span> : null}</h2>
        {lead && <span className="topbar-count num faint">{integer(shown)}</span>}
        {collection && <span className="topbar-count num faint">{integer(collection.count)}</span>}
      </div>
      <span className="grow" />
      {lead && (
        <TextInput
          value={filter.search}
          onChange={(v) => setFilter({ search: v })}
          onClear={() => setFilter({ search: "" })}
          icon="search"
          placeholder="Поиск по лидам"
          wrapClass="topbar-search"
          aria-label="Поиск по лидам"
        />
      )}
      {syncText && (
        <span className={`sync-chip ${sync?.kind === "failed" || sync?.kind === "offline" ? "bad" : ""}`} data-tip={sync?.message ?? undefined}>
          <Icon name={sync?.kind === "offline" || sync?.kind === "failed" ? "cloudOff" : "cloud"} size={13} />
          <span className="ellipsis">{syncText}</span>
        </span>
      )}
      {ws && <IconButton icon="search" tip={`Быстрый поиск (${modKey()}+K)`} aria-label="Быстрый поиск" onClick={toggleQuick} />}
      <WorkspaceAvatars />
      {search.running ? (
        <Button onClick={() => void stopSearch()} icon="stop" className="search-btn">
          <span className="ellipsis search-progress">{search.progress ?? "Идёт поиск…"}</span>
        </Button>
      ) : (
        <Button variant="primary" icon="search" onClick={() => void startSearch()} className="search-btn">Найти лиды</Button>
      )}
      {search.running && <Spinner size={14} />}
      {lead && <IconButton icon="panelRight" tip={device.inspectorShown ? "Скрыть панель сведений" : "Показать панель сведений"} active={device.inspectorShown} onClick={() => void patchDevice({ inspectorShown: !device.inspectorShown })} />}
    </header>
  );
}


/** Аватары участников Workspace (docs/CRM_ARCHITECTURE.md §8.1): до 4 и «+N», в узком окне — один. */
export function WorkspaceAvatars() {
  const ws = useStore((s) => s.ws);
  const width = useViewportWidth();
  const btn = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  if (!ws?.isCloud || ws.members.length < 2) return null;
  const max = width < 1100 ? 1 : 4;
  const shown = ws.members.slice(0, max);
  const rest = ws.members.length - shown.length;
  const canInvite = ws.permissions.includes("invitations.manage");
  return (
    <>
      <button ref={btn} type="button" className="ws-avatars" aria-haspopup="dialog" aria-label={`Участники: ${ws.members.length}`} data-tip="Участники Workspace"
        onClick={() => setRect(btn.current?.getBoundingClientRect() ?? null)}>
        {shown.map((m) => <span key={m.userId} className="ws-avatar"><Avatar name={m.displayName} src={m.avatarPath} size={24} /></span>)}
        {rest > 0 && <span className="ws-avatar ws-more num">+{rest}</span>}
      </button>
      {rect && (
        <Popover anchor={rect} onClose={() => setRect(null)} ignore={btn.current} placement="bottom-end" minWidth={260} className="popover-menu" role="dialog">
          <ul className="menu ws-members">
            {ws.members.map((m) => (
              <li key={m.userId} className="ws-member">
                <Avatar name={m.displayName} src={m.avatarPath} size={24} />
                <span className="col grow" style={{ gap: 0, minWidth: 0 }}>
                  <span className="ellipsis">{m.displayName}{m.userId === ws.me ? <span className="faint"> · вы</span> : null}</span>
                  <span className="faint ellipsis" style={{ fontSize: "var(--fs-sm)" }}>{m.roleName}</span>
                </span>
              </li>
            ))}
            <li className="menu-sep" />
            {canInvite && <li><button className="menu-item" onClick={() => { setRect(null); setState({ workspaceOpen: true }); }}><span className="menu-icon"><Icon name="plus" size={14} /></span>Пригласить</button></li>}
            <li><button className="menu-item" onClick={() => { setRect(null); setState({ workspaceOpen: true }); }}><span className="menu-icon"><Icon name="users" size={14} /></span>Рабочее пространство</button></li>
          </ul>
        </Popover>
      )}
    </>
  );
}
