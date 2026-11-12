// Рабочее пространство: выбор и создание Workspace, участники и роли, приглашения, очередь синхронизации.

import { useState } from "react";
import { api } from "../../api";
import type { WsInvite, WsOp } from "../../api/types";
import { copyText } from "../../lib/platform";
import { integer, shortRelative } from "../../lib/format";
import { Avatar, Button, Group, IconButton, Notice, Select, SettingRow, Tag, TextInput } from "../../ui/kit";
import { Dialog, confirmDialog } from "../../ui/overlay";
import { attempt, refreshWorkspace, setState, toast, useStore } from "../../state/store";
import { useWsQuery } from "./useCrm";
import { PipelineEditor, RolesEditor } from "./Editors";
import { HandoverDialog, type HandoverTarget } from "./Handover";
import { usePresence } from "./Presence";
import { CustomFieldsEditor } from "./CustomFields";

const ROLES = [
  { value: "admin", label: "Администратор" },
  { value: "manager", label: "Менеджер" },
  { value: "employee", label: "Сотрудник" },
  { value: "viewer", label: "Наблюдатель" },
];

export function WorkspaceDialog() {
  const open = useStore((s) => s.workspaceOpen);
  if (!open) return null;
  return <WorkspaceDialogBody />;
}

function WorkspaceDialogBody() {
  const ws = useStore((s) => s.ws);
  const [name, setName] = useState("");
  const [rename, setRename] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [editor, setEditor] = useState<"pipelines" | "roles" | "fields" | null>(null);
  const close = () => setState({ workspaceOpen: false });
  if (!ws) {
    return (
      <Dialog title="Рабочее пространство" onClose={close} width={520}>
        <Notice tone="error">База рабочего пространства не открылась. Проверьте журнал ошибок в настройках «Отчёты».</Notice>
      </Dialog>
    );
  }
  const current = ws.workspaces.find((w) => w.id === ws.active);
  const perms = ws.permissions;
  const done = async (p: Promise<unknown>) => { const r = await attempt(() => p); await refreshWorkspace(); return r; };

  return (
    <Dialog title="Рабочее пространство" onClose={close} width={600} className="ws-dialog">
      <Group title="Рабочее пространство" note={ws.isCloud ? "Данные CRM общие для участников и синхронизируются через облако." : "Локальная учётная запись: рабочее пространство хранится только на этом компьютере. Совместная работа — в облачной учётной записи."}>
        <SettingRow title="Текущий">
          <Select value={ws.active ?? ""} width={260} onChange={(id) => void done(api.wsSwitch(id))} options={ws.workspaces.map((w) => ({ value: w.id, label: w.name, hint: w.roleName }))} />
        </SettingRow>
        {current && perms.includes("workspace.manage") && (
          <SettingRow title="Название">
            {rename === null ? <Button small icon="edit" onClick={() => setRename(current.name)}>Переименовать</Button> : (
              <div className="row" style={{ gap: 6 }}>
                <TextInput value={rename} onChange={setRename} maxLength={120} aria-label="Новое название" />
                <Button small variant="primary" onClick={() => void done(api.wsRenameWorkspace(rename)).then(() => setRename(null))}>Сохранить</Button>
              </div>
            )}
          </SettingRow>
        )}
        <SettingRow title="Новое рабочее пространство" hint="Например, для отдельной команды или компании. Вы станете владельцем.">
          <div className="row" style={{ gap: 6 }}>
            <TextInput value={name} onChange={setName} maxLength={120} placeholder="Название" aria-label="Название нового рабочего пространства" />
            <Button small icon="plus" disabled={!name.trim()} onClick={() => void done(api.wsCreateWorkspace(name)).then((r) => { if (r) setName(""); })}>Создать</Button>
          </div>
        </SettingRow>
        {ws.isCloud && (
          <SettingRow title="Приглашение" hint="Вставьте ссылку или код из приглашения.">
            <div className="row" style={{ gap: 6 }}>
              <TextInput value={token} onChange={setToken} placeholder="Ссылка или код из приглашения" aria-label="Код приглашения" />
              <Button small disabled={!token.trim()} onClick={() => void done(api.wsAcceptInvitation(token)).then((r) => { if (r) { setToken(""); toast("Вы присоединились к рабочему пространству", "success"); } })}>Принять</Button>
            </div>
          </SettingRow>
        )}
      </Group>

      {current && (
        <Group title="Настройка CRM">
          <SettingRow title="Воронки и этапы" hint="Названия, порядок, вероятность, тип этапа.">
            <Button small icon="edit" onClick={() => setEditor("pipelines")}>Настроить воронки</Button>
          </SettingRow>
          {ws.isCloud && !current.remote && (
            <SettingRow title="Загрузить в облако" hint="Создаст облачное рабочее пространство с копией записей этого локального. Локальный останется как есть; повторная загрузка не плодит дубли.">
              <Button small icon="upload" onClick={async () => {
                if (!(await confirmDialog({ title: `Загрузить «${current.name}» в облако?`, message: "Записи, задачи и заметки станут доступны участникам нового облачного рабочего пространства.", confirm: "Загрузить" }))) return;
                const r = await attempt(() => api.wsUploadLocal());
                await refreshWorkspace();
                if (r) toast(`Загружено записей: ${integer(r.copied)}${r.skipped ? `, пропущено: ${integer(r.skipped)} (см. журнал ошибок)` : ""}`, r.skipped ? "error" : "success");
              }}>Загрузить</Button>
            </SettingRow>
          )}
          <SettingRow title="Свои поля" hint="Дополнительные поля в карточках компаний, контактов, лидов и сделок.">
            <Button small icon="edit" onClick={() => setEditor("fields")}>Настроить поля</Button>
          </SettingRow>
          {ws.isCloud && (
            <SettingRow title="Роли" hint="Свои роли с набором разрешений.">
              <Button small icon="shield" onClick={() => setEditor("roles")}>Управлять ролями</Button>
            </SettingRow>
          )}
        </Group>
      )}
      {editor === "pipelines" && <PipelineEditor onClose={() => setEditor(null)} />}
      {editor === "fields" && <CustomFieldsEditor onClose={() => setEditor(null)} />}
      {editor === "roles" && <RolesEditor onClose={() => setEditor(null)} />}
      {ws.isCloud && current && <Members />}
      {ws.isCloud && current && perms.includes("invitations.manage") && <Invite />}
      <SyncQueue />

      {ws.isCloud && current && !current.personal && (
        <Group title="Выход">
          <SettingRow title="Покинуть рабочее пространство" hint="Локальная копия данных этого рабочего пространства будет удалена с устройства. Владелец не может выйти, пока не передаст владение.">
            <Button small variant="danger" onClick={async () => {
              if (await confirmDialog({ title: `Покинуть «${current.name}»?`, message: "Доступ к данным пропадёт. Вернуться можно только по новому приглашению.", confirm: "Покинуть", danger: true })) void done(api.wsLeave());
            }}>Покинуть</Button>
          </SettingRow>
        </Group>
      )}
    </Dialog>
  );
}

