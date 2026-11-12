import { SECTIONS } from "../../lib/leads";
import { fullRu, plural } from "../../lib/format";
import { sourceTitle } from "../../lib/sources";
import { EmptyState, Tag } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { useStore } from "../../state/store";

export function RunsPage() {
  const log = useStore((s) => s.snap.syncLog);
  const errors = useStore((s) => s.snap.pipelineErrors);
  const report = useStore((s) => s.search.lastReport);
  return (
    <div className="page scroll">
      <div className="runs">
        <section className="panel">
          <header className="panel-head"><h3>{SECTIONS.runs.title}</h3></header>
          {log.length === 0 ? (
            <EmptyState icon="history" title="Поисков ещё не было">После первого запуска здесь появятся результаты каждого поиска.</EmptyState>
          ) : (
            <ul className="run-list">
              {log.map((r) => (
                <li key={r.id} className="run">
                  <Icon name={r.ok ? "check" : "alert"} size={15} className={r.ok ? "ok" : "bad"} />
                  <div className="col grow" style={{ gap: 2 }}>
                    <span className="selectable">{r.message}</span>
                    <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{fullRu(r.at)}</span>
                  </div>
                  {(r.added > 0 || r.updated > 0) && <Tag tone="green">+{r.added}{r.updated > 0 ? ` · обн. ${r.updated}` : ""}</Tag>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="col" style={{ gap: 16 }}>
          {report && (
            <section className="panel">
              <header className="panel-head"><h3>Последний запуск по источникам</h3></header>
              <ul className="run-list">
                {report.sources.map((s) => (
                  <li key={s.source} className="run">
                    <Icon name={s.failed ? "alert" : "check"} size={15} className={s.failed ? "bad" : "ok"} />
                    <div className="col grow" style={{ gap: 2 }}>
                      <span>{sourceTitle(s.source)}</span>
                      <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
                        {s.skipped ? s.skipped : `найдено ${s.found}, новых ${s.added}, обновлено ${s.updated}, повторов ${s.duplicates}`}
                      </span>
                      {s.errors.map((e) => <span key={e} className="bad-text selectable" style={{ fontSize: "var(--fs-sm)" }}>{e}</span>)}
                      {s.warnings.map((e) => <span key={e} className="warn-text selectable" style={{ fontSize: "var(--fs-sm)" }}>{e}</span>)}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="panel">
            <header className="panel-head"><h3>Ошибки</h3><span className="grow" /><span className="faint num">{errors.length} {plural(errors.length, "запись", "записи", "записей")}</span></header>
            {errors.length === 0 ? <p className="faint panel-empty">Ошибок нет.</p> : (
              <ul className="run-list">
                {errors.map((e) => (
                  <li key={e.id} className="run">
                    <Icon name="alert" size={15} className="bad" />
                    <div className="col grow" style={{ gap: 2 }}>
                      <span className="selectable">{e.message}</span>
                      <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{sourceTitle(e.module)} · {fullRu(e.at)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
