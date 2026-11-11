// Отчёты (этап 2): итоги периода, воронка с конверсиями, причины проигрыша и итоги по ответственным.

import { useState } from "react";
import { api } from "../../api";
import { memberName } from "../../lib/crm";
import { integer, money, plural } from "../../lib/format";
import { byOwner, funnel, lostReasons, percent, periodStart, summary, type Period } from "../../lib/reports";
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
    const [deals, history] = await Promise.all([api.wsList("deals", { limit: 5000 }), api.wsStageHistory()]);
    return { deals: deals.items, history };
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
  const owners = byOwner(data.deals, pipe.id, from);
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
      </div>

      <div className="report-grid">
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

        <section className="today-card" aria-label="По ответственным">
          <h3>По ответственным</h3>
          {owners.length ? (
            <table className="report-table">
              <thead><tr><th>Ответственный</th><th className="num">В работе</th><th className="num">Выиграно</th><th className="num" title="Доля выигранных среди закрытых">Доля успеха</th></tr></thead>
              <tbody>
                {owners.map((o) => (
                  <tr key={o.owner ?? "-"}>
                    <td className="ellipsis">{o.owner ? memberName(lk.members, o.owner) : "Без ответственного"}</td>
                    <td className="num">{integer(o.open)}</td>
                    <td className="num" title={moneyList(o.wonSums)}>{integer(o.won)}</td>
                    <td className="num">{percent(o.winRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="faint today-empty">Сделок нет.</p>}
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
