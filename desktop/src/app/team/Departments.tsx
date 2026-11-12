// Вкладка «Отделы» в «Сотрудниках»: справочник отделов, состав, переименование и слияние (ADR-077).

import { useState } from "react";
import { api } from "../../api";
import type { TeamMember } from "../../api/types";
import { departmentError, departmentsOf, renamePlan, type Department } from "../../lib/departments";
import { canManageDepartments } from "../../lib/positions";
import { Button, EmptyState, Field, Notice, TextInput } from "../../ui/kit";
import { useActor } from "./actor";
import { confirmDialog, Dialog } from "../../ui/overlay";
import { attempt, toast } from "../../state/store";
import { refreshTeam } from "../../state/team";
import { PersonRow } from "./PeoplePage";

export function Departments({ team }: { team: TeamMember[] }) {
  const [editing, setEditing] = useState<Department | null>(null);
  const [creating, setCreating] = useState(false);
  const actor = useActor();
  const manage = canManageDepartments(actor);
  const deps = departmentsOf(team);
  const close = async (d: Department) => {
    const plan = renamePlan(d, "");
    if (!(await confirmDialog({ title: `Закрыть отдел «${d.name}»?`, message: `Сотрудники (${plan.change.length}) останутся без отдела. Записи и права не меняются.${plan.locked ? ` Ещё ${plan.locked} нельзя изменить: нет прав.` : ""}`, confirm: "Закрыть отдел", danger: true }))) return;
    let failed = 0;
    for (const m of plan.change) if (!(await attempt(() => api.wsUpdateMember(m.user_id, { department: "" })))) failed++;
    await refreshTeam();
    toast(failed ? `Не удалось изменить: ${failed}` : `Отдел «${d.name}» закрыт`, failed ? "error" : "success");
  };
  return (
    <div className="col" style={{ gap: 14 }} aria-label="Отделы">
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        {manage ? <Button small icon="plus" onClick={() => setCreating(true)}>Создать отдел</Button> : <span className="faint">Отделы создают и закрывают владелец, заместители и руководители.</span>}
      </div>
      {!deps.length && <EmptyState icon="users" title="Отделов нет">{manage ? "Создайте отдел и назначьте в него сотрудников." : "Отдел назначает руководитель в карточке сотрудника."}</EmptyState>}
      {deps.map((d) => (
        <section key={d.name || "—"} className="col" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <strong className="grow">{d.name || "Без отдела"}</strong>
            <span className="faint">сотрудников: {d.members.length}</span>
            {manage && d.name && d.members.some((m) => m.can_edit) && <Button small onClick={() => setEditing(d)}>Переименовать…</Button>}
            {manage && d.name && d.members.some((m) => m.can_edit) && <Button small variant="ghost" onClick={() => void close(d)}>Закрыть отдел…</Button>}
          </div>
          <ul className="people-list">{d.members.map((m) => <PersonRow key={m.user_id} m={m} depth={0} />)}</ul>
        </section>
      ))}
      {editing && <RenameDialog dep={editing} others={deps.filter((d) => d.name && d !== editing).map((d) => d.name)} onClose={() => setEditing(null)} />}
      {creating && <CreateDialog team={team} existing={deps.map((d) => d.name).filter(Boolean)} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** Новый отдел существует, пока в нём есть сотрудники (отдельной таблицы нет, ADR-077/079): создаём вместе с первыми назначениями. */
function CreateDialog({ team, existing, onClose }: { team: TeamMember[]; existing: string[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const dup = existing.some((e) => e.toLowerCase() === name.trim().toLowerCase());
  const error = name ? departmentError(name) ?? (dup ? "Такой отдел уже есть" : null) : null;
  const candidates = team.filter((m) => m.can_edit);
  const run = async () => {
    setBusy(true);
    let failed = 0;
    for (const id of picked) if (!(await attempt(() => api.wsUpdateMember(id, { department: name.trim() })))) failed++;
    await refreshTeam();
    setBusy(false);
    toast(failed ? `Не удалось назначить: ${failed}` : `Отдел «${name.trim()}» создан`, failed ? "error" : "success");
    if (!failed) onClose();
  };
  return (
    <Dialog title="Новый отдел" onClose={onClose} footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" busy={busy} disabled={!name.trim() || !!error || !picked.length} onClick={run}>Создать</Button></>}>
      <div className="col" style={{ gap: 10 }}>
        <Field label="Название" hint={error ?? undefined}><TextInput value={name} onChange={setName} aria-label="Название отдела" autoFocus /></Field>
        <div className="faint">Кого назначить в отдел (нужен хотя бы один сотрудник):</div>
        <ul className="col" style={{ gap: 4, maxHeight: 220, overflow: "auto" }} aria-label="Кого назначить">
          {candidates.map((m) => (
            <li key={m.user_id}>
              <label className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={picked.includes(m.user_id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.user_id] : picked.filter((x) => x !== m.user_id))} />
                <span>{m.display_name}</span><span className="faint">{m.department || "без отдела"}</span>
              </label>
            </li>
          ))}
        </ul>
        {!candidates.length && <Notice tone="warn">Нет сотрудников, которых вы можете назначить.</Notice>}
      </div>
    </Dialog>
  );
}

function RenameDialog({ dep, others, onClose }: { dep: Department; others: string[]; onClose: () => void }) {
  const [name, setName] = useState(dep.name);
  const [busy, setBusy] = useState(false);
  const error = departmentError(name);
  const plan = renamePlan(dep, name);
  const merge = others.some((o) => o.toLowerCase() === name.trim().toLowerCase() && o.toLowerCase() !== dep.name.toLowerCase());
  const run = async () => {
    setBusy(true);
    let failed = 0;
    for (const m of plan.change) {
      const r = await attempt(() => api.wsUpdateMember(m.user_id, { department: name.trim() }));
      if (!r) failed++;
    }
    await refreshTeam();
    setBusy(false);
    toast(failed ? `Не удалось изменить: ${failed}` : `Отдел «${name.trim()}»: изменено ${plan.change.length}`, failed ? "error" : "success");
    if (!failed) onClose();
  };
  return (
    <Dialog title={`Отдел «${dep.name}»`} onClose={onClose} footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" disabled={!!error || busy || !plan.change.length} onClick={run}>{merge ? "Объединить" : "Переименовать"}</Button></>}>
      <div className="col" style={{ gap: 10 }}>
        <Field label="Новое название" hint={error ?? undefined}>
          <TextInput value={name} onChange={setName} aria-label="Название отдела" autoFocus />
        </Field>
        {merge && <Notice>Такой отдел уже есть: сотрудники будут объединены в него.</Notice>}
        {plan.locked > 0 && <Notice tone="warn">Сотрудников, чей профиль вы не можете менять: {plan.locked}. Их отдел не изменится.</Notice>}
        <div className="faint">Изменится у сотрудников: {plan.change.length}</div>
      </div>
    </Dialog>
  );
}
