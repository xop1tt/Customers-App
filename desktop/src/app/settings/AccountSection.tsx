import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { avatarFromFile } from "../../lib/avatar";
import { Avatar, Button, Field, Group, Notice, PasswordInput, SettingRow, Tag, TextInput } from "../../ui/kit";
import { Dialog, confirmDialog } from "../../ui/overlay";
import { attempt, leaveSession, toast, useStore } from "../../state/store";
import { syncView } from "../Sidebar";
import { nameLocked } from "../../lib/positions";
import { useActor } from "../team/actor";
import { RequestDialog } from "../team/Requests";
import { refreshTeam } from "../../state/team";

const PASSWORD_RULES = "Пароль: не короче 8 символов, строчные и заглавные буквы и цифры.";

export function AccountSection() {
  const session = useStore((s) => s.session);
  const sync = useStore((s) => s.sync);
  if (!session) return null;
  return (
    <>
      <div className="acct-head">
        <Avatar name={session.displayName} src={session.avatar} size={56} />
        <div className="col grow" style={{ gap: 2 }}>
          <h3 className="ellipsis">{session.displayName}</h3>
          <span className="muted">{syncView(sync)?.label ?? "Синхронизировано"}</span>
        </div>
        {sync?.enabled && <Button icon="refresh" busy={sync?.kind === "syncing"} onClick={() => void attempt(() => api.syncNow())}>Синхронизировать</Button>}
        <Button icon="logout" onClick={() => void leaveSession()}>Выйти</Button>
      </div>
      <ProfileGroup />
      {sync?.enabled && <CloudAccountActions />}
      <CloudAccount />
    </>
  );
}

function ProfileGroup() {
  const session = useStore((s) => s.session);
  const [name, setName] = useState(session?.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const ws = useStore((s) => s.ws);
  const team = useStore((s) => s.team);
  const actor = useActor();
  useEffect(() => { if (ws?.workspaces.find((w) => w.id === ws.active)?.remote) void refreshTeam(); }, [ws?.active]);
  // В облачном рабочем пространстве имя задаёт ответственный при оформлении; сотрудник меняет его только через руководителя (ADR-079).
  const locked = !!ws?.workspaces.find((w) => w.id === ws.active)?.remote && nameLocked(actor);
  const meMember = team.find((m) => m.user_id === ws?.me);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => setName(session?.displayName ?? ""), [session?.displayName]);
  if (!session) return null;
  const saveName = async () => {
    setBusy(true);
    await attempt(() => api.setProfile(name.trim()));
    setBusy(false);
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    const url = await attempt(() => avatarFromFile(f));
    if (url) { await attempt(() => api.setProfile(undefined, url)); toast("Фото сохранено и появится на других устройствах", "success"); }
  };
  return (
    <Group title="Профиль" sub="profile" note="Имя и фото хранятся в облаке и одинаковы на всех ваших устройствах.">
      <SettingRow title="Фото" hint="Квадратная картинка, лучше от 200 пикселей.">
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        <Button icon="upload" onClick={() => file.current?.click()}>{session.avatar ? "Заменить" : "Выбрать"}</Button>
        {session.avatar && <Button variant="ghost" onClick={() => void attempt(() => api.setProfile(undefined, ""))}>Убрать</Button>}
      </SettingRow>
      <SettingRow title="Имя" hint={locked ? "Имя профиля задал ответственный при оформлении. Изменить его можно только с разрешения руководителя." : "Показывается в приложении вместо адреса почты."}>
        <TextInput value={name} onChange={setName} maxLength={40} wrapClass="w-name" disabled={locked} aria-label="Имя" onKeyDown={(e) => { if (!locked && e.key === "Enter" && name.trim() && name.trim() !== session.displayName) void saveName(); }} />
        {locked ? (
          <Button icon="mail" disabled={!meMember} onClick={() => setAsking(true)}>Запрос на смену имени</Button>
        ) : (
          <Button busy={busy} disabled={!name.trim() || name.trim() === session.displayName} onClick={() => void saveName()}>Сохранить</Button>
        )}
      </SettingRow>
      {asking && meMember && <RequestDialog kind="name" author={meMember} team={team} current={session.displayName} onClose={() => setAsking(false)} />}
    </Group>
  );
}

function PasswordForm({ labels, onSubmit, rules = true }: { labels: [string, string, string]; onSubmit: (a: string, b: string, c: string) => Promise<unknown>; rules?: boolean }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [c, setC] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const ok = await attempt(async () => { await onSubmit(a, b, c); return true; });
    setBusy(false);
    if (ok) { setA(""); setB(""); setC(""); toast("Пароль изменён", "success"); }
  };
  return (
    <div className="col" style={{ gap: 12, maxWidth: 380 }}>
      <Field label={labels[0]}><PasswordInput value={a} onChange={setA} /></Field>
      <Field label={labels[1]} hint={rules ? PASSWORD_RULES : undefined}><PasswordInput value={b} onChange={setB} /></Field>
      <Field label={labels[2]}><PasswordInput value={c} onChange={setC} /></Field>
      <div><Button variant="primary" busy={busy} disabled={!a || !b || !c} onClick={() => void go()}>Изменить пароль</Button></div>
    </div>
  );
}

