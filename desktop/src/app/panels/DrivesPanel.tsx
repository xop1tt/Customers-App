import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { DriveInfo, DrivesState, ProviderInfo } from "../../api/types";
import { fullRu } from "../../lib/format";
import { Button, Field, Notice, PasswordInput, SettingRow, Tag, TextInput } from "../../ui/kit";
import { Dialog, confirmDialog } from "../../ui/overlay";
import { attempt, toast } from "../../state/store";
import { useEvent } from "../../state/hooks";
import { copyToClipboard, openLink } from "../../state/actions";
import { useCreateKey } from "../settings/PortableCopy";

export function DrivesPanel() {
  const [state, setState] = useState<DrivesState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<ProviderInfo | null>(null);
  const [dav, setDav] = useState<DriveInfo | null>(null);
  const [bind, setBind] = useState<DriveInfo | null>(null);
  const { create: createKey, dialog: keyDialog } = useCreateKey(() => {});

  const load = useCallback(() => { void api.drivesState().then(setState).catch(() => {}); }, []);
  useEffect(load, [load]);
  useEvent("integrations-changed", load);
  if (!state) return null;

  const connect = async (d: DriveInfo) => {
    if (d.kind === "webdav") return setDav(d);
    setBind(d);
  };
  /** Вход через браузер: приложение открывает страницу сервиса и ждёт ответа. */
  const bindNow = async (d: DriveInfo) => {
    setBind(null);
    setBusy(d.service);
    const r = await attempt(() => api.connectOauth(d.service));
    setBusy(null);
    if (r) toast(r, "success");
    load();
  };
  const upload = async (d: DriveInfo) => {
    setBusy(d.service);
    const r = await attempt(() => api.uploadBackupToDrive(d.service));
    setBusy(null);
    if (r) toast(r, "success");
  };
  /** Переносимая копия под ключом восстановления: её можно скачать с диска и открыть на другом компьютере. */
  const uploadPortable = async (d: DriveInfo) => {
    setBusy(d.service);
    const r = await attempt(() => api.uploadPortableToDrive(d.service));
    setBusy(null);
    if (r) toast(r, "success");
  };
  const portable = async (d: DriveInfo) => {
    const st = await attempt(() => api.portableState());
    if (!st) return;
    if (st.hasKey) await uploadPortable(d);
    else await createKey(false, () => void uploadPortable(d));
  };
  const disconnect = async (d: DriveInfo) => {
    const ok = await confirmDialog({ title: `Отключить ${d.title}?`, message: "Сохранённые данные доступа будут удалены с этого устройства. Файлы на диске останутся.", confirm: "Отключить", danger: true });
    if (!ok) return;
    await attempt(() => api.disconnectDrive(d.service));
    load();
  };

  return (
    <>
      {state.drives.map((d) => (
        <SettingRow key={d.service} title={<span className="row">{d.title}{d.connected ? <Tag tone="green">подключён</Tag> : null}</span>} hint={d.connected ? `${d.login ? `${d.login} · ` : ""}${d.connectedAt ? fullRu(d.connectedAt) : d.subtitle}` : d.subtitle}>
          {busy === d.service ? (
            <Button onClick={() => void api.cancelIntegration()} icon="x">Отмена</Button>
          ) : d.connected ? (
            <>
              <Button icon="upload" onClick={() => void upload(d)}>Загрузить копию</Button>
              <Button onClick={() => void portable(d)}>Для переноса…</Button>
              <Button variant="ghost" onClick={() => void disconnect(d)}>Отключить</Button>
            </>
          ) : (
            <Button onClick={() => void connect(d)}>Подключить</Button>
          )}
        </SettingRow>
      ))}
      {busy && <Notice tone="info">Завершите вход в открывшемся окне браузера. Приложение ждёт ответа.</Notice>}
      {bind && <BindDialog drive={bind} provider={state.providers.find((x) => x.provider === bind.provider) ?? null} onClose={() => setBind(null)} onConfirm={() => void bindNow(bind)} onKey={(p) => { setBind(null); setKeyFor(p); }} />}
      {keyFor && <OAuthKeyDialog provider={keyFor} redirect={state.redirect} onClose={() => { setKeyFor(null); load(); }} />}
      {keyDialog}
      {dav && <WebdavDialog drive={dav} onClose={(ok) => { setDav(null); if (ok) load(); }} />}
    </>
  );
}

