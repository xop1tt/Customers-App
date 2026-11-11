// Отчёты (этап 2, пакет G3): итоги периода, прогноз, воронка, динамика по месяцам, источники клиентов,
// причины проигрыша и показатели сотрудников. Только чтение.

import { useState } from "react";
import { api } from "../../api";
import { memberName } from "../../lib/crm";
import { integer, money, plural } from "../../lib/format";
import { getLanguage } from "../../lib/i18n";
import { forecast, funnel, lostReasons, monthly, percent, periodStart, sources, summary, team, type ForecastRow, type Period } from "../../lib/reports";
import { EmptyState, Segmented, Select, Spinner } from "../../ui/kit";
import { useLookup, useWsQuery } from "./useCrm";

const PERIODS: { value: Period; label: string }[] = [
  { value: "month", label: "Месяц" },
  { value: "quarter", label: "Квартал" },
  { value: "year", label: "Год" },
  { value: "all", label: "Всё время" },
];

const moneyList = (s: [string, number][]) => (s.length ? s.map(([cur, n]) => money(n, cur)).join(" · ") : "—");

export function ReportsPage() {
  const lk = useLookup();
  const [period, setPeriod] = useState<Period>("month");
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const { data, error } = useWsQuery(async () => {
    const [deals, history, tasks, activities] = await Promise.all([
      api.wsList("deals", { limit: 5000 }),
      api.wsStageHistory(),
      api.wsList("tasks", { limit: 5000 }),
      api.wsList("activities", { limit: 5000, sort: [{ field: "occurred_at", dir: "desc" }] }),
    ]);
    return { deals: deals.items, history, tasks: tasks.items, activities: activities.items };
  }, []);

  if (error) return <div className="page"><EmptyState icon="alert" title="Отчёты не загрузились">{error}</EmptyState></div>;
  if (!data || !lk.stages.size) return <div className="page"><div className="boot"><Spinner size={18} /></div></div>;
  const pipes = [...lk.pipelines.values()].filter((p) => !p.deleted_at);
  const pipe = pipes.find((p) => p.id === pipelineId) ?? pipes.find((p) => p.is_default) ?? pipes[0];
  if (!pipe) return <div className="page"><EmptyState icon="list" title="Нет воронки">Создайте воронку в настройках Workspace.</EmptyState></div>;

  const from = periodStart(period);
  const s = summary(data.deals, pipe.id, from);
  const steps = funnel([...lk.stages.values()], data.deals, data.history, pipe.id, from);
  const reasons = lostReasons(data.deals, pipe.id, from);
  const stages = [...lk.stages.values()];
  const fc = forecast(data.deals, stages, pipe.id);
  const thisMonth = fc.rows.find((r) => r.bucket === "m0")!;
  const months = monthly(data.deals, pipe.id);
  const maxMonth = Math.max(1, ...months.map((m) => m.created));
  const src = sources([...lk.companies.values()], data.deals, pipe.id, from);
  const owners = team(data.deals, data.tasks, data.activities, pipe.id, from);
  const top = steps[0]?.reached ?? 0;
  const maxReason = reasons[0]?.count ?? 0;

  return (
    <div className="page scroll">
      <div className="crm-bar">
        {pipes.length > 1 && <Select small value={pipe.id} options={pipes.map((p) => ({ value: p.id, label: String(p.name) }))} onChange={setPipelineId} label="Воронка" />}
        <Segmented small value={period} onChange={setPeriod} options={PERIODS} />
        <span className="grow" />
        <span className="faint">{from ? `с ${from.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}` : "за всё время"}</span>
      </div>

      <div className="report-stats" role="list" aria-label="Итоги периода">
        <Stat label="Выиграно" value={moneyList(s.wonSums)} note={`${integer(s.won)} ${plural(s.won, "сделка", "сделки", "сделок")}`} />
        <Stat label="Конверсия в успех" value={percent(s.winRate)} note={`проиграно: ${integer(s.lost)}`} />
        <Stat label="Средний цикл сделки" value={s.cycleDays === null ? "—" : `${integer(Math.round(s.cycleDays))} ${plural(Math.round(s.cycleDays), "день", "дня", "дней")}`} note="от создания до успеха" />
        <Stat label="Новых сделок" value={integer(s.created)} note="создано в периоде" />
        <Stat label="В работе сейчас" value={moneyList(s.openSums)} note={`${integer(s.open)} ${plural(s.open, "открытая сделка", "открытые сделки", "открытых сделок")}`} />
        <Stat label="Прогноз на этот месяц" value={moneyList(thisMonth.weighted)} note="с учётом вероятности этапа" />
      </div>

      <div className="report-grid">
        <section className="today-card report-wide" aria-label="Прогноз">
          <h3>Прогноз · открытые сделки по ожидаемой дате закрытия</h3>
          {s.open ? (
            <>
              <table className="report-table">
                <thead><tr><th>Когда</th><th className="num">Сделок</th><th className="num">Сумма</th><th className="num" title="Сумма × вероятность этапа">Ожидается</th></tr></thead>
                <tbody>
                  {fc.rows.filter((r) => r.count || r.bucket === "m0").map((r) => (
                    <tr key={r.bucket} className={r.bucket === "overdue" ? "warn" : undefined}>
                      <td className="ellipsis">{bucketTitle(r)}</td>
                      <td className="num">{integer(r.count)}</td>
                      <td className="num">{moneyList(r.sums)}</td>
                      <td className="num">{moneyList(r.weighted)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td>Всего ожидается</td><td className="num">{integer(s.open)}</td><td className="num">{moneyList(s.openSums)}</td><td className="num">{moneyList(fc.weighted)}</td></tr></tfoot>
              </table>
              <p className="faint report-note">
                Вероятность берётся из этапа воронки (настройки Workspace → Воронки).
                {fc.noAmount ? ` Без суммы: ${integer(fc.noAmount)} ${plural(fc.noAmount, "сделка", "сделки", "сделок")}.` : ""}
              </p>
            </>
          ) : <p className="faint today-empty">Открытых сделок нет.</p>}
        </section>

        <section className="today-card report-wide" aria-label="Динамика по месяцам">
          <h3>Динамика по месяцам</h3>
          <table className="report-table report-months">
            <thead><tr><th>Месяц</th><th>Создано</th><th className="num">Выиграно</th><th className="num">Проиграно</th><th className="num" title="Сумма выигранных сделок">На сумму</th></tr></thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month.toISOString()}>
                  <td className="ellipsis">{monthTitle(m.month)}</td>
                  <td><span className="month-bar"><span className="funnel-track"><span className="funnel-bar" style={{ width: `${(m.created / maxMonth) * 100}%` }} /></span><span className="num">{integer(m.created)}</span></span></td>
                  <td className="num">{integer(m.won)}</td>
                  <td className="num">{integer(m.lost)}</td>
                  <td className="num">{moneyList(m.wonSums)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="today-card report-wide" aria-label="Воронка">
          <h3>Воронка · сделки, созданные в периоде</h3>
          {top ? (
            <ol className="funnel">
              {steps.map((st) => (
                <li key={st.stage.id} className={`funnel-row ${String(st.stage.kind ?? "open")}`}>
                  <span className="ellipsis">{String(st.stage.name)}</span>
                  <span className="funnel-track"><span className="funnel-bar" style={{ width: `${Math.max(st.fromFirst * 100, st.reached ? 2 : 0)}%` }} /></span>
                  <span className="num">{integer(st.reached)}</span>
                  <span className="faint num" title="Доля от предыдущего этапа">{st.fromPrev === null ? "" : percent(st.fromPrev)}</span>
                </li>
              ))}
            </ol>
          ) : <p className="faint today-empty">В этом периоде сделок не создавали.</p>}
        </section>

        <section className="today-card" aria-label="Источники клиентов">
          <h3>Источники клиентов</h3>
          {src.length ? (
            <table className="report-table">
              <thead><tr><th>Источник</th><th className="num" title="Новые компании в периоде">Клиентов</th><th className="num" title="Выигранные в периоде сделки клиентов этого источника">Выиграно</th></tr></thead>
              <tbody>
                {src.map((r) => (
                  <tr key={r.source}>
                    <td className="ellipsis" title={r.source}>{r.source}</td>
                    <td className="num">{integer(r.clients)}</td>
                    <td className="num" title={moneyList(r.wonSums)}>{integer(r.won)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="faint today-empty">В этом периоде новых клиентов нет.</p>}
        </section>

        <section className="today-card" aria-label="Причины проигрыша">
          <h3>Причины проигрыша</h3>
          {reasons.length ? (
            <ul className="report-list">
              {reasons.map((r) => (
                <li key={r.reason} className="report-reason">
                  <span className="ellipsis">{r.reason}</span>
                  <span className="funnel-track"><span className="funnel-bar lost" style={{ width: `${(r.count / maxReason) * 100}%` }} /></span>
                  <span className="num">{integer(r.count)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="faint today-empty">Проигранных сделок нет.</p>}
        </section>

        <section className="today-card report-wide" aria-label="По ответственным">
          <h3>Сотрудники</h3>
          {owners.length ? (
            <table className="report-table">
              <thead><tr><th>Сотрудник</th><th className="num">В работе</th><th className="num">Выиграно</th><th className="num" title="Доля выигранных среди закрытых">Доля успеха</th><th className="num" title="Задачи, выполненные в периоде">Задачи</th><th className="num" title="Открытые задачи с прошедшим сроком">Просрочено</th><th className="num" title="Звонки, письма, встречи и другие события в периоде">Событий</th></tr></thead>
              <tbody>
                {owners.map((o) => (
                  <tr key={o.owner ?? "-"}>
                    <td className="ellipsis">{o.owner ? memberName(lk.members, o.owner) : "Не назначено"}</td>
                    <td className="num">{integer(o.open)}</td>
                    <td className="num" title={moneyList(o.wonSums)}>{integer(o.won)}</td>
                    <td className="num">{percent(o.winRate)}</td>
                    <td className="num">{integer(o.tasksDone)}</td>
                    <td className={`num${o.overdue ? " warn-text" : ""}`}>{integer(o.overdue)}</td>
                    <td className="num">{integer(o.activities)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="faint today-empty">Сделок и задач нет.</p>}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="report-stat" role="listitem" aria-label={label}>
      <span className="faint">{label}</span>
      <b className="num">{value}</b>
      <span className="faint">{note}</span>
    </div>
  );
}

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const locale = () => (getLanguage() === "en" ? "en-US" : "ru-RU");
const monthTitle = (d: Date) => capital(d.toLocaleDateString(locale(), { month: "long", year: "numeric" }));

function bucketTitle(r: ForecastRow): string {
  if (r.bucket === "overdue") return "Дата закрытия прошла";
  if (r.bucket === "later") return "Позже";
  if (r.bucket === "none") return "Дата не указана";
  return r.month ? monthTitle(r.month) : "";
}
