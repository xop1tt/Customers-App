// Журнал действий (аудит UX/UI, G-02): кто и когда создал, изменил или удалил запись.
// Новых данных нет: у каждой записи ядро уже хранит автора, время и версию (`created_by`, `updated_by`, `updated_at`, `version`).
// Подробной истории по полям здесь нет — только последнее действие над записью. Раздел виден по праву «Журнал действий».

import { api } from "../../api";
import type { CrmRecord } from "../../api/types";
import { can, ENTITIES, ENTITY_TYPES, memberName } from "../../lib/crm";
import { fullRu, integer, plural } from "../../lib/format";
import { EmptyState, Spinner, Tag } from "../../ui/kit";
import { openRecord, useStore } from "../../state/store";
import { useWsQuery } from "./useCrm";

export type JournalAction = "created" | "changed" | "deleted";
export interface JournalRow { table: string; one: string; id: string; title: string; action: JournalAction; at: string; by: string | null }

const LABEL: Record<JournalAction, string> = { created: "Создано", changed: "Изменено", deleted: "Удалено" };
const TONE: Record<JournalAction, "green" | "blue" | "red"> = { created: "green", changed: "blue", deleted: "red" };

/** Последнее действие над записью: удалена, только что создана (версия 1 или совпавшие времена) или изменена. */
export function journalRow(table: string, one: string, title: string, r: CrmRecord): JournalRow {
  const deleted = typeof r.deleted_at === "string" && r.deleted_at !== "";
  const created = !deleted && (Number(r.version) <= 1 || r.created_at === r.updated_at);
  const action: JournalAction = deleted ? "deleted" : created ? "created" : "changed";
  const at = String(deleted ? r.deleted_at : r.updated_at ?? r.created_at ?? "");
  const by = (deleted || !created ? (r.updated_by ?? r.created_by) : r.created_by) as string | null | undefined;
  return { table, one, id: r.id, title: title || "Без названия", action, at, by: by ?? null };
}

export function JournalPage() {
  const ws = useStore((s) => s.ws);
  const members = useStore((s) => s.ws?.members ?? []);
  const allowed = can(ws?.permissions ?? [], "audit");
  const { data, error } = useWsQuery(async () => {
    if (!allowed) return [] as JournalRow[];
    const lists = await Promise.all(ENTITY_TYPES.map(async (t) => {
      const e = ENTITIES[t];
      const [live, gone] = await Promise.all([
        api.wsList(e.table, { limit: 200, archived: true, sort: [{ field: "updated_at", dir: "desc" }] }),
        api.wsList(e.table, { deleted: true, limit: 200, sort: [{ field: "deleted_at", dir: "desc" }] }),
      ]);
      return [...live.items, ...gone.items].map((r) => journalRow(e.table, e.one, e.title(r), r));
    }));
    return lists.flat().filter((r) => r.at).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300);
  }, [allowed]);

  if (!allowed) return <div className="page"><EmptyState icon="lock" title="Нет доступа к журналу">Журнал действий открывается по праву «Журнал действий». Попросите администратора пространства.</EmptyState></div>;
  if (error) return <div className="page"><EmptyState icon="alert" title="Журнал не открылся">{error}</EmptyState></div>;
  if (!data) return <div className="page"><div className="boot"><Spinner size={18} /></div></div>;
  const cols = { ["--cols" as string]: "minmax(0, 1.4fr) minmax(0, 0.8fr) 110px minmax(0, 1fr) minmax(0, 1fr)" };
  return (
    <div className="page crm-page">
      <div className="crm-bar"><span className="muted">Последнее действие над каждой записью: кто и когда. Подробной истории по полям нет.</span></div>
      {data.length === 0 ? (
        <EmptyState icon="clock" title="Пока пусто">Здесь появятся действия над компаниями, контактами, заявками, сделками и задачами.</EmptyState>
      ) : (
        <div className="table-wrap" role="table" aria-label="Журнал действий">
          <div className="thead crm-row" role="row" style={cols}>
            <span role="columnheader" className="th">Запись</span>
            <span role="columnheader" className="th">Тип</span>
            <span role="columnheader" className="th">Действие</span>
            <span role="columnheader" className="th">Кто</span>
            <span role="columnheader" className="th">Когда</span>
          </div>
          <div className="tbody" role="rowgroup">
            {data.map((row) => (
              <div key={`${row.table}:${row.id}`} role="row" className="tr crm-row static" style={cols} onClick={() => openRecord(row.table, row.id)}>
                <span role="cell" className="td td-title"><span className="ellipsis crm-title">{row.title}</span></span>
                <span role="cell" className="td"><Tag>{row.one}</Tag></span>
                <span role="cell" className="td"><Tag tone={TONE[row.action]}>{LABEL[row.action]}</Tag></span>
                <span role="cell" className="td"><span className="ellipsis muted">{row.by ? memberName(members, row.by) : "—"}</span></span>
                <span role="cell" className="td"><span className="ellipsis muted">{fullRu(row.at)}</span></span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="statusbar"><span className="num">{integer(data.length)} {plural(data.length, "действие", "действия", "действий")}</span></div>
    </div>
  );
}