/** «Привязать ваш аккаунт в …?»: подтверждение перед открытием браузера. */
function BindDialog({ drive, provider, onClose, onConfirm, onKey }: { drive: DriveInfo; provider: ProviderInfo | null; onClose: () => void; onConfirm: () => void; onKey: (p: ProviderInfo) => void }) {
  const ready = !provider || provider.hasKey || provider.builtIn;
  return (
    <Dialog title={`Привязать ваш аккаунт в ${drive.title}?`} onClose={onClose} width={460}
      footer={<><Button onClick={onClose}>Отмена</Button>{ready ? <Button variant="primary" icon="external" onClick={onConfirm}>Открыть браузер</Button> : provider && <Button variant="primary" onClick={() => onKey(provider)}>Указать ключ приложения…</Button>}</>}>
      <div className="col" style={{ gap: 12 }}>
        {ready ? (
          <p className="muted">Откроется страница входа {drive.title} в браузере. Войдите в свой аккаунт и разрешите доступ: приложение сможет загружать только резервные копии базы. Пароль приложению не передаётся.</p>
        ) : (
          <Notice tone="warn">В этой сборке приложения нет ключа для входа через {drive.title}, поэтому одной кнопкой подключить не получится. Укажите свой ключ приложения (один раз) или используйте другой диск.</Notice>
        )}
      </div>
    </Dialog>
  );
}

function OAuthKeyDialog({ provider, redirect, onClose }: { provider: ProviderInfo; redirect: string; onClose: () => void }) {
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const ok = await attempt(async () => { await api.saveOauthKey(provider.provider, id.trim(), provider.needsSecret ? secret.trim() : undefined); return true; });
    setBusy(false);
    if (ok) { toast("Ключ сохранён. Теперь можно подключать диск."); onClose(); }
  };
  return (
    <Dialog title="Ключ приложения для входа" onClose={onClose} width={500}
      footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" busy={busy} disabled={!id.trim() || (provider.needsSecret && !secret.trim())} onClick={() => void save()}>Сохранить</Button></>}>
      <div className="col" style={{ gap: 12 }}>
        <p className="muted">Для входа через {provider.provider === "google" ? "Google" : "Dropbox"} нужен собственный ключ приложения. Создайте его в консоли и вставьте сюда. <button type="button" className="link" onClick={() => void openLink(provider.consolePage)}>Открыть консоль</button></p>
        <Field label="Адрес перенаправления" hint="Укажите его в настройках приложения в консоли."><div className="row"><TextInput value={redirect} onChange={() => {}} readOnly wrapClass="grow" /><Button onClick={() => void copyToClipboard(redirect, "Адрес скопирован")}>Копировать</Button></div></Field>
        <Field label={provider.clientIdLabel}><TextInput value={id} onChange={setId} data-autofocus /></Field>
        {provider.needsSecret && <Field label="Client secret"><PasswordInput value={secret} onChange={setSecret} /></Field>}
      </div>
    </Dialog>
  );
}

function WebdavDialog({ drive, onClose }: { drive: DriveInfo; onClose: (ok: boolean) => void }) {
  const [url, setUrl] = useState(drive.webdavUrl ?? drive.defaultUrl);
  const [login, setLogin] = useState(drive.login ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const urlFixed = drive.service === "yandexDisk";
  const connect = async () => {
    setBusy(true);
    const r = await attempt(() => api.connectWebdav(drive.service, url.trim(), login.trim(), password));
    setBusy(false);
    if (r) { toast(r, "success"); onClose(true); }
  };
  return (
    <Dialog title={`Привязать ваш аккаунт в ${drive.title}?`} onClose={() => onClose(false)} width={480}
      footer={<><Button onClick={() => onClose(false)}>Отмена</Button><Button variant="primary" busy={busy} disabled={!url.trim() || !login.trim() || (!drive.passwordOptional && !password)} onClick={() => void connect()}>Подключить</Button></>}>
      <div className="col" style={{ gap: 12 }}>
        {drive.passwordPage && (
          <div className="col" style={{ gap: 8 }}>
            <p className="muted">Сначала создайте пароль приложения в браузере: нужен он, а не пароль от аккаунта.</p>
            <div><Button icon="external" onClick={() => void openLink(drive.passwordPage as string)}>Открыть страницу в браузере</Button></div>
          </div>
        )}
        <Field label="Адрес WebDAV"><TextInput value={url} onChange={setUrl} disabled={urlFixed} placeholder="https://example.com/remote.php/dav/files/user/" /></Field>
        <Field label="Логин"><TextInput value={login} onChange={setLogin} data-autofocus /></Field>
        <Field label={drive.passwordOptional ? "Пароль (необязательно)" : "Пароль приложения"}><PasswordInput value={password} onChange={setPassword} /></Field>
      </div>
    </Dialog>
  );
}
