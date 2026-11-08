import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KIND_TITLE, type LeadFilter, type SortKey, allRegions, allSources, emptyFilter, filterIsDefault, isLeadList, sortLeads, signals, subtitle, visibleLeads } from "../../lib/leads";
import { integer, plural, shortRelative } from "../../lib/format";
import { sourceTitle } from "../../lib/sources";
import { modKey } from "../../lib/platform";
import type { Lead } from "../../api/types";
import { Button, Checkbox, EmptyState, IconButton, Score, Segmented, Select, Tag } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { type MenuItem, showMenu } from "../../ui/overlay";
import { patchDevice, select, setFilter, setState, useStore } from "../../state/store";
import { copyToClipboard, deleteLeads, excludeLeads, markSeen, openExport, openLink, setArchived, setFavorite, startSearch } from "../../state/actions";

const SORT_KEYS: SortKey[] = ["title", "kind", "source", "score", "discovered"];

export function LeadsPage() {
  const section = useStore((s) => s.section);
  const leads = useStore((s) => s.snap.leads);
  const filter = useStore((s) => s.filter);
  const selection = useStore((s) => s.selection);
  const anchor = useStore((s) => s.anchor);
  const device = useStore((s) => s.device);
  const lastSearchAt = useStore((s) => s.snap.lastSearchAt);

  const sortKey = (SORT_KEYS.includes(device.listSort as SortKey) ? device.listSort : "score") as SortKey;
  const desc = device.listSortDescending;
  const rows = useMemo(() => sortLeads(visibleLeads(leads, section, filter), sortKey, desc), [leads, section, filter, sortKey, desc]);
  const rowH = device.compactRows ? 34 : 48;
  const selected = useMemo(() => new Set(selection), [selection]);

  // ---- виртуализация
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(view.top / rowH) - 6);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / rowH) + 6);

  const reveal = useCallback((index: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = index * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
  }, [rowH]);

  // ---- выбор
  const choose = (l: Lead, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const index = rows.findIndex((r) => r.id === l.id);
    if (e.shiftKey && anchor) {
      const a = rows.findIndex((r) => r.id === anchor);
      if (a >= 0) {
        const [from, to] = a < index ? [a, index] : [index, a];
        return select(rows.slice(from, to + 1).map((r) => r.id));
      }
    }
    if (e.metaKey || e.ctrlKey) {
      return select(selected.has(l.id) ? selection.filter((x) => x !== l.id) : [...selection, l.id], l.id);
    }
    select([l.id], l.id);
    if (!l.seen) void markSeen([l.id]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const cur = anchor ? rows.findIndex((r) => r.id === anchor) : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(rows.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
      const l = rows[next];
      if (!l) return;
      reveal(next);
      if (e.shiftKey && cur >= 0) {
        const [a, b] = cur < next ? [cur, next] : [next, cur];
        const base = rows.findIndex((r) => r.id === selection[0]);
        const from = base >= 0 ? Math.min(base, a) : a;
        const to = base >= 0 ? Math.max(base, b) : b;
        select(rows.slice(from, to + 1).map((r) => r.id), l.id);
      } else {
        select([l.id], l.id);
        if (!l.seen) void markSeen([l.id]);
      }
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const l = rows[e.key === "Home" ? 0 : rows.length - 1];
      if (l) { select([l.id], l.id); reveal(e.key === "Home" ? 0 : rows.length - 1); }
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      select(rows.map((r) => r.id));
    } else if (e.key === "Escape") {
      select([]);
    } else if ((e.key === "Delete" || e.key === "Backspace") && selection.length) {
      e.preventDefault();
      void deleteLeads(selection);
    }
  };

  const menuFor = (l: Lead, e: React.MouseEvent) => {
    e.preventDefault();
    const ids = selected.has(l.id) ? selection : [l.id];
    if (!selected.has(l.id)) select([l.id], l.id);
    const targets = leads.filter((x) => ids.includes(x.id));
    const allFav = targets.every((x) => x.favorite);
    const allArch = targets.every((x) => x.archived);
    const single = ids.length === 1;
    const items: MenuItem[] = [
      { label: allFav ? "Убрать из избранного" : "В избранное", icon: "star", onSelect: () => void setFavorite(ids, !allFav) },
      { label: allArch ? "Вернуть из архива" : "В архив", icon: "archive", onSelect: () => void setArchived(ids, !allArch) },
      ...(targets.some((x) => !x.seen) ? [{ label: "Отметить прочитанным", icon: "eye", onSelect: () => void markSeen(ids) } as MenuItem] : []),
      { separator: true },
      ...(single && l.data.url ? [{ label: "Открыть ссылку", icon: "external", onSelect: () => void openLink(l.data.url) } as MenuItem] : []),
      ...(single ? [{ label: "Копировать название", icon: "copy", onSelect: () => void copyToClipboard(l.data.title, "Название скопировано") } as MenuItem] : []),
      ...(single && l.phones[0] ? [{ label: "Копировать телефон", icon: "phone", onSelect: () => void copyToClipboard(l.phones[0] as string, "Телефон скопирован") } as MenuItem] : []),
      ...(single && l.emails[0] ? [{ label: "Копировать почту", icon: "mail", onSelect: () => void copyToClipboard(l.emails[0] as string, "Почта скопирована") } as MenuItem] : []),
      { label: ids.length > 1 ? `Экспортировать (${ids.length})…` : "Экспортировать…", icon: "upload", onSelect: () => openExport(ids) },
      { separator: true },
      { label: "Исключить…", icon: "ban", danger: true, onSelect: () => void excludeLeads(ids) },
      { label: ids.length > 1 ? `Удалить (${ids.length})…` : "Удалить…", icon: "trash", danger: true, onSelect: () => void deleteLeads(ids) },
    ];
    showMenu(items, { x: e.clientX, y: e.clientY });
  };

  const sortBy = (key: SortKey) => {
    if (key === sortKey) void patchDevice({ listSortDescending: !desc });
    else void patchDevice({ listSort: key, listSortDescending: key !== "title" && key !== "source" });
  };

  const sources = useMemo(() => allSources(leads), [leads]);
  const regions = useMemo(() => allRegions(leads), [leads]);
  const total = useMemo(() => visibleLeads(leads, section, emptyFilter()).length, [leads, section]);
  const sec = isLeadList(section);
  if (!sec) return null;

  const head = (key: SortKey, title: string, cls: string) => (
    <button type="button" className={`th ${cls}${sortKey === key ? " sorted" : ""}`} onClick={() => sortBy(key)} aria-sort={sortKey === key ? (desc ? "descending" : "ascending") : "none"}>
      {title}
      {sortKey === key && <Icon name={desc ? "arrowDown" : "arrowUp"} size={11} />}
    </button>
  );

  const empty = (() => {
    if (leads.length > 0 && rows.length === 0 && (filter.search || !filterIsDefault(filter))) {
      return <EmptyState icon="search" title="Ничего не найдено" action={<Button onClick={() => setState({ filter: emptyFilter() })}>Сбросить поиск и фильтры</Button>}>Попробуйте изменить запрос или убрать фильтры.</EmptyState>;
    }
    switch (section) {
      case "new": return <EmptyState icon="sparkles" title="Новых лидов нет">Все найденные лиды просмотрены. Запустите поиск, чтобы найти свежие.</EmptyState>;
      case "favorites": return <EmptyState icon="star" title="В избранном пока пусто">Отмечайте звёздочкой лиды, к которым хотите вернуться.</EmptyState>;
      case "archive": return <EmptyState icon="archive" title="Архив пуст">Сюда попадают лиды, которые вы убрали из рабочего списка.</EmptyState>;
      case "excluded": return <EmptyState icon="ban" title="Исключённых лидов нет">Лиды, подпадающие под исключения, будут показаны здесь.</EmptyState>;
      default: return <EmptyState icon="inbox" title="Лидов пока нет" action={<Button variant="primary" icon="search" onClick={() => void startSearch()}>Найти лиды</Button>}>Запустите поиск или добавьте источники.</EmptyState>;
    }
  })();

  return (
    <div className="page leads" onKeyDown={onKey}>
      <FilterBar filter={filter} sources={sources} regions={regions} />
      <div className="table-wrap" tabIndex={0} role="grid" aria-label="Список лидов" aria-rowcount={rows.length}>
        <div className="thead" role="row">
          <span className="th th-star" />
          {head("title", "Название", "th-title")}
          {head("kind", "Тип", "th-kind")}
          {head("source", "Источник", "th-source")}
          {head("score", "Оценка", "th-score")}
          <span className="th th-sig">Сигналы</span>
          {head("discovered", "Найден", "th-found")}
        </div>
        <div ref={scroller} className="tbody" onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
          {rows.length === 0 ? (
            empty
          ) : (
            <div className="rows" style={{ height: rows.length * rowH }}>
              {rows.slice(first, last).map((l, i) => (
                <LeadRow key={l.id} lead={l} y={(first + i) * rowH} h={rowH} selected={selected.has(l.id)} onPick={choose} onMenu={menuFor} />
              ))}
            </div>
          )}
        </div>
      </div>
      {selection.length > 1 && <BulkBar ids={selection} />}
      <div className="statusbar">
        <span className="num">{integer(rows.length)}{rows.length !== total ? ` из ${integer(total)}` : ""} {plural(rows.length, "лид", "лида", "лидов")}</span>
        {selection.length > 0 && <span className="num">Выбрано: {integer(selection.length)}</span>}
        <span className="grow" />
        <span className="faint hide-narrow">{lastSearchAt ? `Последний поиск: ${shortRelative(lastSearchAt)}` : "Поиск ещё не запускался"}</span>
        <span className="faint hide-narrow">{modKey()}+A выбрать всё</span>
      </div>
    </div>
  );
}

