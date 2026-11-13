import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, Checkbox, Field, Notice, PasswordInput, TextInput } from "../ui/kit";
import appIcon from "../assets/app-icon.png";
import appIconLight from "../assets/app-icon-light.png";
import { enterSession, errText, setState, toast, useStore } from "../state/store";
import { useEvent } from "../state/hooks";

type Stage = "signIn" | "signUp" | "confirm" | "forgot" | "reset" | "newPassword";
const RULES = "Пароль: не короче 8 символов, строчные и заглавные буквы и цифры.";

/** Значок приложения (тот же, что в системе). */
export function Brand({ size = 44 }: { size?: number }) {
  return (
    <>
      <img className="brand icon-dark" src={appIcon} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
      <img className="brand icon-light" src={appIconLight} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
    </>
  );
}

export function AuthScreen() {
  const boot = useStore((s) => s.boot);
  const callback = useStore((s) => s.authCallback);
  // Облако доступно — вход только в него. Локальный вход остаётся запасным путём лишь для сборок без настроенного облака (разработка, приёмочные проверки).
  const localOnly = !!boot && !boot.cloudAvailable;
  const [stage, setStage] = useState<Stage>("signIn");
  const [user, setUser] = useState("");
  const [remember, setRemember] = useState(false);
  const [localMode, setLocalMode] = useState<"login" | "register">("login");
  const [accounts, setAccounts] = useState<string[]>([]);
  useEffect(() => {
    if (!localOnly) return;
    void api.localAccounts().then((a) => { setAccounts(a); setUser(boot?.device.rememberedUser ?? a[0] ?? ""); if (a.length === 0) setLocalMode("register"); }).catch(() => {});
  }, [localOnly, boot?.device.rememberedUser]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");

  useEffect(() => { if (callback?.kind === "newPassword") { setStage("newPassword"); setError(null); } }, [callback]);
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
    if (localOnly) {
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
      case "signUp": return run(async () => { const e = await api.cloudSignUp(email.trim(), password, confirm, username.trim()); if (e === null) return finish(); setStage("confirm"); setInfo(`Мы отправили код на ${email.trim()}. Введите его ниже.`); setPassword(""); setConfirm(""); });
      case "confirm": return run(async () => { await api.cloudConfirm(email.trim(), code.trim()); await finish(); });
      case "forgot": return run(async () => { await api.cloudRequestReset(email.trim()); setStage("reset"); setInfo(`Код для сброса пароля отправлен на ${email.trim()}.`); });
      case "reset": return run(async () => { await api.cloudFinishReset(email.trim(), code.trim(), password, confirm); await finish(); });
      case "newPassword": return run(async () => { await api.cloudSetPasswordAfterRecovery(password, confirm); await finish(); });
    }
  };

  const title = localOnly ? (localMode === "login" ? "Вход" : "Регистрация") : { signIn: "Вход", signUp: "Регистрация", confirm: "Подтверждение почты", forgot: "Восстановление пароля", reset: "Новый пароль", newPassword: "Новый пароль" }[stage];

  const canSubmit = localOnly ? user.trim() !== "" && password !== "" && (localMode === "login" || confirm !== "") : { signIn: emailOk && password !== "", signUp: emailOk && username.trim() !== "" && password !== "" && confirm !== "", confirm: code.trim().length >= 4, forgot: emailOk, reset: code.trim().length >= 4 && password !== "" && confirm !== "", newPassword: password !== "" && confirm !== "" }[stage];

  const submitLabel = localOnly ? (localMode === "login" ? "Войти" : "Создать аккаунт") : { signIn: "Войти", signUp: "Зарегистрироваться", confirm: "Подтвердить", forgot: "Получить код", reset: "Сменить пароль", newPassword: "Сохранить пароль" }[stage];

  return (
    <div className="auth">
      <div className="auth-stack">
        <img className="brand auth-logo-img" src={appIcon} width={132} height={132} alt="" aria-hidden="true" draggable={false} />
      <form className="auth-card" aria-label={title} onSubmit={(e) => { e.preventDefault(); if (canSubmit && !busy) void submit(); }}>
        <h2 className="auth-title">{title}</h2>
        {info && <Notice tone="info">{info}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}

        {localOnly ? (
          <>
            <Field label="Имя аккаунта">
              <TextInput value={user} onChange={setUser} list="accounts" name="username" autoComplete="username" autoFocus />
              <datalist id="accounts">{accounts.map((a) => <option key={a} value={a} />)}</datalist>
            </Field>
            <Field label="Пароль" hint={localMode === "register" ? RULES : undefined}><PasswordInput value={password} onChange={setPassword} name="password" autoComplete={localMode === "login" ? "current-password" : "new-password"} /></Field>
            {localMode === "register" && <Field label="Повторите пароль"><PasswordInput value={confirm} onChange={setConfirm} name="confirm-password" autoComplete="new-password" /></Field>}
            <Checkbox checked={remember} onChange={setRemember} label="Запомнить на этом компьютере" />
          </>
        ) : (
          <>
            {stage === "signUp" && <Field label="Имя пользователя" hint="Так вас будут видеть в приложении. Изменить имя можно в настройках."><TextInput value={username} onChange={setUsername} name="nickname" autoComplete="nickname" maxLength={40} data-autofocus autoFocus /></Field>}
            {stage !== "newPassword" && <Field label="Почта"><TextInput value={email} onChange={setEmail} placeholder="name@example.com" type="email" name="email" autoComplete={stage === "signUp" ? "email" : "username"} disabled={stage === "confirm" || stage === "reset"} data-autofocus={stage !== "signUp"} autoFocus={stage !== "signUp"} /></Field>}
            {(stage === "confirm" || stage === "reset") && <Field label="Код из письма"><TextInput value={code} onChange={setCode} inputMode="numeric" name="code" autoComplete="one-time-code" autoFocus /></Field>}
            {(stage === "signIn" || stage === "signUp" || stage === "reset" || stage === "newPassword") && (
              <Field label={stage === "signIn" ? "Пароль" : "Новый пароль"} hint={stage !== "signIn" ? RULES : undefined}><PasswordInput value={password} onChange={setPassword} name="password" autoComplete={stage === "signIn" ? "current-password" : "new-password"} /></Field>
            )}
            {(stage === "signUp" || stage === "reset" || stage === "newPassword") && <Field label="Повторите пароль"><PasswordInput value={confirm} onChange={setConfirm} name="confirm-password" autoComplete="new-password" /></Field>}
          </>
        )}

        <Button variant="primary" type="submit" busy={busy} disabled={!canSubmit} className="auth-submit">{submitLabel}</Button>

        <div className="auth-links">
          {localOnly && accounts.length > 0 && <button type="button" className="link" onClick={() => { setLocalMode(localMode === "login" ? "register" : "login"); setError(null); }}>{localMode === "login" ? "Создать новый аккаунт" : "← Войти в существующий"}</button>}
          {!localOnly && stage === "signIn" && <><button type="button" className="link" onClick={() => go("signUp")}>Создать аккаунт</button><button type="button" className="link" onClick={() => go("forgot")}>Забыли пароль?</button></>}
          {!localOnly && stage !== "signIn" && stage !== "newPassword" && <button type="button" className="link" onClick={() => go("signIn")}>← Ко входу</button>}
          {!localOnly && stage === "confirm" && <button type="button" className="link" onClick={() => void run(async () => { await api.cloudResendConfirmation(email.trim()); setInfo("Код отправлен ещё раз."); })}>Отправить код ещё раз</button>}
        </div>
      </form>
      </div>
    </div>
  );
}
