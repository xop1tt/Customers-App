// Вкладка «Отделы» в «Сотрудниках»: отделы — сущность сервера (ADR-095): дерево, руководитель, сотрудники.
// Создать, изменить (название, вышестоящий отдел, руководитель) и закрыть отдел может тот, у кого есть право
// управлять участниками; сервер проверяет это ещё раз.

import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { Department, TeamMember } from "../../api/types";
import { departmentError, departmentPath, membersOfDepartment, subDepartments } from "../../lib/departments";
import { canManageDepartments } from "../../lib/positions";
import { Avatar, Button, EmptyState, Field, IconButton, Notice, Select, TextInput } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { useActor } from "./actor";
import { confirmDialog, Dialog } from "../../ui/overlay";
import { attempt, toast, useStore } from "../../state/store";
import { refreshTeam } from "../../state/team";
import { PersonRow } from "./PeoplePage";

const NONE = "";

export function Departments({ team }: { team: TeamMember[] }) {
  const [deps, setDeps] = useState<Department[]>([]);
  const [editing, setEditing] = useState<Department | null>(null);
  const [creating, setCreating] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const actor = useActor();
  const perms = useStore((s) => s.ws?.permissions ?? []);
  const manage = canManageDepartments(actor) && perms.includes("members.manage");
  const reload = useCallback(async () => { setDeps((await attempt(() => api.wsDepartments())) ?? []); }, []);
  useEffect(() => { void reload(); }, [reload, team]);
  const changed = async () => { await refreshTeam(); await reload(); };

  const current = picked === null ? null : picked === NONE ? null : deps.find((d) => d.id === picked) ?? null;
  if (picked && picked !== NONE && !current && deps.length) setPicked(null);
  const unassigned = team.filter((m) => !m.department_id && !m.department.trim());
  const close = async (d: Department) => {
    const parent = deps.find((x) => x.id === d.parent_id);
    const n = membersOfDepartment(team, d).length;
    const where = parent ? `в отдел «${parent.name}»` : "без отдела";
    if (!(await confirmDialog({ title: `Закрыть отдел «${d.name}»?`, message: `Сотрудники (${n}), подотделы и записи отдела перейдут ${where}.`, confirm: "Закрыть отдел", danger: true }))) return;
    if ((await attempt(() => api.wsDeleteDepartment(d.id))) !== undefined) {
      setPicked(null);
      await changed();
      toast(`Отдел «${d.name}» закрыт`, "success");
    }
  };
  const head = (d: Department) => team.find((m) => m.user_id === d.head_id);
  const createBtn = manage
    ? <Button small icon="plus" onClick={() => setCreating(true)}>Создать отдел</Button>
    : <span className="faint">Отделы создают и закрывают владелец и те, кто управляет участниками.</span>;

  const card = (d: Department) => {
    const people = membersOfDepartment(team, d);
    const subs = subDepartments(deps, d.id).length;
    const h = head(d);
    return (
      <button key={d.id} type="button" role="listitem" className="dep-card" onClick={() => setPicked(d.id)}>
        <span className="dep-card-icon"><Icon name="building" size={22} /></span>
        <strong className="dep-card-name">{d.name}</strong>
        {d.parent_id && <span className="faint">{departmentPath(deps, d.parent_id)}</span>}
        <span className="faint">Сотрудников: {people.length}{subs ? ` · подотделов: ${subs}` : ""}{people.some((m) => m.online) ? ` · в сети: ${people.filter((m) => m.online).length}` : ""}</span>
        {h && <span className="faint">Руководитель: {h.display_name}</span>}
        <span className="dep-card-faces">{people.slice(0, 5).map((m) => <Avatar key={m.user_id} name={m.display_name} src={m.avatar} size={28} />)}{people.length > 5 && <span className="faint">+{people.length - 5}</span>}</span>
      </button>
    );
  };

  return (
    <div className="col" style={{ gap: 14 }} aria-label="Отделы">
      {picked !== null ? (
        <>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <IconButton icon="chevronLeft" tip="Ко всем отделам" onClick={() => setPicked(current?.parent_id ?? null)} />
            <strong className="grow dep-title">{current ? departmentPath(deps, current.id) : "Без отдела"}</strong>
            <span className="faint">сотрудников: {current ? membersOfDepartment(team, current).length : unassigned.length}</span>
            {manage && current && <Button small onClick={() => setEditing(current)}>Изменить…</Button>}
            {manage && current && <Button small variant="ghost" onClick={() => void close(current)}>Закрыть отдел…</Button>}
          </div>
          {current && head(current) && <div className="faint">Руководитель: {head(current)!.display_name}</div>}
          {current && subDepartments(deps, current.id).length > 0 && (
            <div className="dep-cards" role="list" aria-label="Подотделы">{subDepartments(deps, current.id).map(card)}</div>
          )}
          <ul className="people-list cards" aria-label={`Сотрудники отдела ${current?.name ?? "без отдела"}`}>
            {(current ? membersOfDepartment(team, current) : unassigned).map((m) => <PersonRow key={m.user_id} m={m} depth={0} card />)}
          </ul>
        </>
      ) : (
        <>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>{createBtn}</div>
          {!deps.length && <EmptyState icon="users" title="Отделов нет">{manage ? "Создайте отдел и назначьте в него сотрудников." : "Отдел назначает руководитель в карточке сотрудника."}</EmptyState>}
          <div className="dep-cards" role="list" aria-label="Выбор отдела">
            {subDepartments(deps, null).map(card)}
            {unassigned.length > 0 && deps.length > 0 && (
              <button type="button" role="listitem" className="dep-card" onClick={() => setPicked(NONE)}>
                <span className="dep-card-icon"><Icon name="users" size={22} /></span>
                <strong className="dep-card-name">Без отдела</strong>
                <span className="faint">Сотрудников: {unassigned.length}</span>
              </button>
            )}
          </div>
        </>
      )}
      {editing && <EditDialog dep={editing} deps={deps} team={team} onClose={() => setEditing(null)} onSaved={changed} />}
      {creating && <EditDialog deps={deps} team={team} parent={current?.id ?? null} onClose={() => setCreating(false)} onSaved={changed} />}
    </div>
  );
}

