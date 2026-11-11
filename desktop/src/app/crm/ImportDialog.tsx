// Импорт клиентов из CSV или Excel: файл → сопоставление колонок → проверка → результат с отменой.

import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { ImportBatch, ImportDuplicates, ImportFile, ImportPreview, ImportResult, ImportRowPreview } from "../../api/types";
import { fullRu, integer, plural } from "../../lib/format";
import { Button, Notice, Segmented, Select, Tag } from "../../ui/kit";
import { Dialog } from "../../ui/overlay";
import { attempt, toast } from "../../state/store";

export const MAX_IMPORT = 10 * 1024 * 1024;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("Файл не читается."));
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.readAsDataURL(file);
  });
}

const STATUS: Record<ImportRowPreview["status"], { label: string; tone: "gray" | "red" | "green" | "blue" }> = {
  new: { label: "Новая", tone: "green" },
  existing: { label: "Уже есть", tone: "blue" },
  skip: { label: "Пропуск", tone: "gray" },
  empty: { label: "Пустая", tone: "gray" },
  error: { label: "Ошибка", tone: "red" },
};

function summaryText(s: { companies: number; contacts: number; deals: number }): string {
  return [
    `${integer(s.companies)} ${plural(s.companies, "компания", "компании", "компаний")}`,
    `${integer(s.contacts)} ${plural(s.contacts, "контакт", "контакта", "контактов")}`,
    `${integer(s.deals)} ${plural(s.deals, "сделка", "сделки", "сделок")}`,
  ].join(", ");
}

