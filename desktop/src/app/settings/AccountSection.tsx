import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { fullRu } from "../../lib/format";
import { avatarFromFile } from "../../lib/avatar";
import { Avatar, Button, Field, Group, Notice, PasswordInput, SettingRow, Sub, Switch, Tag, TextInput } from "../../ui/kit";
import { Dialog, confirmDialog } from "../../ui/overlay";
import { attempt, leaveSession, toast, useStore } from "../../state/store";
import { syncView } from "../Sidebar";

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
          <span className="muted">{session.isCloud ? (syncView(sync)?.label ?? "Синхронизировано") : "Локальная учётная запись"}</span>
        </div>
        {session.isCloud && <Button icon="refresh" busy={sync?.kind === "syncing"} onClick={() => void attempt(() => api.syncNow())}>Синхронизировать</Button>}
        <Button icon="logout" onClick={() => void leaveSession()}>Выйти</Button>
      </div>
      <ProfileGroup />
      {session.isCloud && <CloudAccountActions />}
      {session.isCloud ? <CloudAccount /> : <LocalAccount />}
    </>
  );
}

function ProfileGroup() {
  const session = useStore((s) => s.session);
  const [name, setName] = useState(session?.displayName ?? "");
  const [busy, setBusy] = useState(false);
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
    if (url) { await attempt(() => api.setProfile(undefined, url)); toast(session.isCloud ? "Фото сохранено и появится на других устройствах" : "Фото сохранено", "success"); }
  };
  return (
    <Group title="Профиль" sub="profile" note={session.isCloud ? "Имя и фото хранятся в облаке и одинаковы на всех ваших устройствах." : "Имя и фото хранятся на этом компьютере."}>
      <SettingRow title="Фото" hint="Квадратная картинка, лучше от 200 пикселей.">
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        <Button icon="upload" onClick={() => file.current?.click()}>{session.avatar ? "Заменить" : "Выбрать"}</Button>
        {session.avatar && <Button variant="ghost" onClick={() => void attempt(() => api.setProfile(undefined, ""))}>Убрать</Button>}
      </SettingRow>
      <SettingRow title="Имя" hint="Показывается в приложении вместо адреса почты.">
        <TextInput value={name} onChange={setName} maxLength={40} wrapClass="w-name" onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && name.trim() !== session.displayName) void saveName(); }} />
        <Button busy={busy} disabled={!name.trim() || name.trim() === session.displayName} onClick={() => void saveName()}>Сохранить</Button>
      </SettingRow>
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

function LocalAccount() {
  const [remember, setRemember] = useState(false);
  const cloudAvailable = useStore((s) => s.boot?.cloudAvailable);
  useEffect(() => { void api.isRemembered().then(setRemember).catch(() => {}); }, []);
  return (
    <>
      <Group title="Вход" sub="security">
        <SettingRow title="Входить автоматически" hint="Приложение запомнит этот аккаунт на этом компьютере."><Switch checked={remember} onChange={(v) => { setRemember(v); void attempt(() => api.setRemembered(v)); }} /></SettingRow>
      </Group>
      <Group title="Пароль" sub="security" note="Пароль защищает базу данных на этом компьютере. Забытый пароль восстановить нельзя.">
        <div style={{ paddingTop: 14 }}><PasswordForm labels={["Текущий пароль", "Новый пароль", "Повторите новый пароль"]} onSubmit={(o, n, c) => api.changePassword(o, n, c)} /></div>
      </Group>
      {cloudAvailable && <Sub id="security"><Notice tone="info">Чтобы синхронизировать данные между компьютерами, выйдите и войдите в облачный аккаунт. Данные локального аккаунта можно перенести при первом входе.</Notice></Sub>}
    </>
  );
}

