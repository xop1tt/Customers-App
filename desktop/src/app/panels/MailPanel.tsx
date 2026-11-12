import { useEffect, useState } from "react";
import { api } from "../../api";
import type { MailAccount, MailProviderInfo, MailState } from "../../api/types";
import { Button, Checkbox, Field, Notice, NumberInput, PasswordInput, Segmented, Select, SettingRow, TextInput } from "../../ui/kit";
import { confirmDialog } from "../../ui/overlay";
import { attempt, patchAccount, toast } from "../../state/store";
import { openLink } from "../../state/actions";

const blank = (): MailAccount => ({ provider: "custom", host: "", port: 465, security: "tls", username: "", fromAddress: "", fromName: "", copyToSelf: true });

export function MailPanel() {
  const [state, setState] = useState<MailState | null>(null);
  const [providers, setProviders] = useState<MailProviderInfo[]>([]);
  const [acc, setAcc] = useState<MailAccount>(blank());
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    const [s, p] = await Promise.all([api.mailState(), api.mailProviders()]);
    setState(s);
    setProviders(p);
    if (s.account) setAcc(s.account);
  };
  useEffect(() => { void load().catch(() => {}); }, []);
  if (!state) return null;

  const provider = providers.find((p) => p.id === acc.provider);
  const smtp = state.delivery === "smtp";
  const setDelivery = async (delivery: "mailApp" | "smtp") => {
    if (delivery === "mailApp") {
      await attempt(() => api.mailSave(state.account, "mailApp", null));
      await patchAccount({ mailDelivery: "mailApp" });
      await load();
    } else {
      setState({ ...state, delivery: "smtp" });
    }
  };
  const pickProvider = (id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    setAcc({ ...acc, provider: id, host: p.host || acc.host, port: p.port, security: p.security });
  };
  const email = acc.username;
  const setEmail = (v: string) => setAcc({ ...acc, username: v, fromAddress: v });
  const valid = acc.host.trim() && /^\S+@\S+\.\S+$/.test(acc.fromAddress) && acc.username.trim() && (password || state.hasPassword);

  const save = async () => {
    setBusy("save");
    const ok = await attempt(async () => { await api.mailSave(acc, "smtp", password || null); return true; });
    setBusy(null);
    if (ok) { setPassword(""); setResult(null); toast("Настройки почты сохранены", "success"); await patchAccount({ mailDelivery: "smtp", mailAccount: acc.fromAddress }); await load(); }
  };
  const test = async () => {
    setBusy("test");
    try { setResult({ ok: true, text: await api.mailTest() }); } catch (e) { setResult({ ok: false, text: (e as { message: string }).message }); }
    setBusy(null);
  };
  const forget = async () => {
    const ok = await confirmDialog({ title: "Удалить настройки почтового сервера?", message: "Пароль и настройки сервера будут удалены с этого устройства.", confirm: "Удалить", danger: true });
    if (!ok) return;
    await attempt(() => api.mailForget());
    setAcc(blank());
    setResult(null);
    await load();
  };

  return (
    <>
      <SettingRow title="Как отправлять письма" hint="В почтовой программе вы видите и правите письмо перед отправкой. Свой сервер отправляет письмо прямо из приложения.">
        <Segmented value={state.delivery} onChange={(v) => void setDelivery(v)} options={[{ value: "mailApp", label: "Почтовая программа" }, { value: "smtp", label: "Свой сервер" }]} />
      </SettingRow>
      {smtp && (
        <div className="mail-form">
          <div className="form-grid">
            <Field label="Почтовый сервис">
              <Select value={acc.provider} options={providers.map((p) => ({ value: p.id, label: p.title }))} onChange={pickProvider} />
            </Field>
            <Field label="Ваша почта"><TextInput value={email} onChange={setEmail} placeholder="name@example.ru" /></Field>
            <Field label="Имя отправителя"><TextInput value={acc.fromName} onChange={(v) => setAcc({ ...acc, fromName: v })} placeholder="Как вас подписать" /></Field>
            <Field label={state.hasPassword ? "Пароль (оставьте пустым, чтобы не менять)" : "Пароль приложения"}><PasswordInput value={password} onChange={setPassword} /></Field>
            <Field label="Сервер SMTP"><TextInput value={acc.host} onChange={(v) => setAcc({ ...acc, host: v })} placeholder="smtp.example.ru" /></Field>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <Field label="Порт"><NumberInput value={acc.port} min={1} max={65535} width={120} onChange={(v) => setAcc({ ...acc, port: v })} /></Field>
              <Field label="Защита"><Segmented value={acc.security} onChange={(v) => setAcc({ ...acc, security: v })} options={[{ value: "tls", label: "TLS" }, { value: "startTls", label: "STARTTLS" }]} /></Field>
            </div>
          </div>
          {provider?.hint && <Notice tone="info" action={provider.passwordPage ? <Button small onClick={() => void openLink(provider.passwordPage as string)}>Создать пароль</Button> : undefined}>{provider.hint}</Notice>}
          <Checkbox checked={acc.copyToSelf} onChange={(v) => setAcc({ ...acc, copyToSelf: v })} label="Отправлять себе копию письма" />
          {result && <Notice tone={result.ok ? "ok" : "error"}>{result.text}</Notice>}
          <div className="row">
            <Button variant="primary" busy={busy === "save"} disabled={!valid} onClick={() => void save()}>Сохранить</Button>
            <Button busy={busy === "test"} disabled={!state.smtpReady} onClick={() => void test()}>Проверить отправку</Button>
            <span className="grow" />
            {(state.account || state.hasPassword) && <Button variant="danger" onClick={() => void forget()}>Удалить настройки сервера</Button>}
          </div>
        </div>
      )}
    </>
  );
}
