// Экран «Сегодня» (пакет B2): просроченные задачи, задачи на сегодня, сделки без движения, новые лиды из поиска.

import { useState } from "react";
import { api } from "../../api";
import type { CrmRecord } from "../../api/types";
import { STALE_DAYS, todayGroups } from "../../lib/board";
import { can, ENTITIES } from "../../lib/crm";
import { integer, plural } from "../../lib/format";
import { matchesSection } from "../../lib/leads";
import { Button, Checkbox, EmptyState, Score, Segmented, Spinner } from "../../ui/kit";
import { attempt, openRecord, select, setSection, useStore } from "../../state/store";
import { useLookup, useWsQuery } from "./useCrm";
import { BackupReminder } from "../BackupReminder";
import { StartChecklist } from "./StartChecklist";

const time = (iso: unknown) => new Date(String(iso)).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const day = (iso: unknown) => new Date(String(iso)).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

export function TodayPage() {
  const ws = useStore((s) => s.ws);
  const leads = useStore((s) => s.snap.leads);
  const lk = useLookup();
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [tick, setTick] = useState(0);
  const { data, error } = useWsQuery(async () => {
    const [tasks, deals] = await Promise.all([
      api.wsList("tasks", { limit: 5000, filters: [{ field: "status", op: "in", value: ["todo", "in_progress"] }] }),
      api.wsList("deals", { limit: 5000, filters: [{ field: "status", op: "eq", value: "open" }] }),
    ]);
    return { tasks: tasks.items, deals: deals.items };
  }, [tick]);

  if (error) return <div className="page"><EmptyState icon="alert" title="Не удалось загрузить">{error}</EmptyState></div>;
  if (!data) return <div className="page"><div className="boot"><Spinner size={18} /></div></div>;

  const perms = ws?.permissions ?? [];
  const me = ws?.me;
  const g = todayGroups(data.tasks, data.deals, new Date(), scope === "mine" ? me : undefined);
  const fresh = leads.filter((l) => matchesSection(l, "new")).sort((a, b) => b.data.score - a.data.score).slice(0, 5);
  const freshTotal = leads.filter((l) => matchesSection(l, "new")).length;

  const done = async (t: CrmRecord) => {
    if (await attempt(() => api.wsSave("tasks", t.id, { status: "done" }))) setTick((n) => n + 1);
  };
  const subject = (t: CrmRecord) => {
    if (!t.entity_type || !t.entity_id) return "";
    if (t.entity_type === "company") return String(lk.companies.get(String(t.entity_id))?.name ?? "");
    return ENTITIES[String(t.entity_type) as keyof typeof ENTITIES]?.one ?? "";
  };
  const taskRow = (t: CrmRecord, when: string) => (
    <li key={t.id} className="today-row">
      <Checkbox checked={false} disabled={!can(perms, "edit", t, me)} onChange={() => void done(t)} label={<span className="sr-only">Выполнено: {String(t.title)}</span>} />
      <button type="button" className="today-open" onClick={() => openRecord("tasks", t.id)}>
        <span className="ellipsis">{String(t.title || "Без названия")}</span>
        <span className="faint ellipsis">{[subject(t), when].filter(Boolean).join(" · ")}</span>
      </button>
    </li>
  );
  const section = (title: string, n: number, tone: string, body: React.ReactNode, empty: string) => (
    <section className={`today-card ${tone}`} aria-label={title}>
      <h3>{title} · {integer(n)}</h3>
      {n ? <ul>{body}</ul> : <p className="faint today-empty">{empty}</p>}
    </section>
  );

  return (
    <div className="page scroll">
      <div className="crm-bar">
        <span className="muted">{new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}</span>
        <Segmented small value={scope} onChange={setScope} options={[{ value: "mine", label: "Мои" }, { value: "all", label: "Все" }]} />
        <span className="grow" />
        {can(perms, "create") && <Button small onClick={() => openRecord("tasks", "new")}>Новая задача</Button>}
        {can(perms, "create") && <Button small variant="primary" icon="plus" onClick={() => openRecord("deals", "new")}>Новая сделка</Button>}
      </div>
      <StartChecklist tick={tick} />
      <BackupReminder />
      <div className="today-grid">
        {section("Просрочено", g.overdue.length, "warn", g.overdue.map((t) => taskRow(t, `${day(t.due_at)}, ${time(t.due_at)}`)), "Просроченных задач нет.")}
        {section(`Сделки без движения ${STALE_DAYS}+ дней`, g.stale.length, "", g.stale.slice(0, 20).map(({ deal, days }) => (
          <li key={deal.id} className="today-row">
            <button type="button" className="today-open row" onClick={() => openRecord("deals", deal.id)}>
              <span className="ellipsis grow">{String(deal.title || "Без названия")}</span>
              <span className="faint">{String(lk.stages.get(String(deal.stage_id))?.name ?? "")} · {integer(days)} {plural(days, "день", "дня", "дней")}</span>
            </button>
          </li>
        )), "Все открытые сделки двигались на этой неделе.")}
        {section("На сегодня", g.today.length, "", g.today.map((t) => taskRow(t, time(t.due_at))), "На сегодня задач нет.")}
        {section("Новые лиды из поиска", freshTotal, "", fresh.map((l) => (
          <li key={l.id} className="today-row">
            <button type="button" className="today-open row" onClick={() => { setSection("new"); select([l.id], l.id); }}>
              <Score value={l.data.score} />
              <span className="ellipsis grow">{l.data.title}</span>
            </button>
          </li>
        )), "Новых лидов нет. Поиск клиентов найдёт их по расписанию.")}
      </div>
    </div>
  );
}
