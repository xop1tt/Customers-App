import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { CrashReport, PathsInfo, ReleaseSummary } from "../../api/types";
import { dateOnly, bytes, shortRelative } from "../../lib/format";
import { Button, EmptyState, Field, Group, Notice, Select, SettingRow, Spinner, Switch, Tag, TextArea, TextInput } from "../../ui/kit";
import { Dialog, confirmDialog } from "../../ui/overlay";
import { attempt, patchDevice, useStore } from "../../state/store";
import { copyToClipboard, openLink } from "../../state/actions";

export function ReportsSection() {
  const d = useStore((s) => s.device);
  const [paths, setPaths] = useState<PathsInfo | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [crashes, setCrashes] = useState<CrashReport[]>([]);
  const [dialog, setDialog] = useState<{ title: string; text: string } | null>(null);
  const [report, setReport] = useState(false);
  const load = useCallback(() => {
    void api.pathsInfo().then(setPaths).catch(() => {});
    void api.errorLog(100).then(setLines).catch(() => {});
    void api.crashReports().then(setCrashes).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const showCrash = async (c: CrashReport) => {
    const text = await attempt(() => api.crashReportText(c.path));
    if (text !== undefined) setDialog({ title: `Отчёт о сбое от ${c.date}`, text });
  };
  return (
    <>
      <Group title="Диагностика" note="Отчёты не отправляются автоматически. Вы сами решаете, что отправить, и видите текст заранее. Пароли и ключи в отчёты не попадают.">
        <SettingRow title="Предлагать отчёт после сбоя"><Switch checked={d.reportsOfferAfterCrash} onChange={(v) => void patchDevice({ reportsOfferAfterCrash: v })} /></SettingRow>
        <SettingRow title="Записывать ошибки в журнал" hint="Журнал хранится только на этом компьютере."><Switch checked={d.reportsLogErrors} onChange={(v) => void patchDevice({ reportsLogErrors: v })} /></SettingRow>
        <SettingRow title="Прикладывать журнал к обращению"><Switch checked={d.reportsIncludeLog} onChange={(v) => void patchDevice({ reportsIncludeLog: v })} /></SettingRow>
        <SettingRow title="Сообщить о проблеме" hint="Откроется страница обращения с описанием, которое можно отредактировать."><Button icon="report" onClick={() => setReport(true)}>Сообщить…</Button></SettingRow>
      </Group>

      <Group title="Журнал ошибок" action={<>
        <Button small variant="ghost" onClick={() => paths && void attempt(() => api.revealPath(paths.errorLog))}>Показать файл</Button>
        <Button small variant="ghost" onClick={async () => { const ok = await confirmDialog({ title: "Очистить журнал ошибок?", confirm: "Очистить", danger: true }); if (ok) { await attempt(() => api.clearErrorLog()); load(); } }}>Очистить</Button>
      </>}>
        {lines.length === 0 ? <EmptyState icon="check" title="Журнал пуст" /> : <pre className="logbox selectable">{lines.join("\n")}</pre>}
      </Group>

      <Group title={`Отчёты о сбоях (${crashes.length})`}>
        {crashes.length === 0 ? <p className="faint" style={{ paddingTop: 12 }}>Сбоев не было.</p> : crashes.map((c) => (
          <SettingRow key={c.path} title={c.date} hint={c.kind}><Button onClick={() => void showCrash(c)}>Показать</Button></SettingRow>
        ))}
      </Group>
      {dialog && <TextDialog title={dialog.title} text={dialog.text} onClose={() => setDialog(null)} />}
      {report && <ReportDialog onClose={() => setReport(false)} />}
    </>
  );
}

function TextDialog({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose} width={640} footer={<><Button onClick={() => void copyToClipboard(text, "Скопировано")}>Копировать</Button><Button onClick={onClose}>Закрыть</Button></>}>
      <pre className="logbox selectable" style={{ maxHeight: 360 }}>{text}</pre>
    </Dialog>
  );
}

export function ReportDialog({ onClose, initial = "", crash = false }: { onClose: () => void; initial?: string; crash?: boolean }) {
  const include = useStore((s) => s.device.reportsIncludeLog);
  const [title, setTitle] = useState(crash ? "Сбой приложения" : "");
  const [text, setText] = useState(initial);
  const [log, setLog] = useState(include);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    let body = text;
    if (log) {
      const lines = await api.errorLog(30).catch(() => [] as string[]);
      if (lines.length) body += `\n\n<details><summary>Журнал ошибок</summary>\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n</details>`;
    }
    const url = await attempt(() => api.issueUrl(title.trim() || "Проблема в приложении", body));
    setBusy(false);
    if (url) { await openLink(url); onClose(); }
  };
  return (
    <Dialog title={crash ? "Приложение завершилось с ошибкой" : "Сообщить о проблеме"} onClose={onClose} width={560}
      footer={<><Button onClick={onClose}>{crash ? "Не сообщать" : "Отмена"}</Button><Button variant="primary" busy={busy} disabled={!title.trim()} onClick={() => void send()}>Открыть обращение</Button></>}>
      <div className="col" style={{ gap: 12 }}>
        <p className="muted">Откроется страница обращения в браузере. Текст ниже будет подставлен заранее, его можно изменить перед отправкой.</p>
        <Field label="Кратко"><TextInput value={title} onChange={setTitle} data-autofocus /></Field>
        <Field label="Подробности"><TextArea value={text} onChange={setText} rows={crash ? 10 : 6} placeholder="Что вы делали и что пошло не так" /></Field>
        <label className="row"><Switch checked={log} onChange={setLog} /><span>Приложить последние записи журнала ошибок</span></label>
      </div>
    </Dialog>
  );
}