function LeadRow({ lead, y, h, selected, onPick, onMenu }: { lead: Lead; y: number; h: number; selected: boolean; onPick: (l: Lead, e: React.MouseEvent) => void; onMenu: (l: Lead, e: React.MouseEvent) => void }) {
  const d = lead.data;
  const sig = signals(lead);
  const sub = subtitle(lead);
  const fresh = !lead.seen && !lead.archived && !lead.excluded;
  return (
    <div
      className={`tr${selected ? " sel" : ""}${fresh ? " fresh" : ""}`}
      style={{ top: y, height: h }}
      role="row"
      aria-selected={selected}
      onClick={(e) => onPick(lead, e)}
      onContextMenu={(e) => onMenu(lead, e)}
    >
      <span className="td td-star">
        <button type="button" className={`star${lead.favorite ? " on" : ""}`} onClick={(e) => { e.stopPropagation(); void setFavorite([lead.id], !lead.favorite); }} aria-label={lead.favorite ? "Убрать из избранного" : "В избранное"} data-tip={lead.favorite ? "Убрать из избранного" : "В избранное"}>
          <Icon name="star" size={15} fill={lead.favorite} />
        </button>
      </span>
      <span className="td td-title">
        <span className="row lead-title-line">
          {fresh && <span className="new-dot" aria-label="Новый" />}
          <span className="ellipsis lead-title">{d.title}</span>
        </span>
        {h > 40 && sub && <span className="ellipsis lead-sub muted">{sub}</span>}
      </span>
      <span className="td td-kind"><Tag tone={d.kind === "order" ? "blue" : "gray"}>{KIND_TITLE[d.kind]}</Tag></span>
      <span className="td td-source ellipsis muted">{sourceTitle(d.source)}</span>
      <span className="td td-score"><Score value={d.score} /></span>
      <span className="td td-sig">{sig.map((s) => <Tag key={s.text} tone={s.tone}>{s.text}</Tag>)}</span>
      <span className="td td-found muted num">{shortRelative(lead.discoveredAt)}</span>
    </div>
  );
}

