import { useMemo } from "react";
import { dailyCounts, isNew, SECTIONS, count } from "../../lib/leads";
import { dateOnly, dayShort, integer, plural, shortRelative } from "../../lib/format";
import { SOURCES, sourceItemCount, sourceSettings } from "../../lib/sources";
import { Button, EmptyState, Notice, Score, Tag } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { select, setSection, useStore } from "../../state/store";
import { startSearch } from "../../state/actions";

function Kpi({ label, value, hint, onClick }: { label: string; value: string; hint?: string; onClick?: () => void }) {
  return (
    <button type="button" className="kpi" onClick={onClick} disabled={!onClick}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value num">{value}</span>
      {hint && <span className="kpi-hint faint ellipsis">{hint}</span>}
    </button>
  );
}

export function HomePage() {
  const leads = useStore((s) => s.snap.leads);
  const sources = useStore((s) => s.snap.sources);
  const errors = useStore((s) => s.snap.pipelineErrors);
  const lastSearchAt = useStore((s) => s.snap.lastSearchAt);
  const overview = useStore((s) => s.overview);
  const search = useStore((s) => s.search);

  const fresh = useMemo(() => leads.filter(isNew).sort((a, b) => b.data.score - a.data.score), [leads]);
  const series = useMemo(() => dailyCounts(leads, 14), [leads]);
  const max = Math.max(4, ...series.map((p) => p.orders + p.organizations));
  const total = count(leads, "all", true);

  const openLead = (id: string) => {
    setSection("new");
    select([id], id);
  };

  if (leads.length === 0 && !search.running) {
    return (
      <div className="page scroll">
        <div className="home-empty">
          <EmptyState icon="search" title="Начнём с первого поиска" action={<Button variant="primary" icon="search" onClick={() => void startSearch()}>Найти лиды</Button>}>
            Приложение проверит включённые источники и покажет подходящих заказчиков и организации. Источники можно настроить в разделе «Источники».
          </EmptyState>
          <Button variant="ghost" icon="database" onClick={() => setSection("sources")}>Настроить источники</Button>
        </div>
      </div>
    );
  }

  const chartW = 560;
  const chartH = 150;
  const bw = chartW / series.length;

  return (
    <div className="page scroll">
      <div className="home">
        <div className="kpis">
          <Kpi label="Новые" value={integer(fresh.length)} hint={fresh.length ? "ещё не просмотрены" : "всё просмотрено"} onClick={() => setSection("new")} />
          <Kpi label="Все лиды" value={integer(total)} hint="в рабочем списке" onClick={() => setSection("all")} />
          <Kpi label="Избранное" value={integer(count(leads, "favorites", true))} hint="отмеченные звёздочкой" onClick={() => setSection("favorites")} />
          <Kpi label="Последний поиск" value={lastSearchAt ? shortRelative(lastSearchAt) : "—"} hint={overview && overview.autoSearchMinutes > 0 ? `автопоиск каждые ${overview.autoSearchMinutes} мин` : "автопоиск выключен"} onClick={() => setSection("runs")} />
        </div>

        <div className="home-grid">
          <section className="panel">
            <header className="panel-head"><h3>Лучшие новые лиды</h3><span className="grow" /><Button small variant="ghost" onClick={() => setSection("new")}>Все новые</Button></header>
            {fresh.length === 0 ? (
              <p className="faint panel-empty">Новых лидов нет. Запустите поиск, чтобы найти свежие.</p>
            ) : (
              <ul className="top-list">
                {fresh.slice(0, 6).map((l) => (
                  <li key={l.id}>
                    <button type="button" className="top-item" onClick={() => openLead(l.id)}>
                      <Score value={l.data.score} />
                      <span className="col grow" style={{ gap: 1 }}>
                        <span className="ellipsis">{l.data.title}</span>
                        <span className="ellipsis faint" style={{ fontSize: "var(--fs-sm)" }}>{[l.data.region, l.data.budget !== undefined ? `${integer(l.data.budget)} ₽` : null].filter(Boolean).join(" · ") || (l.data.kind === "order" ? "Заказ" : "Организация")}</span>
                      </span>
                      <span className="faint num">{shortRelative(l.discoveredAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel">
            <header className="panel-head"><h3>Новые за 14 дней</h3><span className="grow" /><span className="legend"><i className="lg lg-order" />Заказы</span><span className="legend"><i className="lg lg-org" />Организации</span></header>
            <svg className="chart" viewBox={`0 0 ${chartW} ${chartH + 22}`} role="img" aria-label="Количество новых лидов по дням" preserveAspectRatio="none">
              {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1="0" x2={chartW} y1={chartH - chartH * f} y2={chartH - chartH * f} className="chart-grid" />)}
              {series.map((p, i) => {
                const oh = (p.orders / max) * chartH;
                const gh = (p.organizations / max) * chartH;
                const x = i * bw + bw * 0.18;
                const w = bw * 0.64;
                return (
                  <g key={i}>
                    <title>{`${dateOnly(p.day.toISOString())}: заказов ${p.orders}, организаций ${p.organizations}`}</title>
                    <rect x={x} y={chartH - oh - gh} width={w} height={gh} className="bar-org" rx="2" />
                    <rect x={x} y={chartH - oh} width={w} height={oh} className="bar-order" rx="2" />
                    {(i === 0 || i === series.length - 1 || i === 7) && <text x={x + w / 2} y={chartH + 16} className="chart-label" textAnchor="middle">{dayShort(p.day)}</text>}
                  </g>
                );
              })}
            </svg>
          </section>

          <section className="panel">
            <header className="panel-head"><h3>Источники</h3><span className="grow" /><Button small variant="ghost" onClick={() => setSection("sources")}>Настроить</Button></header>
            <ul className="src-list">
              {SOURCES.map((m) => {
                const st = sources.find((s) => s.source === m.key);
                const cfg = overview ? sourceSettings(overview.settings, m.group) : null;
                const enabled = cfg?.enabled ?? false;
                const problem = overview?.problems[m.key];
                const tone = !enabled ? "gray" : problem || st?.status === "failed" ? "red" : st?.status === "partial" ? "orange" : st?.last_success_at ? "green" : "gray";
                return (
                  <li key={m.key} className="src-item">
                    <Icon name={m.icon} size={16} className="faint" />
                    <span className="col grow" style={{ gap: 1 }}>
                      <span className="ellipsis">{m.title}</span>
                      <span className="ellipsis faint" style={{ fontSize: "var(--fs-sm)" }}>
                        {!enabled ? "Выключен" : problem ? problem : st?.last_success_at ? `Успешно ${shortRelative(st.last_success_at)}` : "Ещё не запускался"}
                        {overview && enabled ? ` · ${sourceItemCount(overview.settings, m.group)} ${plural(sourceItemCount(overview.settings, m.group), "запись", "записи", "записей")}` : ""}
                      </span>
                    </span>
                    <Tag tone={tone}>{!enabled ? "выкл" : tone === "red" ? "ошибка" : tone === "orange" ? "частично" : tone === "green" ? "ок" : "—"}</Tag>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="panel">
            <header className="panel-head"><h3>Недавние ошибки</h3><span className="grow" /><Button small variant="ghost" onClick={() => setSection("runs")}>{SECTIONS.runs.title}</Button></header>
            {errors.length === 0 ? (
              <p className="faint panel-empty">Ошибок нет.</p>
            ) : (
              <ul className="err-list">
                {errors.slice(0, 4).map((e) => (
                  <li key={e.id}><Icon name="alert" size={14} /><span className="col grow" style={{ gap: 1 }}><span className="clamp2">{e.message}</span><span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{shortRelative(e.at)}</span></span></li>
                ))}
              </ul>
            )}
          </section>
        </div>
        {search.running && <Notice tone="info">{search.progress ?? "Идёт поиск…"}</Notice>}
      </div>
    </div>
  );
}