export function UpdatesSection() {
  const u = useStore((s) => s.update);
  const d = useStore((s) => s.device);
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [intervals, setIntervals] = useState<{ hours: number; title: string }[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    void api.recentReleases().then(setReleases).catch(() => {});
    void api.updateIntervals().then(setIntervals).catch(() => {});
  }, []);
  if (!u) return null;
  const busy = u.phase === "checking" || u.phase === "downloading" || u.phase === "installing";
  const status =
    u.phase === "checking" ? "Проверяем наличие обновлений…" :
    u.phase === "downloading" ? "Загружаем обновление…" :
    u.phase === "installing" ? "Устанавливаем обновление…" :
    u.phase === "ready" ? `Обновление ${u.stagedVersion ?? u.available?.version ?? ""} загружено и готово к установке` :
    u.phase === "available" ? `Доступна версия ${u.available?.version}` :
    u.phase === "failed" ? "Не удалось обновить" :
    u.phase === "upToDate" ? "Установлена последняя версия" : "Обновления не проверялись";

  return (
    <>
      <Group title="Версия">
        <SettingRow title={`Customers ${u.current}`} hint={<>{status}{u.lastCheck ? ` · проверено ${shortRelative(u.lastCheck)}` : ""}</>}>
          {busy && <Spinner />}
          <Button icon="refresh" disabled={busy} onClick={() => void attempt(() => api.checkUpdates())}>Проверить</Button>
        </SettingRow>
        {u.phase === "failed" && <div style={{ paddingTop: 10 }}><Notice tone="error">{u.message ?? "Не удалось обновить приложение."}</Notice></div>}
        {u.available && (
          <div className="update-card">
            <div className="row"><strong className="grow">{u.available.title}</strong>{u.available.size ? <span className="faint">{bytes(u.available.size)}</span> : null}</div>
            {u.available.notes && <p className="muted selectable update-notes">{u.available.notes}</p>}
            <div className="row">
              {u.canUpdate && u.phase === "available" && <Button variant="primary" icon="download" onClick={() => void attempt(() => api.prepareUpdate())}>Скачать</Button>}
              {u.canUpdate && u.phase === "ready" && <Button variant="primary" icon="refresh" onClick={() => void attempt(() => api.installUpdate())}>Установить и перезапустить</Button>}
              {u.available.page && <Button variant="ghost" icon="external" onClick={() => void openLink(u.available?.page as string)}>Страница релиза</Button>}
            </div>
          </div>
        )}
        {!u.canUpdate && <div style={{ paddingTop: 10 }}><Notice tone="info" action={<Button small onClick={() => void openLink(u.releasesPage)}>Релизы</Button>}>Установка обновлений из приложения здесь недоступна. Скачайте новую версию со страницы релизов.</Notice></div>}
      </Group>

      <Group title="Параметры">
        <SettingRow title="Проверять обновления автоматически"><Switch checked={d.checkUpdates} onChange={(v) => void patchDevice({ checkUpdates: v })} /></SettingRow>
        <SettingRow title="Как часто проверять"><Select width={180} disabled={!d.checkUpdates} value={d.updateCheckHours} options={(intervals.length ? intervals : [{ hours: d.updateCheckHours, title: `${d.updateCheckHours} ч` }]).map((i) => ({ value: i.hours, label: i.title }))} onChange={(v) => void patchDevice({ updateCheckHours: v })} /></SettingRow>
        <SettingRow title="Скачивать в фоне" hint="Загрузка начинается сразу, установка только по вашей команде."><Switch checked={d.backgroundDownload} disabled={!d.checkUpdates} onChange={(v) => void patchDevice({ backgroundDownload: v })} /></SettingRow>
      </Group>

      <Group title="История версий">
        {releases.length === 0 ? <p className="faint" style={{ paddingTop: 12 }}>Список версий недоступен.</p> : releases.map((r) => (
          <div key={r.tag} className="release">
            <button type="button" className="release-head" onClick={() => setOpen(open === r.tag ? null : r.tag)} aria-expanded={open === r.tag}>
              <span className="grow ellipsis" style={{ textAlign: "left" }}>{r.title}</span>
              {r.current && <Tag tone="blue">установлена</Tag>}
              <span className="faint">{dateOnly(r.date)}</span>
            </button>
            {open === r.tag && <div className="release-body"><p className="muted selectable" style={{ whiteSpace: "pre-wrap" }}>{r.notes || "Описание отсутствует."}</p>{r.page && <a onClick={() => void openLink(r.page as string)}>Открыть на GitHub</a>}</div>}
          </div>
        ))}
      </Group>
    </>
  );
}

