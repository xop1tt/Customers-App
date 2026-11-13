import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, Field, Notice, PasswordInput, TextInput } from "../ui/kit";
import appIcon from "../assets/app-icon.png";
import appIconLight from "../assets/app-icon-light.png";
import { enterSession, errText, setState, useStore } from "../state/store";
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
  const [stage, setStage] = useState<Stage>("signIn");
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
    switch (stage) {
      case "signIn": return run(async () => { await api.cloudSignIn(email.trim(), password); await finish(); });
      case "signUp": return run(async () => { const e = await api.cloudSignUp(email.trim(), password, confirm, username.trim()); if (e === null) return finish(); setStage("confirm"); setInfo(`Мы отправили код на ${email.trim()}. Введите его ниже.`); setPassword(""); setConfirm(""); });
      case "confirm": return run(async () => { await api.cloudConfirm(email.trim(), code.trim()); await finish(); });
      case "forgot": return run(async () => { await api.cloudRequestReset(email.trim()); setStage("reset"); setInfo(`Код для сброса пароля отправлен на ${email.trim()}.`); });
      case "reset": return run(async () => { await api.cloudFinishReset(email.trim(), code.trim(), password, confirm); await finish(); });
      case "newPassword": return run(async () => { await api.cloudSetPasswordAfterRecovery(password, confirm); await finish(); });
    }
  };

  const title = { signIn: "Вход", signUp: "Регистрация", confirm: "Подтверждение почты", forgot: "Восстановление пароля", reset: "Новый пароль", newPassword: "Новый пароль" }[stage];

  const canSubmit = { signIn: emailOk && password !== "", signUp: emailOk && username.trim() !== "" && password !== "" && confirm !== "", confirm: code.trim().length >= 4, forgot: emailOk, reset: code.trim().length >= 4 && password !== "" && confirm !== "", newPassword: password !== "" && confirm !== "" }[stage];

  const submitLabel = { signIn: "Войти", signUp: "Зарегистрироваться", confirm: "Подтвердить", forgot: "Получить код", reset: "Сменить пароль", newPassword: "Сохранить пароль" }[stage];

  return (
    <div className="auth">
      <div className="auth-stack">
        <img className="brand auth-logo-img" src={appIcon} width={132} height={132} alt="" aria-hidden="true" draggable={false} />
      <form className="auth-card" aria-label={title} onSubmit={(e) => { e.preventDefault(); if (canSubmit && !busy) void submit(); }}>
        <h2 className="auth-title">{title}</h2>
        {info && <Notice tone="info">{info}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}

        {boot && !boot.cloudAvailable && <Notice tone="error">Облако недоступно в этой сборке: войти нельзя. Установите актуальную версию приложения.</Notice>}
        {(
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

        <Button variant="primary" type="submit" busy={busy} disabled={!canSubmit || (!!boot && !boot.cloudAvailable)} className="auth-submit">{submitLabel}</Button>

        <div className="auth-links">
          {stage === "signIn" && <><button type="button" className="link" onClick={() => go("signUp")}>Создать аккаунт</button><button type="button" className="link" onClick={() => go("forgot")}>Забыли пароль?</button></>}
          {stage !== "signIn" && stage !== "newPassword" && <button type="button" className="link" onClick={() => go("signIn")}>← Ко входу</button>}
          {stage === "confirm" && <button type="button" className="link" onClick={() => void run(async () => { await api.cloudResendConfirmation(email.trim()); setInfo("Код отправлен ещё раз."); })}>Отправить код ещё раз</button>}
        </div>
      </form>
      </div>
    </div>
  );
}
