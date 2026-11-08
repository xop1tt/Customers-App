import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { DriveInfo, DrivesState, ProviderInfo } from "../../api/types";
import { fullRu } from "../../lib/format";
import { Button, Field, Notice, PasswordInput, SettingRow, Tag, TextInput } from "../../ui/kit";
import { Dialog, confirmDialog } from "../../ui/overlay";
import { attempt, toast } from "../../state/store";
import { useEvent } from "../../state/hooks";
import { copyToClipboard, openLink } from "../../state/actions";

export function DrivesPanel() {
  const [state, setState] = useState<DrivesState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<ProviderInfo | null>(null);
  const [dav, setDav] = useState<DriveInfo | null>(null);

  const load = useCallback(() => { void api.drivesState().then(setState).catch(() => {}); }, []);
  useEffect(load, [load]);
  useEvent("integrations-changed", load);
  if (!state) return null;

  const connect = async (d: DriveInfo) => {
    if (d.kind === "webdav") return setDav(d);
    const p = state.providers.find((x) => x.provider === d.provider);
    if (p && !p.hasKey && !p.builtIn) return setKeyFor(p);
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
              <Button variant="ghost" onClick={() => void disconnect(d)}>Отключить</Button>
            </>
          ) : (
            <Button onClick={() => void connect(d)}>Подключить</Button>
          )}
        </SettingRow>
      ))}
      {busy && <Notice tone="info">Завершите вход в открывшемся окне браузера. Приложение ждёт ответа.</Notice>}
      {keyFor && <OAuthKeyDialog provider={keyFor} redirect={state.redirect} onClose={() => { setKeyFor(null); load(); }} />}
      {dav && <WebdavDialog drive={dav} onClose={(ok) => { setDav(null); if (ok) load(); }} />}
    </>
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
        <p className="muted">Для входа через {provider.provider === "google" ? "Google" : "Dropbox"} нужен собственный ключ приложения. Создайте его в консоли и вставьте сюда. <a onClick={() => void openLink(provider.consolePage)}>Открыть консоль</a></p>
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
    <Dialog title={`Подключить ${drive.title}`} onClose={() => onClose(false)} width={480}
      footer={<><Button onClick={() => onClose(false)}>Отмена</Button><Button variant="primary" busy={busy} disabled={!url.trim() || !login.trim() || (!drive.passwordOptional && !password)} onClick={() => void connect()}>Подключить</Button></>}>
      <div className="col" style={{ gap: 12 }}>
        {drive.passwordPage && <p className="muted">Нужен пароль приложения, а не пароль от аккаунта. <a onClick={() => void openLink(drive.passwordPage as string)}>Создать пароль приложения</a></p>}
        <Field label="Адрес WebDAV"><TextInput value={url} onChange={setUrl} disabled={urlFixed} placeholder="https://example.com/remote.php/dav/files/user/" /></Field>
        <Field label="Логин"><TextInput value={login} onChange={setLogin} data-autofocus /></Field>
        <Field label={drive.passwordOptional ? "Пароль (необязательно)" : "Пароль приложения"}><PasswordInput value={password} onChange={setPassword} /></Field>
      </div>
    </Dialog>
  );
}
