// Страница коллекции: таблица записей по фильтрам коллекции, поиск и создание записи.

import { useState } from "react";
import { api } from "../../api";
import type { CrmRecord } from "../../api/types";
import { byTable, can, cellText, columnLabel, STATUS_TONE } from "../../lib/crm";
import { integer, plural } from "../../lib/format";
import { Button, EmptyState, Spinner, Tag, TextInput } from "../../ui/kit";
import { openRecord, setSection, useStore } from "../../state/store";
import { CrmExportDialog } from "./CrmExport";
import { ImportDialog } from "./ImportDialog";
import { useLookup, useWsQuery } from "./useCrm";

export function CollectionPage() {
  const id = useStore((s) => s.collectionId);
  const ws = useStore((s) => s.ws);
  const record = useStore((s) => s.record);
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const lk = useLookup();
  const { data, error } = useWsQuery(() => (id ? api.wsCollectionItems(id, { search, limit: 2000 }) : Promise.resolve(null)), [id, search]);

  if (error) return <div className="page"><EmptyState icon="alert" title="Коллекция не открылась">{error}</EmptyState></div>;
  if (!data) return <div className="page"><div className="boot"><Spinner size={18} /></div></div>;
  const e = byTable(data.entity);
  if (!e) return <div className="page"><EmptyState icon="alert" title="Неизвестный тип коллекции" /></div>;
  const cols = data.collection.config.columns?.length ? data.collection.config.columns : e.columns;
  const creatable = can(ws?.permissions ?? [], "create");
  const exportable = can(ws?.permissions ?? [], "export");
  const grid = { ["--cols" as string]: `minmax(0, 1.6fr) ${cols.slice(1).map(() => "minmax(0, 1fr)").join(" ")}` };

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
        <span className="grow" />
        {exportable && <Button icon="download" small disabled={data.total === 0} onClick={() => setExporting(true)}>Экспорт</Button>}
        {creatable && <Button icon="upload" small onClick={() => setImporting(true)}>Импорт</Button>}
        {creatable && <Button icon="plus" small onClick={() => openRecord(e.table, "new")}>{e.one}</Button>}
      </div>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {exporting && <CrmExportDialog source={{ entity: e.table, collection: { id: data.collection.id, name: data.collection.name }, query: { search }, total: data.total }} onClose={() => setExporting(false)} />}
      {data.items.length === 0 && !search && creatable && (e.table === "companies" || e.table === "contacts") && !data.collection.config.filters?.length ? (
        <EmptyState icon="users" title="Здесь будут ваши клиенты" action={
          <div className="empty-actions">
            <Button variant="primary" icon="upload" onClick={() => setImporting(true)}>Импорт из Excel или CSV</Button>
            <Button icon="plus" onClick={() => openRecord(e.table, "new")}>{e.one}</Button>
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
            {cols.map((c) => <span key={c} role="columnheader" className="th">{columnLabel(e, c)}</span>)}
          </div>
          <div className="tbody" role="rowgroup">
            {data.items.map((r) => (
              <div key={r.id} role="row" aria-selected={record?.id === r.id} className={`tr crm-row static${record?.id === r.id ? " sel" : ""}`} style={grid} onClick={() => openRecord(e.table, r.id)}>
                {cols.map((c, i) => cell(r, c, i))}
              </div>
            ))}
          </div>
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
