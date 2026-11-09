import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { CrmState } from "../../api/types";
import { Button, Field, PasswordInput, SettingRow, Tag, TextInput } from "../../ui/kit";
import { confirmDialog } from "../../ui/overlay";
import { attempt, toast } from "../../state/store";
import { useEvent } from "../../state/hooks";

export type CrmKind = "bitrix" | "notion" | "webhook";
export const TITLES: Record<CrmKind, string> = { bitrix: "Битрикс24", notion: "Notion", webhook: "Вебхук" };
const HINTS: Record<CrmKind, string> = {
  bitrix: "Отправка лидов в CRM как лидов",
  notion: "Лиды становятся страницами в вашей базе",
  webhook: "POST-запрос с JSON на ваш адрес: Zapier, Make, n8n",
};
const KINDS: CrmKind[] = ["bitrix", "notion", "webhook"];

/** Подключение Битрикс24, Notion и вебхуков: те же формы, что при экспорте, но без открытия лидов. */
export function CrmPanel() {
  const [crm, setCrm] = useState<CrmState | null>(null);
  const [open, setOpen] = useState<CrmKind | null>(null);
  const load = useCallback(() => { void api.crmState().then(setCrm).catch(() => {}); }, []);
  useEffect(load, [load]);
  useEvent("crm-changed", load);
  if (!crm) return null;

  const disconnect = async (kind: CrmKind) => {
    const ok = await confirmDialog({ title: `Отключить ${TITLES[kind]}?`, message: "Данные доступа будут удалены с этого устройства. Уже отправленные лиды останутся на стороне сервиса.", confirm: "Отключить", danger: true });
    if (ok) { await attempt(() => api.disconnectCrm(kind)); load(); }
  };

  return (
    <>
      {KINDS.map((kind) => {
        const info = crm[kind];
        const target = info.connected ? (kind === "notion" ? crm.notion.title : crm[kind].target) : null;
        return (
          <div key={kind} className="crm-item">
            <SettingRow title={<span className="row">{TITLES[kind]}{info.connected ? <Tag tone="green">подключён</Tag> : null}</span>} hint={target ?? HINTS[kind]}>
              {info.connected
                ? <Button variant="ghost" onClick={() => void disconnect(kind)}>Отключить</Button>
                : <Button onClick={() => setOpen(open === kind ? null : kind)}>{open === kind ? "Свернуть" : "Настроить"}</Button>}
            </SettingRow>
            {open === kind && !info.connected && <div className="crm-form"><Connect kind={kind} onDone={() => { setOpen(null); load(); }} /></div>}
          </div>
        );
      })}
    </>
  );
}

export function Connect({ kind, onDone }: { kind: CrmKind; onDone?: () => void }) {
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
    if (ok) { toast(`${TITLES[kind]} подключён`, "success"); onDone?.(); }
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

