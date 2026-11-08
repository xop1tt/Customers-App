import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { CrmReport, CrmState, ExportFieldInfo } from "../api/types";
import { integer, plural } from "../lib/format";
import { pickSavePath } from "../lib/platform";
import { Button, Checkbox, Field, Notice, PasswordInput, ProgressBar, Segmented, Select, SettingRow, Tabs, TextInput } from "../ui/kit";
import { Dialog, confirmDialog } from "../ui/overlay";
import { attempt, patchAccount, setState, toast, useStore } from "../state/store";
import { useEvent } from "../state/hooks";

type Tab = "file" | "bitrix" | "notion" | "webhook";

export function ExportDialog() {
  const selection = useStore((s) => s.selection);
  const leads = useStore((s) => s.snap.leads);
  const account = useStore((s) => s.account);
  const ids = selection.length > 0 ? selection : leads.filter((l) => !l.archived && !l.excluded).map((l) => l.id);
  const [tab, setTab] = useState<Tab>((["file", "bitrix", "notion", "webhook"].includes(account?.exportLastTab ?? "") ? account?.exportLastTab : "file") as Tab);
  const [crm, setCrm] = useState<CrmState | null>(null);
  const loadCrm = useCallback(() => { void api.crmState().then(setCrm).catch(() => {}); }, []);
  useEffect(loadCrm, [loadCrm]);
  useEvent("crm-changed", loadCrm);
  const close = () => setState({ exportOpen: false });

  return (
    <Dialog title={`Экспорт: ${integer(ids.length)} ${plural(ids.length, "лид", "лида", "лидов")}`} onClose={close} width={640}>
      <div className="col" style={{ gap: 16 }}>
        <Tabs<Tab> value={tab} onChange={(t) => { setTab(t); void patchAccount({ exportLastTab: t }); }}
          tabs={[{ id: "file", label: "Файл", icon: "file" }, { id: "bitrix", label: "Битрикс24", icon: "users" }, { id: "notion", label: "Notion", icon: "note" }, { id: "webhook", label: "Вебхук", icon: "link" }]} />
        {tab === "file" && <FileTab ids={ids} onDone={close} />}
        {tab !== "file" && crm && <CrmTab kind={tab} crm={crm} ids={ids} />}
      </div>
    </Dialog>
  );
}

function FileTab({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const [fields, setFields] = useState<ExportFieldInfo[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.exportFields().then((f) => { setFields(f); setChosen(f.filter((x) => x.default).map((x) => x.key)); }).catch(() => {});
  }, []);
  const run = async () => {
    const path = await pickSavePath("Сохранить лиды", `leads.${format}`, format);
    if (!path) return;
    setBusy(true);
    const r = await attempt(() => api.exportToFile(ids, format, chosen, path));
    setBusy(false);
    if (r) { toast(r, "success"); onDone(); }
  };
  return (
    <div className="col" style={{ gap: 14 }}>
      <SettingRow title="Формат" hint="CSV открывается в Excel и Google Таблицах, JSON подходит для программ."><Segmented value={format} onChange={setFormat} options={[{ value: "csv", label: "CSV" }, { value: "json", label: "JSON" }]} /></SettingRow>
      <div>
        <div className="row" style={{ marginBottom: 8 }}>
          <strong>Поля</strong><span className="grow" />
          <Button small variant="ghost" onClick={() => setChosen(fields.map((f) => f.key))}>Все</Button>
          <Button small variant="ghost" onClick={() => setChosen(fields.filter((f) => f.default).map((f) => f.key))}>По умолчанию</Button>
        </div>
        <div className="field-grid">
          {fields.map((f) => <Checkbox key={f.key} checked={chosen.includes(f.key)} onChange={(v) => setChosen(v ? [...chosen, f.key] : chosen.filter((k) => k !== f.key))} label={f.title} />)}
        </div>
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button variant="primary" icon="download" busy={busy} disabled={chosen.length === 0} onClick={() => void run()}>Сохранить файл…</Button>
      </div>
    </div>
  );
}

const TITLES = { bitrix: "Битрикс24", notion: "Notion", webhook: "Вебхук" } as const;

function CrmTab({ kind, crm, ids }: { kind: "bitrix" | "notion" | "webhook"; crm: CrmState; ids: string[] }) {
  const connected = crm[kind].connected;
  return connected ? <Connected kind={kind} crm={crm} ids={ids} /> : <Connect kind={kind} />;
}

