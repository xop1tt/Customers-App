// Быстрый поиск по Ctrl/Cmd+K (пакет G5, docs/QUICK_SEARCH.md): компании, контакты, сделки, задачи и лиды CRM,
// создание записей и переход в разделы. Стрелки выбирают, Enter открывает, Esc закрывает.

import { Fragment, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { CrmRecord } from "../api/types";
import { ENTITIES, type EntityType } from "../lib/crm";
import { modKey } from "../lib/platform";
import { moveActive, QUICK_LIMIT, QUICK_TABLES, quickActions, quickRecords, type QuickItem } from "../lib/quick";
import { Icon } from "../ui/icons";
import { Spinner } from "../ui/kit";
import { Dialog } from "../ui/overlay";
import { goToRecord, setSection, setState, useStore } from "../state/store";

const close = () => setState({ quickOpen: false });

export function QuickSearch() {
  const open = useStore((s) => s.quickOpen);
  const ws = useStore((s) => s.ws);
  if (!open || !ws) return null;
  return <QuickWindow perms={ws.permissions} />;
}

function QuickWindow({ perms }: { perms: string[] }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<Partial<Record<EntityType, CrmRecord[]>>>({});
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const q = text.trim();
    if (!q) { setFound({}); setLoading(false); return; }
    setLoading(true);
    let live = true;
    const t = setTimeout(() => {
      void Promise.all(QUICK_TABLES.map((type) => api.wsList(ENTITIES[type].table, { search: q, limit: QUICK_LIMIT }).then((r) => [type, r.items] as const, () => [type, []] as const)))
        .then((rows) => { if (live) { setFound(Object.fromEntries(rows)); setLoading(false); setActive(0); } });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [text]);

  const items: QuickItem[] = [...quickRecords(found), ...quickActions(text, perms)];
  useEffect(() => { list.current?.querySelector(".quick-item.on")?.scrollIntoView?.({ block: "nearest" }); }, [active]);

  const run = (it: QuickItem | undefined) => {
    if (!it) return;
    close();
    if (it.kind === "record") goToRecord(ENTITIES[it.type].table, it.record.id);
    else if (it.kind === "create") goToRecord(ENTITIES[it.type].table, "new");
    else setSection(it.section);
  };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive((i) => moveActive(i, items.length, e.key === "ArrowDown" ? 1 : -1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(items[active]); }
  };

  let group = "";
  return (
    <Dialog title="Быстрый поиск" onClose={close} width={600} className="quick">
      <div className="quick-input">
        <Icon name="search" size={16} />
        <input autoFocus value={text} onChange={(e) => { setText(e.target.value); setActive(0); }} onKeyDown={key} placeholder="Компания, контакт, сделка, задача или действие"
          aria-label="Быстрый поиск" role="combobox" aria-expanded aria-controls="quick-list" aria-activedescendant={items[active] ? `q-${items[active]!.key}` : undefined} />
        {loading && <Spinner size={14} />}
      </div>
      <ul className="quick-list" id="quick-list" role="listbox" ref={list} aria-label="Результаты">
        {items.map((it, i) => {
          const g = it.kind === "record" ? ENTITIES[it.type].many : it.kind === "create" ? "Создать" : "Разделы";
          const head = g !== group;
          group = g;
          return (
            <Fragment key={it.key}>
              {head && <li className="quick-group" role="presentation">{g}</li>}
              <li id={`q-${it.key}`} role="option" aria-selected={i === active} className={`quick-item${i === active ? " on" : ""}`}
                onMouseMove={() => i !== active && setActive(i)} onClick={() => run(it)}>
                <span className="quick-emoji" aria-hidden>{it.kind === "go" ? <Icon name="chevronRight" size={14} /> : it.kind === "create" ? <Icon name="plus" size={14} /> : <Icon name={ENTITIES[it.type].icon} size={14} />}</span>
                <span className="ellipsis">{it.title}</span>
                {it.kind === "record" && it.hint && <span className="faint ellipsis quick-hint">{it.hint}</span>}
              </li>
            </Fragment>
          );
        })}
        {!items.length && !loading && <li className="quick-empty faint" role="presentation">Ничего не найдено.</li>}
      </ul>
      <div className="quick-foot faint">
        <span><kbd>↑</kbd> <kbd>↓</kbd> выбрать</span><span><kbd>Enter</kbd> открыть</span><span><kbd>Esc</kbd> закрыть</span>
        <span className="grow" /><span><kbd>{modKey()}</kbd> <kbd>K</kbd></span>
      </div>
    </Dialog>
  );
}

/** Открыть или закрыть окно; работает, когда есть Workspace. */
export function toggleQuick() {
  setState((s) => (s.ws ? { quickOpen: !s.quickOpen } : {}));
}