/** Новый отдел (без `dep`) или изменение существующего: название, вышестоящий отдел, руководитель. */
function EditDialog({ dep, deps, team, parent, onClose, onSaved }: { dep?: Department; deps: Department[]; team: TeamMember[]; parent?: string | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(dep?.name ?? "");
  const [up, setUp] = useState<string>(dep?.parent_id ?? parent ?? NONE);
  const [head, setHead] = useState<string>(dep?.head_id ?? NONE);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const dup = deps.some((d) => d.id !== dep?.id && d.name.trim().toLowerCase() === name.trim().toLowerCase());
  const error = name ? departmentError(name) ?? (dup ? "Такой отдел уже есть" : null) : null;
  // Вышестоящим не может быть сам отдел и его подотделы.
  const below = new Set<string>();
  const walk = (id: string) => { below.add(id); subDepartments(deps, id).forEach((d) => walk(d.id)); };
  if (dep) walk(dep.id);
  const parents = [{ value: NONE, label: "Нет (верхний уровень)" }, ...deps.filter((d) => !below.has(d.id)).map((d) => ({ value: d.id, label: departmentPath(deps, d.id) }))];
  const heads = [{ value: NONE, label: "Не назначен" }, ...team.map((m) => ({ value: m.user_id, label: m.display_name }))];
  const candidates = team.filter((m) => m.can_edit);
  const run = async () => {
    setBusy(true);
    const r = await attempt(() => api.wsSaveDepartment({ id: dep?.id ?? null, name: name.trim(), parent: up || null, head: head || null }));
    let failed = 0;
    if (r && !dep) for (const id of picked) if ((await attempt(() => api.wsSetMemberDepartment(id, r.id))) === undefined) failed++;
    await onSaved();
    setBusy(false);
    if (!r) return;
    toast(failed ? `Не удалось назначить: ${failed}` : dep ? `Отдел «${name.trim()}» сохранён` : `Отдел «${name.trim()}» создан`, failed ? "error" : "success");
    if (!failed) onClose();
  };
  return (
    <Dialog title={dep ? `Отдел «${dep.name}»` : "Новый отдел"} onClose={onClose} footer={<><Button onClick={onClose}>Отмена</Button><Button variant="primary" busy={busy} disabled={!name.trim() || !!error} onClick={run}>{dep ? "Сохранить" : "Создать"}</Button></>}>
      <div className="col" style={{ gap: 10 }}>
        <Field label="Название" hint={error ?? undefined}><TextInput value={name} onChange={setName} aria-label="Название отдела" autoFocus /></Field>
        <Select value={up} onChange={setUp} options={parents} label="Входит в отдел" />
        <Select value={head} onChange={setHead} options={heads} label="Руководитель отдела" />
        <div className="faint">Руководитель видит записи своего отдела и подотделов, если в роли включена видимость «Свой отдел».</div>
        {!dep && (
          <>
            <div className="faint">Кого сразу назначить в отдел (можно позже, в карточке сотрудника):</div>
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
          </>
        )}
      </div>
    </Dialog>
  );
}
