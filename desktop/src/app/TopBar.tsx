import { SECTIONS, isLeadList } from "../lib/leads";
import { integer, shortRelative } from "../lib/format";
import { Button, IconButton, Spinner, TextInput } from "../ui/kit";
import { Icon } from "../ui/icons";
import { sourceTitle } from "../lib/sources";
import { patchDevice, setFilter, setState, useStore } from "../state/store";
import { startSearch, stopSearch } from "../state/actions";
import { visibleLeads } from "../lib/leads";
import { useMemo } from "react";

export function TopBar({ narrow }: { narrow: boolean }) {
  const navPeek = useStore((s) => s.navPeek);
  const section = useStore((s) => s.section);
  const filter = useStore((s) => s.filter);
  const leads = useStore((s) => s.snap.leads);
  const device = useStore((s) => s.device);
  const search = useStore((s) => s.search);
  const sync = useStore((s) => s.sync);
  const sourceTitleKey = filter.source;
  const lead = isLeadList(section);
  const shown = useMemo(() => (lead ? visibleLeads(leads, section, filter).length : 0), [leads, section, filter, lead]);

  const syncText = sync?.enabled
    ? sync.kind === "syncing" ? "Синхронизация…" : sync.kind === "offline" ? "Нет сети" : sync.kind === "failed" ? "Ошибка синхронизации" : sync.lastSync ? `Синхронизировано ${shortRelative(sync.lastSync)}` : "Синхронизация включена"
    : null;

  return (
    <header className="topbar">
      {(!device.navOpen || narrow) && <IconButton icon="sidebar" tip="Показать панель" onClick={() => (narrow ? setState({ navPeek: !navPeek }) : void patchDevice({ navOpen: true }))} />}
      <div className="topbar-title">
        <h2 className="ellipsis">{SECTIONS[section].title}{sourceTitleKey && section === "all" ? <span className="muted"> · {sourceTitle(sourceTitleKey)}</span> : null}</h2>
        {lead && <span className="topbar-count num faint">{integer(shown)}</span>}
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

