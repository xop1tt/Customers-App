// Экспорт записей CRM в файл CSV или Excel (пакет G1, docs/EXPORT.md): формат, выбор колонок, сохранение.
// Выгружается то же, что показывает список: условия коллекции и строка поиска.

import { useEffect, useState } from "react";
import { api } from "../../api";
import type { CrmExportField, CrmExportFormat, WsQuery } from "../../api/types";
import { byTable } from "../../lib/crm";
import { integer, plural } from "../../lib/format";
import { getLanguage } from "../../lib/i18n";
import { pickSavePath } from "../../lib/platform";
import { Button, Checkbox, Segmented, SettingRow, Spinner } from "../../ui/kit";
import { Dialog } from "../../ui/overlay";
import { attempt, toast } from "../../state/store";

export interface CrmExportSource {
  /** Таблица записей: `companies`, `contacts`, `deals`, `tasks`, `crm_leads`. */
  entity: string;
  collection?: { id: string; name: string } | null;
  /** Поиск и фильтры пользователя поверх коллекции. */
  query?: WsQuery;
  /** Сколько записей сейчас в списке. */
  total: number;
}

/** Имя файла: «Все клиенты 2026-11-11.xlsx» — без знаков, запрещённых в именах файлов Windows. */
export function exportFileName(title: string, format: CrmExportFormat, today = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  const safe = title.replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "CRM";
  return `${safe} ${day}.${format}`;
}

export function CrmExportDialog({ source, onClose }: { source: CrmExportSource; onClose: () => void }) {
  const e = byTable(source.entity);
  const [fields, setFields] = useState<CrmExportField[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [format, setFormat] = useState<CrmExportFormat>("xlsx");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void attempt(() => api.wsExportFields(source.entity, getLanguage())).then((f) => {
      if (!live || !f) return;
      setFields(f);
      setChosen(f.filter((x) => x.default).map((x) => x.key));
    });
    return () => { live = false; };
  }, [source.entity]);

  const title = source.collection?.name ?? e?.many ?? "CRM";
  const search = source.query?.search?.trim();
  const run = async () => {
    const path = await pickSavePath("Сохранить записи", exportFileName(title, format), format);
    if (!path) return;
    setBusy(true);
    const r = await attempt(() => api.wsExport({ entity: source.entity, collection: source.collection?.id ?? null, query: source.query, format, fields: chosen, lang: getLanguage() }, path));
    setBusy(false);
    if (r) { toast(`Сохранено записей: ${integer(r.count)}`, "success"); onClose(); }
  };
  const toggle = (key: string, on: boolean) => setChosen(on ? [...chosen, key] : chosen.filter((k) => k !== key));
  const group = (list: CrmExportField[]) => (
    <div className="field-grid">
      {list.map((f) => <Checkbox key={f.key} checked={chosen.includes(f.key)} onChange={(v) => toggle(f.key, v)} label={f.title} />)}
    </div>
  );
  const own = fields?.filter((f) => f.custom) ?? [];

  return (
    <Dialog title={`Экспорт: ${integer(source.total)} ${plural(source.total, "запись", "записи", "записей")}`} onClose={onClose} width={640}>
      <div className="col" style={{ gap: 14 }}>
        <div className="muted">{search ? `В файл попадёт то, что сейчас показывает список, с учётом поиска «${search}».` : "В файл попадёт то, что сейчас показывает список."}</div>
        <SettingRow title="Формат" hint="Excel сохраняет числа и даты, CSV открывает любая программа. Оба файла можно загрузить обратно через «Импорт».">
          <Segmented value={format} onChange={setFormat} options={[{ value: "xlsx", label: "Excel" }, { value: "csv", label: "CSV" }]} />
        </SettingRow>
        {!fields ? <div className="boot"><Spinner size={18} /></div> : (
          <div className="col" style={{ gap: 10 }}>
            <div className="row">
              <strong>Колонки</strong><span className="grow" />
              <Button small variant="ghost" onClick={() => setChosen(fields.map((f) => f.key))}>Все</Button>
              <Button small variant="ghost" onClick={() => setChosen(fields.filter((f) => f.default).map((f) => f.key))}>По умолчанию</Button>
            </div>
            {group(fields.filter((f) => !f.custom))}
            {own.length > 0 && <><strong>Свои поля</strong>{group(own)}</>}
          </div>
        )}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button variant="primary" icon="download" busy={busy} disabled={!fields || chosen.length === 0 || source.total === 0} onClick={() => void run()}>Сохранить файл…</Button>
        </div>
      </div>
    </Dialog>
  );
}