type Step = "file" | "map" | "check" | "done";

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("file");
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [info, setInfo] = useState<ImportFile | null>(null);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [duplicates, setDuplicates] = useState<ImportDuplicates>("link");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [history, setHistory] = useState<ImportBatch[]>([]);

  const loadHistory = () => void api.wsImportHistory().then(setHistory, () => setHistory([]));
  useEffect(loadHistory, []);

  const options = { mapping, duplicates };
  const pick = async (files: FileList | null) => {
    const f = files?.[0];
    if (input.current) input.current.value = "";
    if (!f) return;
    if (f.size > MAX_IMPORT) { toast("Файл больше 10 МБ.", "error"); return; }
    setBusy(true);
    try {
      const data = await readBase64(f);
      const read = await attempt(() => api.wsImportRead(f.name, data));
      if (read) { setFile({ name: f.name, data }); setInfo(read); setMapping(read.mapping); setStep("map"); }
    } finally { setBusy(false); }
  };
  const check = async () => {
    if (!file) return;
    setBusy(true);
    const p = await attempt(() => api.wsImportPreview(file.name, file.data, options));
    setBusy(false);
    if (p) { setPreview(p); setStep("check"); }
  };
  const run = async () => {
    if (!file) return;
    setBusy(true);
    const r = await attempt(() => api.wsImportRun(file.name, file.data, options));
    setBusy(false);
    if (r) { setResult(r); setStep("done"); loadHistory(); }
  };
  const undo = async (batch: string) => {
    setBusy(true);
    const r = await attempt(() => api.wsImportUndo(batch));
    setBusy(false);
    if (!r) return;
    toast(r.alreadyUndone ? "Этот импорт уже отменён" : `Импорт отменён, удалено записей: ${integer(r.removed)}`, "success");
    loadHistory();
    if (result?.batchId === batch) setResult({ ...result, batchId: null });
  };

  const mapped = mapping.filter(Boolean).length;
  const fieldOptions = [{ value: "", label: "Не импортировать" }, ...(info?.fields ?? []).map((f) => ({ value: f.key, label: f.label }))];
  const setField = (i: number, v: string) => setMapping((m) => m.map((x, j) => (j === i ? v || null : v && x === v ? null : x)));

  const footer = {
    file: <Button variant="ghost" onClick={onClose}>Закрыть</Button>,
    map: <>
      <Button onClick={() => setStep("file")}>Назад</Button>
      <Button variant="primary" busy={busy} disabled={!mapped} onClick={() => void check()}>Проверить</Button>
    </>,
    check: <>
      <Button onClick={() => setStep("map")}>Назад</Button>
      <Button variant="primary" busy={busy} disabled={!preview || preview.new + preview.existing === 0} onClick={() => void run()}>Импортировать</Button>
    </>,
    done: <>
      {result?.batchId && <Button busy={busy} onClick={() => void undo(result.batchId!)}>Отменить импорт</Button>}
      <Button variant="primary" onClick={onClose}>Готово</Button>
    </>,
  }[step];

  return (
    <Dialog title="Импорт клиентов" onClose={onClose} modal={busy} width={step === "file" ? 520 : 720} footer={footer} className="import-dialog">
      {step === "file" && (
        <div className="import-step">
          <p>Загрузите таблицу CSV или Excel (.xlsx) до 10 МБ и 20 000 строк: компании, контакты и сделки. Первая строка — заголовки колонок.</p>
          <Button variant="primary" icon="plus" busy={busy} onClick={() => input.current?.click()}>Выбрать файл</Button>
          <input ref={input} type="file" hidden accept=".csv,.txt,.xlsx" aria-label="Файл для импорта" onChange={(ev) => void pick(ev.target.files)} />
          {history.length > 0 && (
            <section className="import-history">
              <h4>Последние импорты</h4>
              <ul>
                {history.slice(0, 5).map((b) => (
                  <li key={b.id} className="row">
                    <span className="grow ellipsis">{b.file} · {fullRu(b.createdAt)}{b.summary ? ` · ${summaryText(b.summary)}` : ""}</span>
                    {b.undoneAt ? <span className="faint">отменён</span> : <Button small busy={busy} onClick={() => void undo(b.id)}>Отменить</Button>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {step === "map" && info && (
        <div className="import-step">
          <p className="muted">{file?.name} · {integer(info.rows)} {plural(info.rows, "строка", "строки", "строк")}. Укажите, что лежит в каждой колонке.</p>
          <div className="import-map" role="table" aria-label="Сопоставление колонок">
            {info.headers.map((h, i) => (
              <div key={i} className="import-map-row" role="row">
                <span className="ellipsis" role="cell"><b>{h || `Колонка ${i + 1}`}</b><span className="faint ellipsis">{info.sample.map((r) => r[i]).filter(Boolean).slice(0, 2).join(" · ")}</span></span>
                <span role="cell"><Select small value={mapping[i] ?? ""} options={fieldOptions} onChange={(v) => setField(i, v)} width={240} label={`Поле для колонки ${h}`} /></span>
              </div>
            ))}
          </div>
          <div className="row import-dup">
            <span>Если клиент уже есть:</span>
            <Segmented small value={duplicates} onChange={setDuplicates} options={[
              { value: "link", label: "Связать", tip: "Новые контакты и сделки добавятся к найденной компании" },
              { value: "skip", label: "Пропустить" },
              { value: "create", label: "Создать заново" },
            ]} />
          </div>
        </div>
      )}

      {step === "check" && preview && (
        <div className="import-step">
          <div className="row import-counts">
            <Tag tone="green">Новых: {integer(preview.new)}</Tag>
            <Tag tone="blue">Уже есть: {integer(preview.existing)}</Tag>
            {preview.skipped > 0 && <Tag>Пропуск: {integer(preview.skipped)}</Tag>}
            {preview.errors > 0 && <Tag tone="red">Ошибок: {integer(preview.errors)}</Tag>}
            <span className="faint">Контактов: {integer(preview.contacts)}, сделок: {integer(preview.deals)}</span>
          </div>
          {preview.errors > 0 && <Notice tone="warn">Строки с ошибками не загрузятся. Остальные можно импортировать сейчас.</Notice>}
          <div className="import-rows" role="table" aria-label="Проверка строк">
            {preview.items.map((r) => (
              <div key={r.line} className="import-row" role="row">
                <span className="faint num" role="cell">{r.line}</span>
                <span className="ellipsis" role="cell">{[r.company, r.contact, r.deal].filter(Boolean).join(" · ") || "—"}{r.existing && <span className="faint"> → {r.existing}</span>}{r.messages.length > 0 && <span className="faint"> · {r.messages.join("; ")}</span>}</span>
                <span role="cell"><Tag tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Tag></span>
              </div>
            ))}
          </div>
          {preview.rows > preview.items.length && <p className="faint">Показаны первые {integer(preview.items.length)} строк из {integer(preview.rows)}.</p>}
        </div>
      )}

      {step === "done" && result && (
        <div className="import-step">
          <Notice tone={result.errors ? "warn" : "ok"}>Загружено: {summaryText(result)}.{result.linked ? ` Связано с существующими: ${integer(result.linked)}.` : ""}{result.errors ? ` Не загружено строк: ${integer(result.errors)}.` : ""}</Notice>
          {result.unknownStages.length > 0 && <p className="muted">Этапы не найдены и заменены первым этапом воронки: {result.unknownStages.join(", ")}.</p>}
          {result.errorRows.length > 0 && (
            <ul className="import-errors">
              {result.errorRows.slice(0, 20).map((e) => <li key={e.line}><span className="num faint">Строка {e.line}:</span> {e.message}</li>)}
            </ul>
          )}
          {result.batchId && <p className="faint">Если что-то пошло не так, импорт можно отменить: созданные им записи уйдут в корзину.</p>}
        </div>
      )}
    </Dialog>
  );
}