function Connect({ kind }: { kind: "bitrix" | "notion" | "webhook" }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [db, setDb] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const ok = await attempt(async () => {
      if (kind === "bitrix") await api.connectBitrix(url.trim());
      else if (kind === "webhook") await api.connectWebhook(url.trim());
      else await api.connectNotion(token.trim(), db.trim(), false);
      return true;
    });
    setBusy(false);
    if (ok) toast(`${TITLES[kind]} подключён`, "success");
  };
  return (
    <div className="col" style={{ gap: 14 }}>
      {kind === "bitrix" && <>
        <p className="muted">Создайте входящий вебхук в Битрикс24 (Разработчикам → Другое → Входящий вебхук) с правом CRM и вставьте его адрес. Лиды попадут в CRM как лиды.</p>
        <Field label="Адрес вебхука"><TextInput value={url} onChange={setUrl} placeholder="https://company.bitrix24.ru/rest/1/xxxxxxxx/" /></Field>
      </>}
      {kind === "webhook" && <>
        <p className="muted">Приложение отправит каждый лид POST-запросом в формате JSON на ваш адрес (Zapier, Make, n8n или собственный сервер).</p>
        <Field label="Адрес"><TextInput value={url} onChange={setUrl} placeholder="https://hooks.example.com/…" /></Field>
      </>}
      {kind === "notion" && <>
        <p className="muted">Создайте внутреннюю интеграцию на notion.so/my-integrations, откройте ей доступ к базе данных и вставьте токен и адрес базы.</p>
        <Field label="Токен интеграции"><PasswordInput value={token} onChange={setToken} /></Field>
        <Field label="Адрес или идентификатор базы"><TextInput value={db} onChange={setDb} placeholder="https://www.notion.so/…" /></Field>
      </>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Button variant="primary" busy={busy} disabled={kind === "notion" ? !token.trim() || !db.trim() : !url.trim()} onClick={() => void go()}>Подключить</Button>
      </div>
    </div>
  );
}

function Connected({ kind, crm, ids }: { kind: "bitrix" | "notion" | "webhook"; crm: CrmState; ids: string[] }) {
  const [sent, setSent] = useState(0);
  const [resend, setResend] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<{ report: CrmReport; summary: string } | null>(null);
  useEffect(() => { void api.crmSentCount(kind, ids).then(setSent).catch(() => {}); }, [kind, ids, report]);
  useEvent<{ done: number; total: number }>("crm-progress", setProgress);

  const target = crm[kind].connected ? (kind === "notion" ? crm.notion.title : crm[kind].target) : null;
  const notionReady = kind !== "notion" || crm.notion.hasTitle;
  const todo = resend ? ids.length : ids.length - sent;

  const run = async () => {
    setRunning(true);
    setProgress({ done: 0, total: ids.length });
    setReport(null);
    const r = await attempt(() => api.exportToCrm(kind, ids, resend));
    setRunning(false);
    if (r) { setReport(r); toast(r.summary, r.report.failures.length ? "error" : "success"); }
  };
  const disconnect = async () => {
    const ok = await confirmDialog({ title: `Отключить ${TITLES[kind]}?`, message: "Данные доступа будут удалены с этого устройства. Уже отправленные лиды останутся на стороне сервиса.", confirm: "Отключить", danger: true });
    if (ok) await attempt(() => api.disconnectCrm(kind));
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <SettingRow title={`${TITLES[kind]} подключён`} hint={target ?? undefined}>
        <Button variant="ghost" onClick={() => void disconnect()} disabled={running}>Отключить</Button>
      </SettingRow>
      {kind === "notion" && <NotionMapping crm={crm} />}
      {sent > 0 && <Checkbox checked={resend} onChange={setResend} label={`Отправить повторно (уже отправлено: ${sent})`} />}
      {running && progress && (
        <div className="col" style={{ gap: 6 }}>
          <ProgressBar value={progress.total ? progress.done / progress.total : 0} />
          <span className="faint num">{progress.done} из {progress.total}</span>
        </div>
      )}
      {report && (
        <Notice tone={report.report.failures.length ? "warn" : "ok"}>
          <div>{report.summary}</div>
          {report.report.failures.slice(0, 5).map((f) => <div key={f.id} className="faint">{f.title}: {f.message}</div>)}
        </Notice>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        {running ? <Button icon="stop" onClick={() => void api.cancelCrm()}>Остановить</Button> : (
          <Button variant="primary" icon="send" disabled={todo <= 0 || !notionReady} onClick={() => void run()}>
            {todo > 0 ? `Отправить ${integer(todo)} ${plural(todo, "лид", "лида", "лидов")}` : "Всё уже отправлено"}
          </Button>
        )}
      </div>
    </div>
  );
}

function NotionMapping({ crm }: { crm: CrmState }) {
  const [fields, setFields] = useState<ExportFieldInfo[]>([]);
  useEffect(() => { void api.exportFields().then(setFields).catch(() => {}); }, []);
  const props = (crm.notion.properties ?? []).filter((p) => p.writable);
  const mapping = crm.notion.mapping ?? {};
  const change = async (name: string, field: string) => {
    const next = { ...mapping };
    if (field) next[name] = field; else delete next[name];
    await attempt(() => api.setNotionMapping(next));
  };
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row"><strong>Соответствие полей</strong><span className="grow" /><Button small variant="ghost" icon="refresh" onClick={() => void attempt(() => api.refreshNotion())}>Обновить из Notion</Button></div>
      {!crm.notion.hasTitle && <Notice tone="warn">Выберите, что записывать в заголовок страницы (поле типа «Title»), иначе отправка недоступна.</Notice>}
      <div className="map-grid">
        {props.map((p) => (
          <div key={p.name} className="map-row">
            <span className="ellipsis">{p.name}<span className="faint"> · {p.typeTitle}</span></span>
            <Select small value={mapping[p.name] ?? ""} onChange={(v) => void change(p.name, v)} width={190} label={p.name}
              options={[{ value: "", label: "Не заполнять" }, ...fields.map((f) => ({ value: f.key, label: f.title }))]} />
          </div>
        ))}
      </div>
    </div>
  );
}
