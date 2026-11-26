import { SECTIONS, isLeadList } from "../lib/leads";
import { integer } from "../lib/format";
import { Button, Spinner, TextInput } from "../ui/kit";
import { Icon } from "../ui/icons";
import { sourceTitle } from "../lib/sources";
import { setFilter, useStore } from "../state/store";
import { startSearch, stopSearch } from "../state/actions";
import { visibleLeads } from "../lib/leads";
import { useMemo } from "react";
import { useNewSince } from "../state/hooks";
import { moduleOf } from "../lib/modules";
import { collectionGlyph } from "../lib/crm";

export function TopBar() {
  const section = useStore((s) => s.section);
  const filter = useStore((s) => s.filter);
  const leads = useStore((s) => s.snap.leads);
  const search = useStore((s) => s.search);
  const sourceTitleKey = filter.source;
  const collection = useStore((s) => (s.section === "collection" ? s.collections.find((c) => c.id === s.collectionId) : undefined));
  const lead = isLeadList(section);
  const since = useNewSince();
  const shown = useMemo(() => (lead ? visibleLeads(leads, section, filter, since).length : 0), [leads, section, filter, lead, since]);

  const cg = collection ? collectionGlyph(collection) : null;
  const topGlyph = cg && "emoji" in cg ? cg.emoji : <Icon name={cg && "icon" in cg ? cg.icon : SECTIONS[section].icon} size={22} />;

  return (
    <header className="topbar">
      <div className="topbar-title">
        <span className="topbar-emoji" aria-hidden="true">{topGlyph}</span>
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
      {/* «Найти лиды» — только в модуле «Поиск»; в CRM кнопки нет. */}
      {moduleOf(section) === "search" && (search.running ? (
        <>
          <Button onClick={() => void stopSearch()} icon="stop" className="search-btn">
            <span className="ellipsis search-progress">{search.progress ?? "Идёт поиск…"}</span>
          </Button>
          <Spinner size={14} />
        </>
      ) : (
        <Button variant="primary" icon="search" onClick={() => void startSearch()} className="search-btn">Найти лиды</Button>
      ))}
    </header>
  );
}
