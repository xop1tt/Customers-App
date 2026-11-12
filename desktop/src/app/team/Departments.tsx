// Вкладка «Отделы» в «Сотрудниках»: справочник отделов, состав, переименование и слияние (ADR-076).

import { useState } from "react";
import { api } from "../../api";
import type { TeamMember } from "../../api/types";
import { departmentError, departmentsOf, renamePlan, type Department } from "../../lib/departments";
import { Button, EmptyState, Field, Notice, TextInput } from "../../ui/kit";
import { Dialog } from "../../ui/overlay";
import { attempt, toast } from "../../state/store";
import { refreshTeam } from "../../state/team";
import { PersonRow } from "./PeoplePage";

export function Departments({ team }: { team: TeamMember[] }) {
  const [editing, setEditing] = useState<Department | null>(null);
  const deps = departmentsOf(team);
  if (!deps.length) return <EmptyState icon="users" title="Отделов нет">Укажите отдел в карточке сотрудника.</EmptyState>;
  return (
    <div className="col" style={{ gap: 14 }} aria-label="Отделы">
      {deps.map((d) => (
        <section key={d.name || "—"} className="col" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <strong className="grow">{d.name || "Без отдела"}</strong>
            <span className="faint">сотрудников: {d.members.length}</span>
            {d.name && d.members.some((m) => m.can_edit) && <Button small onClick={() => setEditing(d)}>Переименовать…</Button>}
          </div>
          <ul className="people-list">{d.members.map((m) => <PersonRow key={m.user_id} m={m} depth={0} />)}</ul>
        </section>
      ))}
      {editing && <RenameDialog dep={editing} others={deps.filter((d) => d.name && d !== editing).map((d) => d.name)} onClose={() => setEditing(null)} />}
    </div>
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
