// Страница коллекции: таблица записей по фильтрам коллекции, поиск и создание записи.

import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type { CrmRecord } from "../../api/types";
import { byTable, can, cellText, columnLabel, STATUS_TONE } from "../../lib/crm";
import { sameDepartment, teamOf } from "../../lib/departments";
import { integer, plural } from "../../lib/format";
import { Button, Checkbox, EmptyState, Segmented, Select, Spinner, Tag, TextInput } from "../../ui/kit";
import { confirmDialog } from "../../ui/overlay";
import { Icon } from "../../ui/icons";
import { attempt, openRecord, setSection, toast, useStore } from "../../state/store";
import { refreshTeam } from "../../state/team";
import { CrmExportDialog } from "./CrmExport";
import { ImportDialog } from "./ImportDialog";
import { useLookup, useWsQuery } from "./useCrm";

/** Типы полей, по которым есть смысл сортировать (идентификаторы связей — нет). */
const SORTABLE = ["text", "money", "number", "date", "datetime", "enum"];

export function CollectionPage() {
  const id = useStore((s) => s.collectionId);
  const ws = useStore((s) => s.ws);
  const record = useStore((s) => s.record);
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Сортировка по столбцу (щелчок по заголовку: по возрастанию → по убыванию → как задано в коллекции).
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" } | null>(null);
  // Отмеченные записи для массовых действий (держатся по идентификаторам, пока открыта коллекция).
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Удобный фильтр «чьи записи» (не право доступа: видимость задают роли, ADR-077).
  const [scope, setScope] = useState<"all" | "me" | "team" | "dept">("all");
  const team = useStore((s) => s.team);
  useEffect(() => { if (!team.length) void refreshTeam(); }, [team.length]);
  const lk = useLookup();
  const me = ws?.me ?? "";
  const [lastTable, setLastTable] = useState<string | null>(null);
  useEffect(() => { setScope("all"); setLastTable(null); }, [id]);
  const ownerField = byTable(lastTable ?? "")?.fields.find((f) => f.name === "owner_id" || f.name === "assignee_id")?.name ?? null;
  const people = useMemo(() => (scope === "me" ? [me] : scope === "team" ? [me, ...teamOf(team, me)] : scope === "dept" ? [me, ...sameDepartment(team, me)] : null), [scope, team, me]);
  const filters = useMemo(() => (people && ownerField ? [{ field: ownerField, op: "in", value: people }] : []), [people, ownerField]);
  const { data, error } = useWsQuery(() => (id ? api.wsCollectionItems(id, { search, limit: 2000, ...(filters.length ? { filters } : {}), ...(sort ? { sort: [sort] } : {}) }) : Promise.resolve(null)), [id, search, sort?.field, sort?.dir, filters]);

  const entityNow = data?.entity;
  useEffect(() => { if (entityNow) setLastTable(entityNow); }, [entityNow]);

  if (error) return <div className="page"><EmptyState icon="alert" title="Коллекция не открылась">{error}</EmptyState></div>;
  if (!data) return <div className="page"><div className="boot"><Spinner size={18} /></div></div>;
  const e = byTable(data.entity);
  if (!e) return <div className="page"><EmptyState icon="alert" title="Неизвестный тип коллекции" /></div>;
  const cols = data.collection.config.columns?.length ? data.collection.config.columns : e.columns;
  const creatable = can(ws?.permissions ?? [], "create");
  const exportable = can(ws?.permissions ?? [], "export");
  const editable = can(ws?.permissions ?? [], "edit");
  const deletable = can(ws?.permissions ?? [], "delete");
  const bulk = editable || deletable;
  const hasOwner = e.fields.some((f) => f.name === "owner_id");
  const shown = new Set(data.items.map((r) => r.id));
  const sel = picked.filter((x) => shown.has(x));
  const toggle = (rid: string, on: boolean) => setPicked((p) => (on ? [...new Set([...p, rid])] : p.filter((x) => x !== rid)));
  const all = data.items.length > 0 && sel.length === data.items.length;
  const runBulk = async (what: string, one: (rid: string) => Promise<unknown>) => {
    setBusy(true);
    let done = 0;
    for (const rid of sel) { if (await attempt(() => one(rid)) !== undefined) done += 1; }
    setBusy(false);
    setPicked([]);
    toast(`${what}: ${done} из ${sel.length}`, done === sel.length ? "success" : "error");
  };
  const assign = (owner: string) => void runBulk("Ответственный назначен", (rid) => api.wsSave(e.table, rid, { owner_id: owner === "none" ? null : owner }));
  const remove = async () => {
    const ok = await confirmDialog({ title: `Удалить записей: ${sel.length}?`, message: "Записи уйдут в корзину, их можно восстановить оттуда.", confirm: "В корзину", danger: true });
    if (ok) await runBulk("Удалено", (rid) => api.wsDelete(e.table, rid));
  };
  const grid = { ["--cols" as string]: `${bulk ? "34px " : ""}minmax(0, 1.6fr) ${cols.slice(1).map(() => "minmax(0, 1fr)").join(" ")}` };

  const cell = (r: CrmRecord, col: string, i: number) => {
    const text = cellText(e, r, col, lk);
    if (i === 0) return <span key={col} role="gridcell" className="td td-title"><span className="ellipsis crm-title">{text || e.title(r)}</span></span>;
    if (col === "status" || col === "priority") return <span key={col} role="gridcell" className="td">{text && <Tag tone={STATUS_TONE[String(r[col])] ?? "gray"}>{text}</Tag>}</span>;
    return <span key={col} role="gridcell" className="td"><span className="ellipsis muted">{text}</span></span>;
  };

  return (
    <div className="page crm-page">
      <div className="crm-bar">
        <TextInput value={search} onChange={setSearch} onClear={() => setSearch("")} icon="search" placeholder={`Поиск: ${e.many.toLowerCase()}`} wrapClass="crm-search" aria-label="Поиск в коллекции" />
        {ownerField && team.length > 1 && (
          <Segmented small value={scope} onChange={setScope} options={[{ value: "all", label: "Все" }, { value: "me", label: "Мои" }, { value: "team", label: "Моей команды" }, { value: "dept", label: "Моего отдела" }]} />
        )}
        <span className="grow" />
        {exportable && <Button icon="download" small disabled={data.total === 0} onClick={() => setExporting(true)}>Экспорт</Button>}
        {creatable && <Button icon="upload" small onClick={() => setImporting(true)}>Импорт</Button>}
        {creatable && <Button icon="plus" small onClick={() => openRecord(e.table, "new")}>{e.create}</Button>}
      </div>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {exporting && <CrmExportDialog source={{ entity: e.table, collection: { id: data.collection.id, name: data.collection.name }, query: { search, ...(filters.length ? { filters } : {}) }, total: data.total }} onClose={() => setExporting(false)} />}
      {data.items.length === 0 && !search && creatable && (e.table === "companies" || e.table === "contacts") && !data.collection.config.filters?.length ? (
        <EmptyState icon="users" title="Здесь будут ваши клиенты" action={
          <div className="empty-actions">
            <Button variant="primary" icon="upload" onClick={() => setImporting(true)}>Импорт из Excel или CSV</Button>
            <Button icon="plus" onClick={() => openRecord(e.table, "new")}>{e.create}</Button>
            <Button icon="search" onClick={() => setSection("home")}>Найти новых</Button>
          </div>
        }>
          Компании и контакты с телефонами, почтой, сделками и всей историей общения. Начните с таблицы, которая у вас уже есть.
        </EmptyState>
      ) : data.items.length === 0 ? (
        <EmptyState icon="list" title={search ? "Ничего не найдено" : "Здесь пока пусто"} action={creatable && !search ? <Button icon="plus" onClick={() => openRecord(e.table, "new")}>Создать: {e.one.toLowerCase()}</Button> : undefined}>
          {search ? "Попробуйте изменить запрос." : "Записи появятся, когда подойдут под условия коллекции. Найденный лид можно перенести в CRM из панели сведений."}
        </EmptyState>
      ) : (
        <div className="table-wrap" role="grid" aria-label={data.collection.name} aria-rowcount={data.total}>
          <div className="thead crm-row" role="row" style={grid}>
            {bulk && <span role="columnheader" className="th td-check"><Checkbox checked={all} indeterminate={sel.length > 0 && !all} onChange={(v) => setPicked(v ? data.items.map((r) => r.id) : [])} label="Выбрать все" /></span>}
            {cols.map((c) => {
              const kind = e.fields.find((f) => f.name === c)?.kind;
              if (!kind || !SORTABLE.includes(kind)) return <span key={c} role="columnheader" className="th">{columnLabel(e, c)}</span>;
              const on = sort?.field === c;
              const next = () => setSort(!on ? { field: c, dir: "asc" } : sort?.dir === "asc" ? { field: c, dir: "desc" } : null);
              return (
                <span key={c} role="columnheader" className="th-cell" aria-sort={on ? (sort?.dir === "desc" ? "descending" : "ascending") : undefined}>
                  <button type="button" className={`th${on ? " sorted" : ""}`} onClick={next}>
                    {columnLabel(e, c)}{on && <Icon name={sort?.dir === "desc" ? "arrowDown" : "arrowUp"} size={12} />}
                  </button>
                </span>
              );
            })}
          </div>
          <div className="tbody" role="rowgroup">
            {data.items.map((r) => (
              <div key={r.id} role="row" aria-selected={record?.id === r.id} className={`tr crm-row static${record?.id === r.id ? " sel" : ""}`} style={grid} onClick={() => openRecord(e.table, r.id)}>
                {bulk && <span role="gridcell" className="td td-check" onClick={(ev) => ev.stopPropagation()}><Checkbox checked={sel.includes(r.id)} onChange={(v) => toggle(r.id, v)} label={`Выбрать: ${e.title(r)}`} /></span>}
                {cols.map((c, i) => cell(r, c, i))}
              </div>
            ))}
          </div>
        </div>
      )}
      {sel.length > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Массовые действия">
          <span className="num"><b>{integer(sel.length)}</b> {plural(sel.length, "запись выбрана", "записи выбраны", "записей выбрано")}</span>
          <span className="grow" />
          {editable && hasOwner && <Select width={210} small value="" placeholder="Назначить ответственного" disabled={busy} label="Назначить ответственного"
            options={[{ value: "none", label: "Без ответственного" }, ...(ws?.members ?? []).map((m) => ({ value: m.userId, label: m.displayName || m.userId }))]} onChange={assign} />}
          {deletable && <Button small variant="danger" icon="trash" busy={busy} onClick={() => void remove()}>В корзину</Button>}
          <Button small variant="ghost" onClick={() => setPicked([])}>Снять выбор</Button>
        </div>
      )}
      <div className="statusbar">
        <span className="num">{integer(data.total)} {plural(data.total, "запись", "записи", "записей")}</span>
        <span className="grow" />
        {ws && ws.pending > 0 && <span className="faint">Ждут отправки: {integer(ws.pending)}</span>}
        {ws && ws.conflicts > 0 && <span className="faint">Конфликтов: {integer(ws.conflicts)}</span>}
      </div>
    </div>
  );
}