function Members() {
  const ws = useStore((s) => s.ws)!;
  const { data: rolesData } = useWsQuery(() => api.wsRoles().catch(() => null), []);
  const roleOptions = rolesData?.roles.length ? rolesData.roles.filter((r) => r.key !== "owner").map((r) => ({ value: r.key, label: r.name })) : ROLES;
  const rankOf = (key: string) => rolesData?.roles.find((r) => r.key === key)?.rank ?? ({ admin: 80, manager: 60, employee: 40, viewer: 20 } as Record<string, number>)[key] ?? 0;
  const manage = ws.permissions.includes("members.manage");
  const online = new Set(usePresence().map((p) => p.user_id));
  const myRank = ws.workspaces.find((w) => w.id === ws.active)?.rank ?? 0;
  const canHand = ws.permissions.includes("records.edit");
  const [hand, setHand] = useState<{ target: HandoverTarget; leaving: boolean } | null>(null);
  return (
    <Group title={`Участники · ${integer(ws.members.length)}`}>
      <ul className="ws-member-list">
        {ws.members.map((m) => {
          const editable = manage && m.userId !== ws.me && m.rank < myRank && m.role !== "owner";
          return (
            <li key={m.userId} className="ws-member">
              <Avatar name={m.displayName} src={m.avatarPath} size={28} />
              <span className="col grow" style={{ gap: 0, minWidth: 0 }}>
                <span className="ellipsis">{(m.userId === ws.me || online.has(m.userId)) && <span className="presence-dot" title="Онлайн" />}{m.displayName}{m.userId === ws.me ? <span className="faint"> · вы</span> : null}</span>
                {m.email && <span className="faint ellipsis" style={{ fontSize: "var(--fs-sm)" }}>{m.email}</span>}
              </span>
              {editable ? (
                <>
                  <Select small value={m.role} width={150} onChange={(role) => void attempt(() => api.wsSetMemberRole(m.userId, role)).then(() => refreshWorkspace())}
                    options={roleOptions.filter((r) => rankOf(r.value) < myRank)} />
                  {canHand && <IconButton icon="users" tip="Передать записи коллеге" onClick={() => setHand({ target: { userId: m.userId, displayName: m.displayName }, leaving: false })} />}
                  <IconButton icon="x" tip="Удалить из рабочего пространства" onClick={() => setHand({ target: { userId: m.userId, displayName: m.displayName }, leaving: true })} />
                </>
              ) : <Tag>{m.roleName}</Tag>}
            </li>
          );
        })}
      </ul>
      {hand && <HandoverDialog from={hand.target} leaving={hand.leaving} onClose={() => setHand(null)} onRemove={async () => { await api.wsRemoveMember(hand.target.userId); }} />}
    </Group>
  );
}