function CloudAccount() {
  const session = useStore((s) => s.session);
  const user = session?.cloudUser;
  const [dialog, setDialog] = useState<"email" | null>(null);
  if (!user) return null;
  return (
    <>
      <Group title="Почта" sub="security">
        <SettingRow title={<span className="row">{user.email}{user.confirmed ? <Tag tone="green">подтверждена</Tag> : <Tag tone="orange">не подтверждена</Tag>}</span>} hint={user.newEmail ? `Ожидает подтверждения новый адрес: ${user.newEmail}` : "Адрес для входа и восстановления пароля."}>
          <Button onClick={() => setDialog("email")}>{user.newEmail ? "Подтвердить новый адрес" : "Изменить"}</Button>
        </SettingRow>
      </Group>
      <Group title="Пароль" sub="security"><div style={{ paddingTop: 14 }}><PasswordForm labels={["Текущий пароль", "Новый пароль", "Повторите новый пароль"]} onSubmit={(o, n, c) => api.changeCloudPassword(o, n, c)} /></div></Group>
      {dialog === "email" && <EmailDialog onClose={() => setDialog(null)} />}
    </>
  );
}

/** Удаление облачного аккаунта: подраздел «Профиль». */
function CloudAccountActions() {
  const [dialog, setDialog] = useState<"delete" | null>(null);
  return (
    <>
      <Group title="Облачный аккаунт" sub="profile">
        <SettingRow title="Удалить облачный аккаунт" hint="Все облачные данные будут стёрты без возможности восстановления. Данные на этом компьютере останутся."><Button variant="danger" onClick={() => setDialog("delete")}>Удалить…</Button></SettingRow>
      </Group>
      {dialog === "delete" && <DeleteDialog onClose={() => setDialog(null)} />}
    </>
  );
}

function EmailDialog({ onClose }: { onClose: () => void }) {
  const user = useStore((s) => s.session?.cloudUser);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = user?.newEmail ?? null;
  const request = async () => {
    setBusy(true);
    const ok = await attempt(async () => { await api.changeCloudEmail(email.trim(), password); return true; });
    setBusy(false);
    if (ok) { setPassword(""); toast("Код отправлен на новый адрес"); }
  };
  const confirm = async () => {
    setBusy(true);
    const ok = await attempt(async () => { await api.confirmCloudEmail(pending ?? email.trim(), code.trim()); return true; });
    setBusy(false);
    if (ok) { toast("Адрес изменён", "success"); onClose(); }
  };
  return (
    <Dialog title="Изменить почту" onClose={onClose} width={440}>
      {pending ? (
        <div className="col" style={{ gap: 12 }}>
          <p className="muted">Код подтверждения отправлен на {pending}. Введите его ниже.</p>
          <Field label="Код из письма"><TextInput value={code} onChange={setCode} inputMode="numeric" data-autofocus /></Field>
          <div className="row"><Button variant="primary" busy={busy} disabled={code.trim().length < 4} onClick={() => void confirm()}>Подтвердить</Button><Button variant="ghost" onClick={() => void attempt(() => api.resendCloudEmailChange())}>Отправить код ещё раз</Button></div>
        </div>
      ) : (
        <div className="col" style={{ gap: 12 }}>
          <Field label="Новый адрес"><TextInput value={email} onChange={setEmail} placeholder="name@example.com" data-autofocus /></Field>
          <Field label="Пароль от аккаунта"><PasswordInput value={password} onChange={setPassword} /></Field>
          <div><Button variant="primary" busy={busy} disabled={!/^\S+@\S+\.\S+$/.test(email.trim()) || !password} onClick={() => void request()}>Получить код</Button></div>
        </div>
      )}
    </Dialog>
  );
}

function DeleteDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const ok = await confirmDialog({ title: "Удалить облачный аккаунт навсегда?", message: "Это действие нельзя отменить.", confirm: "Удалить навсегда", danger: true });
    if (!ok) return;
    setBusy(true);
    const r = await attempt(() => api.deleteCloudAccount(password));
    setBusy(false);
    if (r) { toast(r, "success"); onClose(); }
  };
  return (
    <Dialog title="Удалить облачный аккаунт" onClose={onClose} width={440} footer={<><Button variant="ghost" onClick={onClose}>Отмена</Button><Button variant="danger" busy={busy} disabled={!password} onClick={() => void go()}>Удалить…</Button></>}>
      <div className="col" style={{ gap: 12 }}>
        <Notice tone="warn">Облачные лиды, исключения и настройки будут стёрты. На других устройствах данные тоже исчезнут после синхронизации.</Notice>
        <Field label="Пароль от аккаунта"><PasswordInput value={password} onChange={setPassword} /></Field>
      </div>
    </Dialog>
  );
}
