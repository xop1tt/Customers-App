import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { avatarFromFile } from "../../lib/avatar";
import { Avatar, Button, Group, SettingRow, TextInput } from "../../ui/kit";
import { attempt, toast, useStore } from "../../state/store";

/** Учётная запись: только профиль на этом компьютере. Входа, облака и пароля нет (ADR-100). */
export function AccountSection() {
  const session = useStore((s) => s.session);
  if (!session) return null;
  return (
    <>
      <div className="acct-head">
        <Avatar name={session.displayName} src={session.avatar} size={56} />
        <div className="col grow" style={{ gap: 2 }}>
          <h3 className="ellipsis">{session.displayName}</h3>
          <span className="muted">Данные хранятся на этом компьютере</span>
        </div>
      </div>
      <ProfileGroup />
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
    if (url) { await attempt(() => api.setProfile(undefined, url)); toast("Фото сохранено", "success"); }
  };
  return (
    <Group title="Профиль" sub="profile" note="Имя и фото хранятся только на этом компьютере.">
      <SettingRow title="Фото" hint="Квадратная картинка, лучше от 200 пикселей.">
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        <Button icon="upload" onClick={() => file.current?.click()}>{session.avatar ? "Заменить" : "Выбрать"}</Button>
        {session.avatar && <Button variant="ghost" onClick={() => void attempt(() => api.setProfile(undefined, ""))}>Убрать</Button>}
      </SettingRow>
      <SettingRow title="Имя" hint="Показывается в приложении и в карточках CRM.">
        <TextInput value={name} onChange={setName} maxLength={40} wrapClass="w-name" aria-label="Имя" onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && name.trim() !== session.displayName) void saveName(); }} />
        <Button busy={busy} disabled={!name.trim() || name.trim() === session.displayName} onClick={() => void saveName()}>Сохранить</Button>
      </SettingRow>
    </Group>
  );
}
