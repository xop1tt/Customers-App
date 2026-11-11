// Календарь CRM (пакет G2, docs/CALENDAR.md): месяц и неделя с задачами по сроку и событиями по времени.
// Срок задачи переносится перетаскиванием на другой день или из меню записи; щелчок по дню создаёт задачу.

import { useState } from "react";
import { api } from "../../api";
import type { CrmRecord } from "../../api/types";
import { addDays, byDay, calendarItems, dayKey, dayTitle, defaultDue, moveToDay, periodTitle, queryRange, shift, startOfDay, timeText, visibleDays, weekdays, type CalendarItem, type CalendarView } from "../../lib/calendar";
import { can, ENTITIES, memberName, type EntityType } from "../../lib/crm";
import { integer, plural } from "../../lib/format";
import { Button, EmptyState, IconButton, Segmented, Spinner } from "../../ui/kit";
import { type MenuItem, showMenu } from "../../ui/overlay";
import { attempt, openRecord, toast, useStore } from "../../state/store";
import { useLookup, useWsQuery } from "./useCrm";

/** Сколько записей показывает ячейка месяца, прежде чем свернуть остальные в «ещё N». */
const MONTH_LIMIT = 3;

export function CalendarPage() {
  const ws = useStore((s) => s.ws);
  const record = useStore((s) => s.record);
  const lk = useLookup();
  const [view, setView] = useState<CalendarView>("month");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [drag, setDrag] = useState<{ item: CalendarItem; over: string | null } | null>(null);
  const [tick, setTick] = useState(0);

  const days = visibleDays(view, anchor);
  const range = queryRange(days);
  const { data, error } = useWsQuery(async () => {
    const between = (field: string) => [{ field, op: "gte", value: range.from }, { field, op: "lt", value: range.to }];
    const [tasks, activities] = await Promise.all([
      api.wsList("tasks", { limit: 5000, filters: between("due_at"), sort: [{ field: "due_at", dir: "asc" }] }),
      api.wsList("activities", { limit: 5000, filters: between("occurred_at"), sort: [{ field: "occurred_at", dir: "asc" }] }),
    ]);
    return { tasks: tasks.items, activities: activities.items };
  }, [range.from, range.to, tick]);

  if (error) return <div className="page"><EmptyState icon="alert" title="Календарь не загрузился">{error}</EmptyState></div>;

  const perms = ws?.permissions ?? [];
  const me = ws?.me;
  const now = new Date();
  const today = dayKey(now);
  const items = data ? calendarItems(data.tasks, data.activities, now, scope === "mine" ? me : undefined) : [];
  const map = byDay(items);
  const shown = days.reduce((n, d) => n + (map.get(dayKey(d))?.length ?? 0), 0);
  const movable = (it: CalendarItem) => it.kind === "task" && can(perms, "edit", it.record, me);

  const open = (it: CalendarItem) => {
    if (it.kind === "task") return openRecord("tasks", it.record.id);
    // Событие открывает запись, к которой оно относится: там его лента.
    const table = ENTITIES[it.record.entity_type as EntityType]?.table;
    if (table && it.record.entity_id) openRecord(table, String(it.record.entity_id));
  };
  const move = async (it: CalendarItem, day: Date) => {
    if (!movable(it)) return;
    const due = moveToDay(String(it.record.due_at), day);
    if (!due) return;
    if (await attempt(() => api.wsSave("tasks", it.record.id, { due_at: due }))) {
      toast(`Срок перенесён: ${dayTitle(day)}`, "success");
      setTick((n) => n + 1);
    }
  };
  const menu = (it: CalendarItem): MenuItem[] => {
    const base = startOfDay(it.at);
    const next = addDays(base, 7 - ((base.getDay() + 6) % 7));
    return [
      { label: "Открыть", icon: "external", onSelect: () => open(it) },
      { separator: true },
      { label: "Перенести на сегодня", disabled: !movable(it) || dayKey(base) === today, onSelect: () => void move(it, startOfDay(now)) },
      { label: "Перенести на завтра", disabled: !movable(it), onSelect: () => void move(it, addDays(startOfDay(now), 1)) },
      { label: "Перенести на следующую неделю", disabled: !movable(it), onSelect: () => void move(it, next) },
    ];
  };
  const subject = (r: CrmRecord) => {
    if (r.entity_type === "company" && r.entity_id) return String(lk.companies.get(String(r.entity_id))?.name ?? "");
    return "";
  };

  const chip = (it: CalendarItem, full: boolean) => (
    <li key={it.key}>
      <button
        type="button"
        className={`cal-item ${it.kind}${it.done ? " done" : ""}${it.overdue ? " overdue" : ""}${record?.id === it.record.id ? " sel" : ""}${drag?.item.key === it.key ? " dragging" : ""}`}
        draggable={movable(it)}
        onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.key); setDrag({ item: it, over: null }); }}
        onDragEnd={() => setDrag(null)}
        onClick={() => open(it)}
        onContextMenu={(e) => { e.preventDefault(); showMenu(menu(it), { x: e.clientX, y: e.clientY }); }}
        aria-label={`${timeText(it.at)} ${it.title}`}
        data-tip={full ? undefined : `${timeText(it.at)} · ${it.title}`}
      >
        <span className="cal-time num">{timeText(it.at)}</span>
        <span className={full ? "cal-text" : "cal-text ellipsis"}>{it.title}</span>
        {full && (subject(it.record) || it.kind === "task") && (
          <span className="cal-sub faint ellipsis">{[subject(it.record), it.kind === "task" && it.record.assignee_id ? memberName(lk.members, it.record.assignee_id) : ""].filter(Boolean).join(" · ")}</span>
        )}
      </button>
    </li>
  );

  const cell = (d: Date) => {
    const key = dayKey(d);
    const list = map.get(key) ?? [];
    const full = view === "week";
    const visible = full ? list : list.slice(0, MONTH_LIMIT);
    const outside = view === "month" && d.getMonth() !== anchor.getMonth();
    return (
      <div
        key={key}
        role="gridcell"
        aria-label={dayTitle(d)}
        className={`cal-day${key === today ? " today" : ""}${outside ? " outside" : ""}${drag?.over === key ? " drop" : ""}`}
        onDragOver={(e) => { if (drag) { e.preventDefault(); if (drag.over !== key) setDrag({ ...drag, over: key }); } }}
        onDragLeave={() => { if (drag?.over === key) setDrag({ ...drag, over: null }); }}
        onDrop={(e) => { e.preventDefault(); if (drag) void move(drag.item, d); setDrag(null); }}
      >
        <div className="cal-day-head">
          <span className="cal-num num">{view === "week" ? `${weekdays()[(d.getDay() + 6) % 7]}, ${d.getDate()}` : d.getDate()}</span>
          <span className="grow" />
          {can(perms, "create") && <IconButton icon="plus" size={13} className="cal-add" tip="Новая задача на этот день" onClick={() => openRecord("tasks", "new", { due_at: defaultDue(d) })} />}
        </div>
        <ul className="cal-list">
          {visible.map((it) => chip(it, full))}
          {list.length > visible.length && (
            <li><button type="button" className="cal-more" onClick={() => { setAnchor(d); setView("week"); }}>ещё {integer(list.length - visible.length)}</button></li>
          )}
        </ul>
      </div>
    );
  };

  return (
    <div className="page crm-page">
      <div className="crm-bar">
        <IconButton icon="chevronLeft" tip={view === "month" ? "Предыдущий месяц" : "Предыдущая неделя"} onClick={() => setAnchor(shift(view, anchor, -1))} />
        <Button small onClick={() => setAnchor(startOfDay(new Date()))}>Сегодня</Button>
        <IconButton icon="chevronRight" tip={view === "month" ? "Следующий месяц" : "Следующая неделя"} onClick={() => setAnchor(shift(view, anchor, 1))} />
        <strong className="cal-title" aria-live="polite">{periodTitle(view, anchor)}</strong>
        <span className="grow" />
        <Segmented small value={scope} onChange={setScope} options={[{ value: "mine", label: "Мои" }, { value: "all", label: "Все" }]} />
        <Segmented small value={view} onChange={setView} options={[{ value: "month", label: "Месяц" }, { value: "week", label: "Неделя" }]} />
        {can(perms, "create") && <Button small variant="primary" icon="plus" onClick={() => openRecord("tasks", "new", { due_at: defaultDue(anchor) })}>Задача</Button>}
      </div>
      {!data ? <div className="boot"><Spinner size={18} /></div> : (
        <div className={`cal ${view}`} role="grid" aria-label={`Календарь: ${periodTitle(view, anchor)}`}>
          {view === "month" && (
            <div className="cal-week-head" role="row">
              {weekdays().map((w) => <span key={w} role="columnheader" className="faint">{w}</span>)}
            </div>
          )}
          <div className="cal-grid" role="row" style={{ ["--weeks" as string]: days.length / 7 }}>
            {days.map(cell)}
          </div>
        </div>
      )}
      <div className="statusbar">
        <span className="num">{integer(shown)} {plural(shown, "запись", "записи", "записей")}</span>
        <span className="faint">Задачи показаны по сроку, события — по времени. Срок задачи можно перетащить на другой день.</span>
      </div>
    </div>
  );
}
