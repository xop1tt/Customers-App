// Канбан сделок (пакет B2): колонки этапов воронки, суммы, перенос сделки перетаскиванием или из меню.

import { notifyEvent } from "../../state/hub";
import { stageMessage } from "../../lib/hub";
import { useMemo, useState } from "react";
import { api } from "../../api";
import type { CrmRecord } from "../../api/types";
import { boardColumns, canMove } from "../../lib/board";
import { can, memberName } from "../../lib/crm";
import { nextActions, type NextAction } from "../../lib/comms";
import { integer, money, plural, shortRelative } from "../../lib/format";
import { t } from "../../lib/i18n";
import { Button, EmptyState, IconButton, Select, Spinner } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { showMenu } from "../../ui/overlay";
import { attempt, openRecord, setSection, setState, useStore } from "../../state/store";
import { CrmExportDialog } from "./CrmExport";
import { useLookup, useWsQuery } from "./useCrm";

export function DealBoard() {
  const ws = useStore((s) => s.ws);
  const record = useStore((s) => s.record);
  const lk = useLookup();
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ deal: CrmRecord; over: string | null } | null>(null);
  const [tick, setTick] = useState(0);
  const [exporting, setExporting] = useState(false);
  const { data: deals, error } = useWsQuery(() => api.wsList("deals", { limit: 5000 }).then((r) => r.items), [tick]);
  // Следующее действие по сделкам (G6): открытые задачи, привязанные к сделкам.
  const { data: dealTasks } = useWsQuery(
    () => api.wsList("tasks", { filters: [{ field: "entity_type", op: "eq", value: "deal" }, { field: "status", op: "in", value: ["todo", "in_progress"] }], limit: 5000 }).then((r) => r.items),
    [tick],
  );
  const next = useMemo(() => nextActions(dealTasks ?? []), [dealTasks]);

  const pipes = [...lk.pipelines.values()].filter((p) => !p.deleted_at);
  const pipe = pipes.find((p) => p.id === pipelineId) ?? pipes.find((p) => p.is_default) ?? pipes[0];
  if (error) return <div className="page"><EmptyState icon="alert" title="Сделки не загрузились">{error}</EmptyState></div>;
  if (!deals || !lk.stages.size) return <div className="page"><div className="boot"><Spinner size={18} /></div></div>;
  if (!pipe) return <div className="page"><EmptyState icon="list" title="Нет воронки">Создайте воронку в настройках рабочего пространства.</EmptyState></div>;

  const perms = ws?.permissions ?? [];
  const me = ws?.me;
  const cols = boardColumns([...lk.stages.values()], deals, pipe.id);
  const open = cols.flatMap((c) => (c.stage.kind === "open" ? c.deals : []));
  const inPipe = cols.reduce((n, c) => n + c.deals.length, 0);
  const openSum = open.reduce((n, d) => n + (typeof d.amount === "number" && (!d.currency || d.currency === "RUB") ? d.amount : 0), 0);

  const moveTo = async (deal: CrmRecord, stage: CrmRecord) => {
    if (!canMove(deal, stage)) return;
    if (await attempt(() => api.wsSave("deals", deal.id, { stage_id: stage.id }))) {
      setTick((t) => t + 1);
      void notifyEvent("deal.stage_changed", stageMessage(String(deal.title ?? deal.name ?? "Сделка"), String(stage.name), typeof deal.amount === "number" ? deal.amount : null, typeof deal.currency === "string" ? deal.currency : null));
    }
  };
  const stageMenu = (deal: CrmRecord, anchor: DOMRect) =>
    showMenu(cols.map((c) => ({ label: String(c.stage.name), icon: c.stage.id === deal.stage_id ? "check" : undefined, disabled: !canMove(deal, c.stage), onSelect: () => void moveTo(deal, c.stage) })), anchor);

  return (
    <div className="page crm-page">
      <div className="crm-bar">
        {pipes.length > 1 && <Select small value={pipe.id} options={pipes.map((p) => ({ value: p.id, label: String(p.name) }))} onChange={setPipelineId} label="Воронка" />}
        <span className="muted">{integer(open.length)} {plural(open.length, "открытая сделка", "открытые сделки", "открытых сделок")}{openSum ? ` · ${money(openSum)}` : ""}</span>
        <span className="grow" />
        {can(perms, "export") && <Button icon="download" small disabled={inPipe === 0} onClick={() => setExporting(true)}>Экспорт</Button>}
        {can(perms, "create") && <Button icon="plus" small onClick={() => openRecord("deals", "new")}>Новая сделка</Button>}
      </div>
      {exporting && <CrmExportDialog source={{ entity: "deals", query: { filters: [{ field: "pipeline_id", op: "eq", value: pipe.id }] }, total: inPipe }} onClose={() => setExporting(false)} />}
      {deals.filter((d) => !d.deleted_at).length === 0 ? (
        <EmptyState icon="chart" title="Сделок пока нет" action={
          <div className="empty-actions">
            {can(perms, "create") && <Button variant="primary" icon="plus" onClick={() => openRecord("deals", "new")}>Новая сделка</Button>}
            <Button onClick={() => setSection("new")}>Открыть лиды</Button>
            <Button variant="ghost" onClick={() => setState({ workspaceOpen: true })}>Настроить этапы</Button>
          </div>
        }>
          Сделка — это продажа клиенту: сумма, этап и следующий шаг. Создайте первую вручную или из лида поиска.
        </EmptyState>
      ) : (
      <div className="board" role="list" aria-label={`Воронка ${String(pipe.name)}`}>
        {cols.map((c) => (
          <div
            key={c.stage.id}
            role="listitem"
            aria-label={String(c.stage.name)}
            className={`board-col ${String(c.stage.kind ?? "open")}${drag?.over === c.stage.id ? " drop" : ""}`}
            onDragOver={(e) => { if (drag && canMove(drag.deal, c.stage)) { e.preventDefault(); if (drag.over !== c.stage.id) setDrag({ ...drag, over: c.stage.id }); } }}
            onDragLeave={() => { if (drag?.over === c.stage.id) setDrag({ ...drag, over: null }); }}
            onDrop={(e) => { e.preventDefault(); if (drag) void moveTo(drag.deal, c.stage); setDrag(null); }}
          >
            <header className="board-head">
              <span className="ellipsis grow">{String(c.stage.name)}</span>
              <span className="faint num">{integer(c.deals.length)}</span>
            </header>
            {c.totals.length > 0 && <div className="board-sum num">{c.totals.map(([cur, n]) => money(n, cur)).join(" · ")}</div>}
            <div className="board-cards">
              {c.deals.map((d) => {
                const editable = can(perms, "edit", d, me);
                const company = d.company_id ? lk.companies.get(String(d.company_id)) : undefined;
                return (
                  <article
                    key={d.id}
                    className={`board-card${record?.id === d.id ? " sel" : ""}${drag?.deal.id === d.id ? " dragging" : ""}`}
                    draggable={editable}
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", d.id); setDrag({ deal: d, over: null }); }}
                    onDragEnd={() => setDrag(null)}
                  >
                    <button type="button" className="board-open" onClick={() => openRecord("deals", d.id)}>
                      <span className="board-title">{String(d.title || "Без названия")}</span>
                      {company && <span className="faint ellipsis">{String(company.name)}</span>}
                      <span className="row board-meta">
                        {typeof d.amount === "number" && <span className="num">{money(d.amount, String(d.currency || "RUB"))}</span>}
                        <span className="grow" />
                        {d.owner_id ? <span className="faint ellipsis">{memberName(lk.members, d.owner_id)}</span> : null}
                      </span>
                      {c.stage.kind === "open" && dealTasks && <NextLine n={next.get(d.id)} />}
                    </button>
                    {editable && <IconButton icon="chevronDown" size={14} tip="Сменить этап" className="board-move" onClick={(e) => stageMenu(d, e.currentTarget.getBoundingClientRect())} />}
                  </article>
                );
              })}
              {!c.deals.length && <p className="faint board-empty">Нет сделок</p>}
            </div>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}

/** Строка «следующий шаг» на карточке открытой сделки: ближайшая задача или предупреждение. */
function NextLine({ n }: { n: NextAction | undefined }) {
  if (!n) return <span className="board-next warn" title={t("Нет запланированной задачи по сделке")}><Icon name="alert" size={12} /> {t("Нет следующего шага")}</span>;
  const when = n.dated ? shortRelative(String(n.task.due_at)) : t("без срока");
  return (
    <span className={`board-next${n.overdue ? " bad" : ""}`}>
      <Icon name="calendar" size={12} /> <span className="ellipsis">{String(n.task.title)}</span> <span className="faint">· {when}</span>
    </span>
  );
}
