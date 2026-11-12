// Корзина (аудит UX/UI, G-01): удалённые компании, контакты, заявки, сделки и задачи; восстановление одной записи.
// Ядро уже умеет это: `ws_list` с `deleted: true` и `ws_restore` — новых данных и команд нет.

import { useState } from "react";
import { api } from "../../api";
import type { CrmRecord } from "../../api/types";
import { can, ENTITIES, ENTITY_TYPES } from "../../lib/crm";
import { fullRu, integer, plural } from "../../lib/format";
import { Button, EmptyState, Spinner, Tag } from "../../ui/kit";
import { attempt, toast, useStore } from "../../state/store";
import { useWsQuery } from "./useCrm";

interface Row { table: string; one: string; record: CrmRecord; title: string }

export function TrashPage() {
  const ws = useStore((s) => s.ws);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const { data, error } = useWsQuery(async () => {
    const lists = await Promise.all(ENTITY_TYPES.map(async (t) => {
      const e = ENTITIES[t];
      const r = await api.wsList(e.table, { deleted: true, limit: 500, sort: [{ field: "deleted_at", dir: "desc" }] });
      return r.items.map((record): Row => ({ table: e.table, one: e.one, record, title: e.title(record) || "Без названия" }));
    }));
    return lists.flat().sort((a, b) => String(b.record.deleted_at).localeCompare(String(a.record.deleted_at)));
  }, [tick]);

  if (error) return <div className="page"><EmptyState icon="alert" title="Корзина не открылась">{error}</EmptyState></div>;
  if (!data) return <div className="page"><div className="boot"><Spinner size={18} /></div></div>;

  const restorable = can(ws?.permissions ?? [], "delete");
  const restore = async (row: Row) => {
    setBusy(row.record.id);
    const ok = await attempt(() => api.wsRestore(row.table, row.record.id));
    setBusy(null);
    if (ok) { toast(`${row.one}: восстановлено`, "success"); setTick((n) => n + 1); }
  };

  return (
    <div className="page crm-page">
      <div className="crm-bar"><span className="muted">Удалённые записи можно вернуть.</span></div>
      {data.length === 0 ? (
        <EmptyState icon="trash" title="Корзина пуста">Удалённые компании, контакты, заявки, сделки и задачи появятся здесь, и их можно будет восстановить.</EmptyState>
      ) : (
        <div className="table-wrap" role="table" aria-label="Корзина">
          <div className="thead crm-row" role="row" style={{ ["--cols" as string]: "minmax(0, 1.6fr) minmax(0, 0.8fr) minmax(0, 1fr) 140px" }}>
            <span role="columnheader" className="th">Название</span>
            <span role="columnheader" className="th">Тип</span>
            <span role="columnheader" className="th">Удалено</span>
            <span role="columnheader" className="th"><span className="sr-only">Действия</span></span>
          </div>
          <div className="tbody" role="rowgroup">
            {data.map((row) => (
              <div key={`${row.table}:${row.record.id}`} role="row" className="tr crm-row static" style={{ ["--cols" as string]: "minmax(0, 1.6fr) minmax(0, 0.8fr) minmax(0, 1fr) 140px" }}>
                <span role="cell" className="td td-title"><span className="ellipsis crm-title">{row.title}</span></span>
                <span role="cell" className="td"><Tag>{row.one}</Tag></span>
                <span role="cell" className="td"><span className="ellipsis muted">{fullRu(String(row.record.deleted_at))}</span></span>
                <span role="cell" className="td">
                  <Button small icon="refresh" busy={busy === row.record.id} disabled={!restorable} onClick={() => void restore(row)}>Восстановить</Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="statusbar"><span className="num">{integer(data.length)} {plural(data.length, "запись", "записи", "записей")}</span></div>
    </div>
  );
}