function Invite() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("employee");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<WsInvite | null>(null);
  const send = async () => {
    setBusy(true);
    const r = await attempt(() => api.wsInvite(email.trim(), role));
    setBusy(false);
    if (r) { setSent(r); setEmail(""); }
  };
  return (
    <Group title="Пригласить" note="Письмо не отправляется автоматически: передайте ссылку приглашённому сами. Она действует 7 дней и показывается один раз.">
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <TextInput value={email} onChange={setEmail} type="email" placeholder="почта коллеги" aria-label="Почта приглашённого" wrapClass="grow" />
        <Select value={role} onChange={setRole} options={ROLES} width={160} />
        <Button variant="primary" busy={busy} disabled={!email.includes("@")} onClick={() => void send()}>Пригласить</Button>
      </div>
      {sent && (
        <Notice tone="ok" action={<Button small icon="copy" onClick={() => void copyText(sent.link).then(() => toast("Ссылка скопирована", "success"))}>Копировать</Button>}>
          Приглашение для {sent.email} создано. <span className="selectable mono">{sent.link}</span>
        </Notice>
      )}
    </Group>
  );
}

function SyncQueue() {
  const ws = useStore((s) => s.ws)!;
  const { data } = useWsQuery(() => api.wsConflicts(), []);
  const rejected: WsOp[] = data?.rejected ?? [];
  return (
    <Group title="Синхронизация">
      <SettingRow title="Состояние" hint={ws.error ?? (ws.lastSync ? `Последняя: ${shortRelative(ws.lastSync)}` : ws.isCloud ? "Ещё не выполнялась" : "Только на этом устройстве")}>
        <div className="row" style={{ gap: 8 }}>
          {ws.pending > 0 && <Tag tone="orange">Ждут отправки: {integer(ws.pending)}</Tag>}
          {ws.conflicts > 0 && <Tag tone="orange">Конфликтов: {integer(ws.conflicts)}</Tag>}
          {ws.isCloud && <Button small icon="refresh" busy={ws.syncing} onClick={() => void attempt(() => api.wsSyncNow()).then(() => refreshWorkspace())}>Синхронизировать</Button>}
        </div>
      </SettingRow>
      {rejected.length > 0 && (
        <Notice tone="warn" action={<Button small onClick={() => void attempt(() => api.wsDismissRejected()).then(() => refreshWorkspace())}>Понятно</Button>}>
          Сервер отклонил {integer(rejected.length)} изм.: {[...new Set(rejected.map((o) => o.last_error ?? "нет прав"))].slice(0, 2).join("; ")}. Записи перечитаны с сервера.
        </Notice>
      )}
    </Group>
  );
}