function CloudAccount() {
  const session = useStore((s) => s.session);
  const sync = useStore((s) => s.sync);
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
      <Group title="Синхронизация" sub="cloud">
        <SettingRow title={sync?.kind === "syncing" ? "Синхронизация…" : sync?.kind === "offline" ? "Нет связи с сервером" : sync?.kind === "failed" ? "Последняя синхронизация не удалась" : "Данные синхронизированы"}
          hint={`${sync?.lastSync ? `Последний раз: ${fullRu(sync.lastSync)}. ` : ""}${sync?.message ?? ""}${sync?.pending ? ` Ждут отправки: ${sync.pending}.` : ""}`} />
      </Group>
      <Group title="Пароль" sub="security"><div style={{ paddingTop: 14 }}><PasswordForm labels={["Текущий пароль", "Новый пароль", "Повторите новый пароль"]} onSubmit={(o, n, c) => api.changeCloudPassword(o, n, c)} /></div></Group>
      {dialog === "email" && <EmailDialog onClose={() => setDialog(null)} />}
    </>
  );
}

/** Перенос локального аккаунта и удаление облачного: подраздел «Профиль». */
function CloudAccountActions() {
  const [dialog, setDialog] = useState<"import" | "delete" | null>(null);
  return (
    <>
      <Group title="Облачный аккаунт" sub="profile">
        <SettingRow title="Перенести локальный аккаунт" hint="Добавит лиды и настройки локального аккаунта в облачный. Локальный аккаунт останется на месте."><Button onClick={() => setDialog("import")}>Перенести…</Button></SettingRow>
        <SettingRow title="Удалить облачный аккаунт" hint="Все облачные данные будут стёрты без возможности восстановления. Данные на этом компьютере останутся."><Button variant="danger" onClick={() => setDialog("delete")}>Удалить…</Button></SettingRow>
      </Group>
      {dialog === "import" && <ImportDialog onClose={() => setDialog(null)} />}
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
          <Field label="Новый адрес"><TextInput value={email} onChange={setEmail} placeholder="name@example.ru" data-autofocus /></Field>
          <Field label="Пароль от аккаунта"><PasswordInput value={password} onChange={setPassword} /></Field>
          <div><Button variant="primary" busy={busy} disabled={!/^\S+@\S+\.\S+$/.test(email.trim()) || !password} onClick={() => void request()}>Получить код</Button></div>
        </div>
      )}
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.localAccounts().then((n) => { setNames(n); setName(n[0] ?? ""); }).catch(() => {}); }, []);
  const go = async () => {
    setBusy(true);
    const r = await attempt(() => api.importLocal(name, password));
    setBusy(false);
    if (r) { toast(r, "success"); onClose(); }
  };
  return (
    <Dialog title="Перенести локальный аккаунт" onClose={onClose} width={440} footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" busy={busy} disabled={!name || !password} onClick={() => void go()}>Перенести</Button></>}>
      {names.length === 0 ? <p className="muted">На этом компьютере нет локальных аккаунтов.</p> : (
        <div className="col" style={{ gap: 12 }}>
          <Field label="Локальный аккаунт"><TextInput value={name} onChange={setName} list="local-accounts" /></Field>
          <datalist id="local-accounts">{names.map((n) => <option key={n} value={n} />)}</datalist>
          <Field label="Пароль локального аккаунта"><PasswordInput value={password} onChange={setPassword} /></Field>
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
    <Dialog title="Удалить облачный аккаунт" onClose={onClose} width={440} footer={<><Button onClick={onClose}>Отмена</Button><Button variant="danger" busy={busy} disabled={!password} onClick={() => void go()}>Удалить…</Button></>}>
      <div className="col" style={{ gap: 12 }}>
        <Notice tone="warn">Облачные лиды, исключения и настройки будут стёрты. На других устройствах данные тоже исчезнут после синхронизации.</Notice>
        <Field label="Пароль от аккаунта"><PasswordInput value={password} onChange={setPassword} /></Field>
      </div>
    </Dialog>
  );
}
