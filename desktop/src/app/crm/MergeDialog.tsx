// Объединение дубликатов (пакет G4, docs/MERGE.md): выбор второй записи, сравнение различающихся полей и
// объединение. Связанные записи переносит ядро (`ws_merge`), отмена — заметка в карточке оставшейся записи.

import { useEffect, useState } from "react";
import { api } from "../../api";
import type { CrmMergeInfo, CrmRecord } from "../../api/types";
import { can, cellText, type EntityMeta, type Lookup } from "../../lib/crm";
import { defaultChoice, differences, mergeValues, union, type MergeChoice, type MergeField } from "../../lib/merge";
import { Button, Notice, Segmented, Spinner, TextInput } from "../../ui/kit";
import { Dialog } from "../../ui/overlay";
import { attempt, openRecord, toast, useStore } from "../../state/store";
import { useWsQuery } from "./useCrm";

/** Объединять могут роли, которым можно менять и удалять любые записи. */
export const canMerge = (perms: string[]) => can(perms, "edit") && can(perms, "delete");

export function MergeDialog({ e, record, lk, onClose }: { e: EntityMeta; record: CrmRecord; lk: Lookup; onClose: () => void }) {
  const [other, setOther] = useState<CrmRecord | null>(null);
  return other
    ? <Compare e={e} record={record} other={other} lk={lk} onBack={() => setOther(null)} onClose={onClose} />
    : <Pick e={e} record={record} onPick={setOther} onClose={onClose} />;
}

function Pick({ e, record, onPick, onClose }: { e: EntityMeta; record: CrmRecord; onPick: (r: CrmRecord) => void; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const { data } = useWsQuery(async () => {
    const [similar, found] = await Promise.all([
      api.wsDuplicates(e.table, record, record.id),
      query ? api.wsList(e.table, { search: query, limit: 20 }) : Promise.resolve({ items: [] as CrmRecord[], total: 0 }),
    ]);
    return { similar, found: found.items.filter((r) => r.id !== record.id && !similar.some((s) => s.id === r.id)) };
  }, [e.table, record.id, query]);

  const row = (r: CrmRecord) => (
    <li key={r.id}>
      <button type="button" className="merge-pick" onClick={() => onPick(r)}>
        <span className="ellipsis">{e.title(r)}</span>
        <span className="faint ellipsis">{[...union(r.phones, []), ...union(r.emails, [])].slice(0, 2).join(" · ")}</span>
      </button>
    </li>
  );
  return (
    <Dialog title={`Объединить: ${e.title(record)}`} onClose={onClose} width={520}>
      <div className="col" style={{ gap: 12 }}>
        <div className="muted">Выберите запись, которая дублирует эту. На следующем шаге вы решите, какие значения оставить.</div>
        <TextInput value={search} onChange={setSearch} icon="search" placeholder={`Найти: ${e.many.toLowerCase()}`} aria-label="Поиск второй записи" onClear={() => setSearch("")} />
        {!data ? <div className="boot"><Spinner size={16} /></div> : (
          <>
            {data.similar.length > 0 && <><h4 className="merge-head">Похожие</h4><ul className="merge-list" aria-label="Похожие записи">{data.similar.map(row)}</ul></>}
            {data.found.length > 0 && <><h4 className="merge-head">Найдено</h4><ul className="merge-list" aria-label="Найденные записи">{data.found.map(row)}</ul></>}
            {!data.similar.length && !data.found.length && <p className="faint">{query ? "Ничего не найдено." : "Похожих записей нет. Найдите вторую запись поиском."}</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}

function Compare({ e, record, other, lk, onBack, onClose }: { e: EntityMeta; record: CrmRecord; other: CrmRecord; lk: Lookup; onBack: () => void; onClose: () => void }) {
  // По умолчанию остаётся запись, из которой открыто окно.
  const [keepThis, setKeepThis] = useState(true);
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  const [busy, setBusy] = useState(false);
  const keep = keepThis ? record : other;
  const remove = keepThis ? other : record;
  const diffs = differences(e, keep, remove);
  const show = (d: MergeField, v: unknown) => cellText(e, { [d.field.name]: v } as CrmRecord, d.field.name, lk) || "пусто";
  const pick = (d: MergeField) => choices[d.field.name] ?? defaultChoice(d);

  const run = async () => {
    setBusy(true);
    const out = await attempt(() => api.wsMerge({ entity: e.table as "companies" | "contacts", keep: keep.id, remove: remove.id, values: mergeValues(diffs, choices) }));
    setBusy(false);
    if (!out) return;
    toast(`Объединено. К записи перешло связанных: ${out.moved}`, "success");
    openRecord(e.table, keep.id);
    onClose();
  };

  return (
    <Dialog title="Объединение записей" onClose={onClose} width={640}
      footer={<>
        <Button variant="ghost" onClick={onBack}>Назад</Button>
        <span className="grow" />
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="primary" busy={busy} onClick={() => void run()}>Объединить</Button>
      </>}>
      <div className="col" style={{ gap: 14 }}>
        <div className="merge-sides">
          <span className="faint">Остаётся</span>
          <Segmented small value={keepThis ? "this" : "other"} onChange={(v) => { setKeepThis(v === "this"); setChoices({}); }}
            options={[{ value: "this", label: e.title(record) }, { value: "other", label: e.title(other) }]} />
        </div>
        {diffs.length ? (
          <table className="merge-table" aria-label="Различающиеся поля">
            <thead><tr><th>Поле</th><th>Остаётся</th><th>Вторая запись</th></tr></thead>
            <tbody>
              {diffs.map((d) => (
                <tr key={d.field.name}>
                  <td className="faint">{d.field.label}</td>
                  {(["keep", "other"] as const).map((side) => (
                    <td key={side}>
                      <label className="merge-opt">
                        <input type="radio" name={`m-${d.field.name}`} checked={pick(d) === side} onChange={() => setChoices((c) => ({ ...c, [d.field.name]: side }))} />
                        <span className="selectable">{show(d, side === "keep" ? d.keep : d.other)}</span>
                      </label>
                      {side === "other" && d.field.kind === "list" && (
                        <label className="merge-opt">
                          <input type="radio" name={`m-${d.field.name}`} checked={pick(d) === "both"} onChange={() => setChoices((c) => ({ ...c, [d.field.name]: "both" }))} />
                          <span>Оба списка</span>
                        </label>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="faint">Значения полей совпадают или у второй записи пусто: оставшаяся запись не изменится.</p>}
        <Notice tone="info">
          Контакты, сделки, задачи, события, заметки, файлы и свои поля «{e.title(remove)}» перейдут к «{e.title(keep)}», а «{e.title(remove)}» попадёт в корзину.
          Отменить можно в карточке, пока записи не изменились и не синхронизированы.
        </Notice>
      </div>
    </Dialog>
  );
}

/** Заметка в карточке оставшейся записи: «Объединено с …» и кнопка отмены. */
export function MergeUndo({ table, id }: { table: string; id: string }) {
  const perms = useStore((s) => s.ws?.permissions ?? []);
  const { data } = useWsQuery<CrmMergeInfo | null>(() => api.wsMergeLast(), [table, id]);
  if (!data || data.keep !== id || data.entity !== table || !canMerge(perms)) return null;
  const undo = async () => {
    const out = await attempt(() => api.wsMergeUndo());
    if (out) toast(`Объединение отменено: «${out.removedTitle}» восстановлена`, "success");
  };
  return (
    <Notice tone="ok" action={<Button small onClick={() => void undo()}>Отменить</Button>}>
      Объединено с «{data.removedTitle}».
    </Notice>
  );
}
