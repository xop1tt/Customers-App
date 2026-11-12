// «Журнал действий»: кто и что менял в рабочем пространстве (право audit.view). Данные уже пишет база.

import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { WsAuditItem } from "../../api/types";
import { actionText, AUDIT_ACTIONS, detailText, entityText } from "../../lib/audit";
import { memberName } from "../../lib/crm";
import { fullRu } from "../../lib/format";
import { Button, EmptyState, Notice, Select, Spinner } from "../../ui/kit";
import { Dialog } from "../../ui/overlay";
import { useStore } from "../../state/store";

export function AuditDialog({ onClose }: { onClose: () => void }) {
  const members = useStore((s) => s.ws?.members ?? []);
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [items, setItems] = useState<WsAuditItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (offset: number) => {
    setBusy(true); setError(null);
    try {
      const r = await api.wsAudit({ actor: actor || null, action: action || null, offset });
      setItems((cur) => (offset ? [...(cur ?? []), ...r.items] : r.items));
      setMore(r.more);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Журнал не открылся.");
      if (!offset) setItems([]);
    }
    setBusy(false);
  }, [actor, action]);
  useEffect(() => { void load(0); }, [load]);

  return (
    <Dialog title="Журнал рабочего пространства" onClose={onClose} width={640}>
      <div className="col" style={{ gap: 12, alignItems: "stretch" }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Select value={actor} onChange={setActor} label="Сотрудник" width={220} options={[{ value: "", label: "Все сотрудники" }, ...members.map((m) => ({ value: m.userId, label: m.displayName }))]} />
          <Select value={action} onChange={setAction} label="Действие" width={260} options={[{ value: "", label: "Все действия" }, ...AUDIT_ACTIONS.map((a) => ({ value: a, label: actionText(a) }))]} />
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {items === null ? <div className="center-fill"><Spinner /></div> : items.length === 0 && !error ? (
          <EmptyState icon="history" title="Записей нет">Здесь появятся удаления, смены ответственного, изменения участников и ролей.</EmptyState>
        ) : (
          <ul className="audit-list" aria-label="Журнал действий" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((i) => {
              const detail = detailText(i, members);
              return (
                <li key={i.id} className="col" style={{ gap: 2 }}>
                  <span><strong>{i.actor_id ? memberName(members, i.actor_id) : "Система"}</strong> {actionText(i.action)}{i.entity_type && !i.action.startsWith("member_") ? ` · ${entityText(i.entity_type)}` : ""}</span>
                  <span className="faint">{fullRu(i.at)}{detail ? ` · ${detail}` : ""}</span>
                </li>
              );
            })}
          </ul>
        )}
        {more && <div><Button small busy={busy} onClick={() => void load(items?.length ?? 0)}>Показать ещё</Button></div>}
      </div>
    </Dialog>
  );
}