function FilterBar({ filter, sources, regions }: { filter: LeadFilter; sources: string[]; regions: string[] }) {
  const active = !filterIsDefault(filter);
  return (
    <div className="filterbar">
      <Segmented
        small
        value={filter.kind ?? "all"}
        onChange={(v) => setFilter({ kind: v === "all" ? null : v })}
        options={[{ value: "all", label: "Все" }, { value: "order", label: "Заказы" }, { value: "organization", label: "Организации" }]}
      />
      <Select small width={160} value={filter.source ?? ""} onChange={(v) => setFilter({ source: v || null })} label="Источник"
        options={[{ value: "", label: "Все источники" }, ...sources.map((s) => ({ value: s, label: sourceTitle(s) }))]} />
      {regions.length > 0 && (
        <Select small width={160} value={filter.region ?? ""} onChange={(v) => setFilter({ region: v || null })} label="Регион"
          options={[{ value: "", label: "Все регионы" }, ...regions.map((r) => ({ value: r, label: r }))]} />
      )}
      <Select small width={138} value={filter.minScore} onChange={(v) => setFilter({ minScore: v })} label="Оценка"
        options={[{ value: 0, label: "Любая оценка" }, { value: 40, label: "От 40" }, { value: 60, label: "От 60" }, { value: 80, label: "От 80" }]} />
      <Checkbox checked={filter.hideRejected} onChange={(v) => setFilter({ hideRejected: v })} label={<span className="nowrap">Скрыть неподходящие</span>} />
      <span className="grow" />
      {active && <Button small variant="ghost" icon="x" onClick={() => setState({ filter: emptyFilter(filter.search) })}>Сбросить</Button>}
    </div>
  );
}

function BulkBar({ ids }: { ids: string[] }) {
  const leads = useStore((s) => s.snap.leads);
  const targets = leads.filter((l) => ids.includes(l.id));
  const allFav = targets.every((l) => l.favorite);
  const allArch = targets.every((l) => l.archived);
  return (
    <div className="bulkbar" role="toolbar" aria-label="Действия над выбранными">
      <span className="num bulk-count">Выбрано: {integer(ids.length)}</span>
      <Button small variant="subtle" icon="star" onClick={() => void setFavorite(ids, !allFav)}>{allFav ? "Убрать из избранного" : "В избранное"}</Button>
      <Button small variant="subtle" icon="archive" onClick={() => void setArchived(ids, !allArch)}>{allArch ? "Вернуть" : "В архив"}</Button>
      <Button small variant="subtle" icon="upload" onClick={() => openExport(ids)}>Экспорт</Button>
      <Button small variant="subtle" icon="ban" onClick={() => void excludeLeads(ids)}>Исключить</Button>
      <Button small variant="danger" icon="trash" onClick={() => void deleteLeads(ids)}>Удалить</Button>
      <span className="grow" />
      <IconButton icon="x" tip="Снять выделение" onClick={() => select([])} />
    </div>
  );
}
