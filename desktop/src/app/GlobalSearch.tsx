// Глобальный поиск в шапке: лиды, записи CRM и действия в выпадающем списке. Что показывать — «Настройки → Система → Поиск».

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { CrmRecord } from "../api/types";
import { ENTITIES, type EntityType } from "../lib/crm";
import { useGlobalSearchPrefs } from "../lib/globalSearch";
import { modKey } from "../lib/platform";
import { moveActive, QUICK_TABLES, quickActions, quickRecords, type QuickItem } from "../lib/quick";
import { Icon } from "../ui/icons";
import { Spinner } from "../ui/kit";
import { goToRecord, select, setSection, useStore } from "../state/store";

type Item = QuickItem | { kind: "lead"; key: string; id: string; title: string; hint: string };

export function GlobalSearch() {
  const prefs = useGlobalSearchPrefs();
  const ws = useStore((s) => s.ws);
  const leads = useStore((s) => s.snap.leads);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<Partial<Record<EntityType, CrmRecord[]>>>({});
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const perms = ws?.permissions ?? [];
  const q = text.trim();
  const tables = QUICK_TABLES.filter((t) => prefs[t]);

  useEffect(() => {
    if (!q || !ws || !tables.length) { setFound({}); setLoading(false); return; }
    setLoading(true);
    let live = true;
    const t = setTimeout(() => {
      void Promise.all(tables.map((type) => api.wsList(ENTITIES[type].table, { search: q, limit: prefs.limit }).then((r) => [type, r.items] as const, () => [type, []] as const)))
        .then((rows) => { if (live) { setFound(Object.fromEntries(rows)); setLoading(false); setActive(0); } });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [q, ws?.active, prefs.limit, tables.join(",")]);

  // Ctrl/Cmd+/ переводит фокус в поле поиска из любого места.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "/") { e.preventDefault(); input.current?.focus(); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const items: Item[] = useMemo(() => {
    if (!q) return [];
    const needle = q.toLocaleLowerCase("ru");
    const leadItems: Item[] = prefs.leads
      ? leads.filter((l) => !l.excluded && [l.data.title, l.data.region ?? "", ...l.phones, ...l.emails].some((x) => String(x).toLocaleLowerCase("ru").includes(needle))).slice(0, prefs.limit)
        .map((l) => ({ kind: "lead" as const, key: `lead:${l.id}`, id: l.id, title: l.data.title, hint: [l.data.region, l.phones[0]].filter(Boolean).join(" · ") }))
      : [];
    const records = quickRecords(found).filter((i) => i.kind !== "record" || prefs[i.type]);
    const actions = prefs.actions && ws ? quickActions(q, perms).slice(0, prefs.limit) : [];
    return [...leadItems, ...records, ...actions];
  }, [q, found, leads, prefs, ws, perms.join(",")]);

  if (!prefs.enabled) return null;

  const run = (it: Item | undefined) => {
    if (!it) return;
    setOpen(false); setText(""); input.current?.blur();
    if (it.kind === "lead") { setSection("all"); select([it.id], it.id); }
    else if (it.kind === "record") goToRecord(ENTITIES[it.type].table, it.record.id);
    else if (it.kind === "create") goToRecord(ENTITIES[it.type].table, "new");
    else setSection(it.section);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); setActive((i) => moveActive(i, items.length, e.key === "ArrowDown" ? 1 : -1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(items[active]); }
    else if (e.key === "Escape") { if (open) { e.stopPropagation(); setOpen(false); } else { setText(""); input.current?.blur(); } }
  };
  const groupOf = (it: Item) => (it.kind === "lead" ? "Лиды" : it.kind === "record" ? ENTITIES[it.type].many : it.kind === "create" ? "Создать" : "Перейти");
  let group = "";
  return (
    <div className="gsearch" ref={root}>
      <Icon name="search" size={15} className="gsearch-ico" />
      <input ref={input} className="gsearch-input" type="search" role="combobox" aria-expanded={open && !!q} aria-controls="gsearch-list" aria-autocomplete="list" aria-label="Глобальный поиск"
        placeholder={`Поиск по лидам, клиентам, сделкам… (${modKey()}+/)`} value={text} autoComplete="off"
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)} onKeyDown={onKey} />
      {open && q && (
        <div className="gsearch-pop" id="gsearch-list" role="listbox" aria-label="Результаты поиска">
          {items.length === 0 ? (
            <div className="gsearch-empty faint">{loading ? <Spinner size={14} /> : "Ничего не нашлось."}</div>
          ) : items.map((it, i) => {
            const g = groupOf(it);
            const head = g !== group ? (group = g) : null;
            const icon = it.kind === "lead" ? "inbox" : it.kind === "record" || it.kind === "create" ? ENTITIES[it.type].icon : "chevronRight";
            return (
              <Fragment key={it.key}>
                {head && <div className="gsearch-group" role="presentation">{head}</div>}
                <button type="button" role="option" aria-selected={i === active} className={`gsearch-item${i === active ? " on" : ""}`} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); run(it); }}>
                  <Icon name={icon} size={15} />
                  <span className="ellipsis grow">{it.title}</span>
                  {"hint" in it && it.hint && <span className="ellipsis faint gsearch-hint">{it.hint}</span>}
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
