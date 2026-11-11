// Переносимая копия (G8, ADR-062): все данные этого устройства в одном файле, зашифрованном ключом восстановления.
// Обычные резервные копии зашифрованы ключом устройства и на другом компьютере не открываются; эта — открывается.

import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { PortableState } from "../../api/types";
import { pickFile, pickSavePath } from "../../lib/platform";
import { formatRecoveryKey, normalizeRecoveryKey, RECOVERY_KEY_LENGTH } from "../../lib/recoveryKey";
import { Button, Checkbox, Field, Notice, Tag, TextInput } from "../../ui/kit";
import { Dialog, confirmDialog } from "../../ui/overlay";
import { copyToClipboard } from "../../state/actions";
import { attempt, boot, toast } from "../../state/store";

export const PORTABLE_EXTENSION = "customers";

/** Единственный показ нового ключа: закрыть можно только после отметки «Я сохранил ключ». */
export function RecoveryKeyDialog({ value, onDone }: { value: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <Dialog title="Ключ восстановления" onClose={() => { if (saved) onDone(); }} width={480} modal footer={
      <Button variant="primary" disabled={!saved} onClick={onDone}>Готово</Button>
    }>
      <div className="col" style={{ gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>Этим ключом шифруются переносимые копии. На новом компьютере его нужно будет ввести.</p>
        <div className="recovery-key selectable" aria-label="Ключ восстановления">{value}</div>
        <div className="row" style={{ gap: 8 }}>
          <Button icon="copy" onClick={() => void copyToClipboard(value, "Ключ скопирован")}>Скопировать</Button>
        </div>
        <Notice tone="warn">Ключ показывается один раз. Запишите его или сохраните в менеджере паролей. Без ключа копию не откроет никто, в том числе мы.</Notice>
        <Checkbox checked={saved} onChange={setSaved} label="Я сохранил ключ" />
      </div>
    </Dialog>
  );
}

/** Ввод ключа при открытии копии. */
export function KeyEntryDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (key: string) => void }) {
  const [value, setValue] = useState("");
  const [tried, setTried] = useState(false);
  const key = normalizeRecoveryKey(value);
  const submit = () => {
    setTried(true);
    if (key) onSubmit(formatRecoveryKey(key));
  };
  return (
    <Dialog title="Открыть переносимую копию" onClose={onClose} width={480} footer={
      <><Button variant="ghost" onClick={onClose}>Отмена</Button><Button variant="primary" onClick={submit}>Открыть</Button></>
    }>
      <form className="col" style={{ gap: 12 }} onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
        <p className="muted" style={{ margin: 0 }}>Введите ключ восстановления, который приложение показало при создании ключа. Текущие данные этого устройства перед заменой сохранятся в резервных копиях.</p>
        <Field label="Ключ восстановления" error={tried && !key ? `Ключ — ${RECOVERY_KEY_LENGTH} знаков: цифры и латинские буквы` : null}>
          <TextInput value={value} onChange={setValue} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" className="mono" autoFocus />
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

/** Создать ключ (или заменить) и показать его. Возвращает функцию запуска и окно показа. */
export function useCreateKey(onCreated: () => void) {
  const [shown, setShown] = useState<{ key: string; then?: () => void } | null>(null);
  const create = async (replace: boolean, then?: () => void) => {
    if (replace) {
      const ok = await confirmDialog({ title: "Заменить ключ восстановления?", message: "Новые копии будут шифроваться новым ключом. Уже сделанные копии по-прежнему открываются только прежним ключом.", confirm: "Заменить", danger: true });
      if (!ok) return;
    }
    const key = await attempt(() => api.createPortableKey(replace));
    if (key) { setShown({ key, then }); onCreated(); }
  };
  const dialog = shown && <RecoveryKeyDialog value={shown.key} onDone={() => { const then = shown.then; setShown(null); then?.(); }} />;
  return { create, dialog };
}

/** Блок «Перенос на другой компьютер» в настройках данных. */
export function PortableCopyRows() {
  const [state, setState] = useState<PortableState | null>(null);
  const [busy, setBusy] = useState<"save" | "open" | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const load = useCallback(() => { void api.portableState().then(setState).catch(() => {}); }, []);
  useEffect(load, [load]);
  const { create, dialog } = useCreateKey(load);

  const save = async () => {
    const path = await pickSavePath("Сохранить переносимую копию", `customers-${new Date().toISOString().slice(0, 10)}.${PORTABLE_EXTENSION}`, PORTABLE_EXTENSION);
    if (!path) return;
    setBusy("save");
    const r = await attempt(() => api.exportPortable(path));
    setBusy(null);
    if (r) toast(r, "success");
  };
  // Первая копия сначала создаёт и показывает ключ, затем сохраняет файл.
  const startSave = () => (state?.hasKey ? void save() : void create(false, () => void save()));
  const choose = async () => {
    const path = await pickFile("Открыть переносимую копию", [PORTABLE_EXTENSION]);
    if (!path) return;
    const ok = await confirmDialog({ title: "Заменить данные этого устройства?", message: "Лиды и локальные базы CRM будут заменены данными из копии. Перед этим приложение сохранит текущие данные в резервных копиях.", confirm: "Продолжить", danger: true });
    if (ok) setSource(path);
  };
  const open = async (key: string) => {
    const path = source;
    setSource(null);
    if (!path) return;
    setBusy("open");
    const r = await attempt(() => api.importPortable(path, key));
    setBusy(null);
    if (r) { toast(r, "success"); load(); await boot(); }
  };

  return (
    <>
      <div className="col" style={{ gap: 8, alignItems: "flex-end" }}>
        <div className="row" style={{ gap: 8 }}>
          <Button icon="download" busy={busy === "save"} onClick={startSave}>Сохранить копию…</Button>
          <Button icon="upload" busy={busy === "open"} onClick={() => void choose()}>Открыть копию…</Button>
        </div>
        {state && (
          <div className="row" style={{ gap: 8 }}>
            {state.hasKey ? <Tag tone="green">ключ создан</Tag> : <Tag>ключа нет</Tag>}
            <Button small variant="ghost" onClick={() => void create(state.hasKey)}>{state.hasKey ? "Заменить ключ…" : "Создать ключ…"}</Button>
          </div>
        )}
      </div>
      {source && <KeyEntryDialog onClose={() => setSource(null)} onSubmit={(k) => void open(k)} />}
      {dialog}
    </>
  );
}
