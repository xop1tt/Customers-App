// «Опасная зона» рабочего пространства: передать владение и удалить рабочее пространство. Только владелец.
// Обе операции необратимы из приложения, поэтому требуют повторного ввода названия.

import { useState } from "react";
import { api } from "../../api";
import { Button, Field, Notice, SettingRow, Group, Select, TextInput } from "../../ui/kit";
import { Dialog } from "../../ui/overlay";
import { attempt, openSettings, refreshWorkspace, setState, toast, useStore } from "../../state/store";

export function DangerZone() {
  const ws = useStore((s) => s.ws);
  const [mode, setMode] = useState<"transfer" | "delete" | null>(null);
  const current = ws?.workspaces.find((w) => w.id === ws.active);
  const perms = ws?.permissions ?? [];
  if (!ws || !current || current.personal || !ws.isCloud) return null;
  const canTransfer = perms.includes("ownership.transfer");
  const canDelete = perms.includes("workspace.delete");
  if (!canTransfer && !canDelete) return null;
  return (
    <Group title="Опасная зона">
      {canTransfer && (
        <SettingRow title="Передать владение" hint="Другой участник станет владельцем, вы станете администратором.">
          <Button small variant="danger" onClick={() => setMode("transfer")}>Передать…</Button>
        </SettingRow>
      )}
      {canDelete && (
        <SettingRow title="Удалить рабочее пространство" hint="Данные команды будут удалены для всех участников.">
          <Button small variant="danger" onClick={() => setMode("delete")}>Удалить…</Button>
        </SettingRow>
      )}
      {mode === "transfer" && <TransferDialog name={current.name} onClose={() => setMode(null)} />}
      {mode === "delete" && <DeleteDialog name={current.name} onClose={() => setMode(null)} />}
    </Group>
  );
}

function NameConfirm({ name, value, onChange }: { name: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Введите название рабочего пространства" hint={name}>
      <TextInput value={value} onChange={onChange} aria-label="Название рабочего пространства" autoFocus />
    </Field>
  );
}

export function TransferDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const members = useStore((s) => s.ws?.members ?? []);
  const me = useStore((s) => s.ws?.me);
  const others = members.filter((m) => m.userId !== me);
  const [to, setTo] = useState(others[0]?.userId ?? "");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const target = others.find((m) => m.userId === to)?.displayName ?? "";
  const ok = !!to && typed.trim() === name;
  const run = async () => {
    setBusy(true);
    const r = await attempt(() => api.wsTransferOwnership(to));
    setBusy(false);
    if (r) { await refreshWorkspace(); toast(`Владелец теперь ${target}`, "success"); onClose(); }
  };
  return (
    <Dialog title={target ? `Передать владение «${name}» участнику ${target}?` : "Передать владение"} onClose={busy ? () => undefined : onClose} width={520} footer={
      <>
        <span className="grow" />
        <Button variant="ghost" disabled={busy} onClick={onClose}>Отмена</Button>
        <Button variant="danger" busy={busy} disabled={!ok} onClick={() => void run()}>Передать владение</Button>
      </>
    }>
      <div className="col" style={{ gap: 12, alignItems: "stretch" }}>
        {others.length === 0 ? <Notice>В рабочем пространстве нет других участников. Сначала пригласите коллегу.</Notice> : (
          <>
            <Select value={to} onChange={setTo} label="Новый владелец" options={others.map((m) => ({ value: m.userId, label: m.displayName, hint: m.roleName }))} />
            <div>{target} станет владельцем: сможет удалить рабочее пространство и передать владение дальше. Вы останетесь администратором и сможете работать как раньше, но вернуть владение сможете только если {target} вам его передаст.</div>
            <NameConfirm name={name} value={typed} onChange={setTyped} />
          </>
        )}
      </div>
    </Dialog>
  );
}

export function DeleteDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = typed.trim() === name;
  const run = async () => {
    setBusy(true);
    const r = await attempt(() => api.wsDeleteWorkspace(typed.trim()));
    setBusy(false);
    if (r) { await refreshWorkspace(); toast("Рабочее пространство удалено", "success"); setState({ workspaceOpen: false }); onClose(); }
  };
  return (
    <Dialog title={`Удалить «${name}»?`} onClose={busy ? () => undefined : onClose} width={520} footer={
      <>
        <span className="grow" />
        <Button variant="ghost" disabled={busy} onClick={onClose}>Отмена</Button>
        <Button variant="danger" busy={busy} disabled={!ok} onClick={() => void run()}>Удалить навсегда</Button>
      </>
    }>
      <div className="col" style={{ gap: 12, alignItems: "stretch" }}>
        <div>Все участники сразу потеряют доступ к компаниям, контактам, сделкам, задачам и чатам этого рабочего пространства. Данные хранятся на сервере ещё 30 дней и затем удаляются без возможности восстановления. Копии на устройствах участников будут удалены при следующей синхронизации.</div>
        <Notice tone="warn" action={<Button small icon="download" onClick={() => { setState({ workspaceOpen: false }); openSettings("data", "portable"); }}>Выгрузить CRM</Button>}>
          Перед удалением сделайте выгрузку CRM: «Настройки → Данные».
        </Notice>
        <NameConfirm name={name} value={typed} onChange={setTyped} />
      </div>
    </Dialog>
  );
}
