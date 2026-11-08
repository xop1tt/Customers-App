import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, Checkbox, Field, Notice, PasswordInput, Segmented, TextInput } from "../ui/kit";
import { Icon } from "../ui/icons";
import { enterSession, errText, setState, toast, useStore } from "../state/store";
import { useEvent } from "../state/hooks";

type Mode = "cloud" | "local";
type Stage = "signIn" | "signUp" | "confirm" | "forgot" | "reset" | "newPassword";
const RULES = "Пароль: не короче 8 символов, строчные и заглавные буквы и цифры.";

export function Brand({ size = 44 }: { size?: number }) {
  return (
    <span className="brand" style={{ width: size, height: size }} aria-hidden="true"><Icon name="search" size={size * 0.5} stroke={2.2} /></span>
  );
}

export function AuthScreen() {
  const boot = useStore((s) => s.boot);
  const callback = useStore((s) => s.authCallback);
  const cloud = !!boot?.cloudAvailable;
  const [mode, setMode] = useState<Mode>(cloud ? "cloud" : "local");
  const [stage, setStage] = useState<Stage>("signIn");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [accounts, setAccounts] = useState<string[]>([]);
  const [user, setUser] = useState("");
  const [remember, setRemember] = useState(false);
  const [localMode, setLocalMode] = useState<"login" | "register">("login");

  useEffect(() => {
    void api.localAccounts().then((a) => {
      setAccounts(a);
      setUser(boot?.device.rememberedUser ?? a[0] ?? "");
      if (a.length === 0) setLocalMode("register");
    }).catch(() => {});
  }, [boot?.device.rememberedUser]);
  useEffect(() => { if (callback?.kind === "newPassword") { setMode("cloud"); setStage("newPassword"); setError(null); } }, [callback]);
  useEvent("auth-callback", () => {});

  const go = (s: Stage) => { setStage(s); setError(null); setInfo(null); setPassword(""); setConfirm(""); setCode(""); };
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await f(); } catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  const finish = async () => { setState({ authCallback: null }); await enterSession(); };

  const emailOk = /^\S+@\S+\.\S+$/.test(email.trim());

  const submit = () => {
    if (mode === "local") {
      return run(async () => {
        if (localMode === "login") await api.login(user.trim(), password, remember);
        else {
          const note = await api.register(user.trim(), password, confirm, remember);
          await finish();
          if (note) toast(note, "error");
          return;
        }
        await finish();
      });
    }
    switch (stage) {
      case "signIn": return run(async () => { await api.cloudSignIn(email.trim(), password); await finish(); });
      case "signUp": return run(async () => { const e = await api.cloudSignUp(email.trim(), password, confirm); if (e === null) return finish(); setStage("confirm"); setInfo(`Мы отправили код на ${email.trim()}. Введите его ниже.`); setPassword(""); setConfirm(""); });
      case "confirm": return run(async () => { await api.cloudConfirm(email.trim(), code.trim()); await finish(); });
      case "forgot": return run(async () => { await api.cloudRequestReset(email.trim()); setStage("reset"); setInfo(`Код для сброса пароля отправлен на ${email.trim()}.`); });
      case "reset": return run(async () => { await api.cloudFinishReset(email.trim(), code.trim(), password, confirm); await finish(); });
      case "newPassword": return run(async () => { await api.cloudSetPasswordAfterRecovery(password, confirm); await finish(); });
    }
  };

  const title = mode === "local" ? (localMode === "login" ? "Вход на этом компьютере" : "Новый локальный аккаунт")
    : { signIn: "Вход", signUp: "Регистрация", confirm: "Подтверждение почты", forgot: "Восстановление пароля", reset: "Новый пароль", newPassword: "Новый пароль" }[stage];

  const canSubmit = mode === "local"
    ? user.trim() !== "" && password !== "" && (localMode === "login" || confirm !== "")
    : { signIn: emailOk && password !== "", signUp: emailOk && password !== "" && confirm !== "", confirm: code.trim().length >= 4, forgot: emailOk, reset: code.trim().length >= 4 && password !== "" && confirm !== "", newPassword: password !== "" && confirm !== "" }[stage];

  const submitLabel = mode === "local" ? (localMode === "login" ? "Войти" : "Создать аккаунт")
    : { signIn: "Войти", signUp: "Зарегистрироваться", confirm: "Подтвердить", forgot: "Получить код", reset: "Сменить пароль", newPassword: "Сохранить пароль" }[stage];

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={(e) => { e.preventDefault(); if (canSubmit && !busy) void submit(); }}>
        <div className="auth-brand"><Brand /><div className="col" style={{ gap: 0 }}><strong style={{ fontSize: "var(--fs-lg)" }}>Customers</strong><span className="faint">Поиск клиентов</span></div></div>
        {cloud && stage !== "newPassword" && (
          <Segmented value={mode} onChange={(m) => { setMode(m); setError(null); setInfo(null); setStage("signIn"); }} options={[{ value: "cloud", label: "Облачный аккаунт" }, { value: "local", label: "На этом компьютере" }]} />
        )}
        <h2>{title}</h2>
        {info && <Notice tone="info">{info}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}

        {mode === "cloud" ? (
          <>
            {stage !== "newPassword" && <Field label="Почта"><TextInput value={email} onChange={setEmail} placeholder="name@example.ru" type="email" disabled={stage === "confirm" || stage === "reset"} data-autofocus autoFocus /></Field>}
            {(stage === "confirm" || stage === "reset") && <Field label="Код из письма"><TextInput value={code} onChange={setCode} inputMode="numeric" autoFocus /></Field>}
            {(stage === "signIn" || stage === "signUp" || stage === "reset" || stage === "newPassword") && (
              <Field label={stage === "signIn" ? "Пароль" : "Новый пароль"} hint={stage !== "signIn" ? RULES : undefined}><PasswordInput value={password} onChange={setPassword} /></Field>
            )}
            {(stage === "signUp" || stage === "reset" || stage === "newPassword") && <Field label="Повторите пароль"><PasswordInput value={confirm} onChange={setConfirm} /></Field>}
          </>
        ) : (
          <>
            <Field label="Имя аккаунта">
              <TextInput value={user} onChange={setUser} list="accounts" autoFocus />
              <datalist id="accounts">{accounts.map((a) => <option key={a} value={a} />)}</datalist>
            </Field>
            <Field label="Пароль" hint={localMode === "register" ? RULES : undefined}><PasswordInput value={password} onChange={setPassword} /></Field>
            {localMode === "register" && <Field label="Повторите пароль"><PasswordInput value={confirm} onChange={setConfirm} /></Field>}
            <Checkbox checked={remember} onChange={setRemember} label="Запомнить на этом компьютере" />
          </>
        )}

        <Button variant="primary" type="submit" busy={busy} disabled={!canSubmit} className="auth-submit">{submitLabel}</Button>

        <div className="auth-links">
          {mode === "cloud" && stage === "signIn" && <><a onClick={() => go("signUp")}>Создать аккаунт</a><a onClick={() => go("forgot")}>Забыли пароль?</a></>}
          {mode === "cloud" && stage !== "signIn" && stage !== "newPassword" && <a onClick={() => go("signIn")}>← Ко входу</a>}
          {mode === "cloud" && stage === "confirm" && <a onClick={() => void run(async () => { await api.cloudResendConfirmation(email.trim()); setInfo("Код отправлен ещё раз."); })}>Отправить код ещё раз</a>}
          {mode === "local" && accounts.length > 0 && <a onClick={() => { setLocalMode(localMode === "login" ? "register" : "login"); setError(null); }}>{localMode === "login" ? "Создать новый аккаунт" : "← Войти в существующий"}</a>}
        </div>
      </form>
    </div>
  );
}
