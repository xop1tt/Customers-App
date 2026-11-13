// Профиль сотрудника: свой (меню учётной записи) или коллеги (из «Сотрудников», чата, упоминаний).
// Имя и фото меняются в настройках учётной записи; должность, отдел, руководителя и дату прихода — тот, у кого есть права.

import { HandoverDialog } from "../crm/Handover";
import { useEffect, useState } from "react";
import { api } from "../../api";
import type { TeamMember } from "../../api/types";
import { dateOnly } from "../../lib/format";
import { reportsOf, tenure } from "../../lib/team";
import { departmentError } from "../../lib/departments";
import { assignable, canManageDepartments, isHr, OWNER_TITLE, positionOf, roleFor } from "../../lib/positions";
import { RequestDialog } from "./Requests";
import { useActor } from "./actor";
import { openLink } from "../../state/actions";
import { Avatar, Button, Field, Notice, Select, Tag, TextInput } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { Dialog } from "../../ui/overlay";
import { attempt, openProfile, openSettings, refreshWorkspace, setState, toast, useStore } from "../../state/store";
import { messageMember, refreshTeam } from "../../state/team";

export function ProfilePage() {
  const session = useStore((s) => s.session);
  const ws = useStore((s) => s.ws);
  const cloudAccount = useStore((s) => !!s.sync?.enabled);
  const team = useStore((s) => s.team);
  const id = useStore((s) => s.profileId);
  const [editing, setEditing] = useState(false);
  const [handing, setHanding] = useState(false);
  const [closing, setClosing] = useState(false);
  const [asking, setAsking] = useState<"position" | "access" | null>(null);
  const actor = useActor();
  useEffect(() => { void refreshTeam(); }, [id]);
  if (!session) return null;
  const me = ws?.me;
  const self = !id || id === me;
  const current = ws?.workspaces.find((w) => w.id === ws.active);
  const cloud = current?.remote ?? false;
  const found = team.find((m) => m.user_id === (self ? me : id));
  // Свой профиль виден и без справочника (локальная запись, нет связи).
  const m: TeamMember | null = found
    ? { ...found, ...(self ? { display_name: session.displayName, avatar: session.avatar ?? found.avatar } : {}) }
    : self
      ? { user_id: me ?? "", display_name: session.displayName, avatar: session.avatar ?? null, email: session.cloudUser?.email ?? null, role: current?.role ?? "owner",
          role_name: current?.roleName ?? "Владелец", rank: current?.rank ?? 100, joined_at: null, title: "", department: "", manager_id: null, hired_on: null, last_seen: null, online: true, can_edit: false }
      : null;
  if (!m) {
    return (
      <div className="page scroll"><div className="profile">
        <Notice>Сотрудника нет в этом рабочем пространстве. Возможно, его удалили или вы переключились на другое рабочее пространство.</Notice>
        <div><Button icon="users" onClick={() => setState({ section: "people" })}>К сотрудникам</Button></div>
      </div></div>
    );
  }
  const manager = team.find((x) => x.user_id === m.manager_id);
  const reports = reportsOf(team, m.user_id);
  const email = m.email ?? (self ? session.cloudUser?.email ?? null : null);
  const since = tenure(m.hired_on);
  const hrMode = !self && isHr(actor);
  const canClose = !self && m.can_edit && m.role !== "owner" && (ws?.permissions ?? []).includes("members.manage") && !hrMode;
  const position = m.role === "owner" && !m.title ? OWNER_TITLE : m.title;
  const meMember = team.find((x) => x.user_id === me);

  return (
    <div className="page scroll">
      <div className="profile">
        <div><Button small variant="ghost" icon="chevronLeft" onClick={() => setState({ section: "people" })}>Назад</Button></div>
        <header className="profile-head">
          <span className="person-avatar big">
            <Avatar name={m.display_name} src={m.avatar} size={96} />
            {cloud && m.online && <span className="person-online" role="img" aria-label="В сети" />}
          </span>
          <div className="col profile-title">
            <h1 className="selectable">{m.display_name}</h1>
            {(m.title || m.department) && <div className="profile-sub">{[m.title, m.department].filter(Boolean).join(" · ")}</div>}
            <div className="row profile-tags">
              <Tag tone="blue" icon="shield">{m.role_name}</Tag>
              {!cloud && cloudAccount && <Tag>Облачная учётная запись</Tag>}
            </div>
          </div>
          <span className="grow" />
          <div className="profile-actions">
            {self ? (
              <Button icon="edit" onClick={() => openSettings("account", "profile")}>Изменить профиль</Button>
            ) : (
              <>
                {cloud && (ws?.permissions ?? []).includes("records.edit") && <Button icon="users" onClick={() => setHanding(true)}>Передать записи</Button>}
                {cloud && hrMode && <Button icon="note" onClick={() => setAsking("position")}>Запросить смену должности</Button>}
                {cloud && hrMode && m.role !== "owner" && <Button icon="x" onClick={() => setAsking("access")}>Запросить закрытие доступа</Button>}
                {cloud && canClose && <Button variant="danger" icon="x" onClick={() => setClosing(true)}>Закрыть доступ</Button>}
                {cloud && <Button variant="primary" icon="chat" onClick={() => void messageMember(m.user_id)}>Отправить сообщение</Button>}
                {email && <Button icon="mail" onClick={() => void openLink(`mailto:${email}`)}>Написать на почту</Button>}
              </>
            )}
            {m.can_edit && cloud && !hrMode && <Button icon="edit" onClick={() => setEditing(true)}>{self ? "Должность и отдел" : "Изменить карточку"}</Button>}
          </div>
        </header>

        <dl className="profile-facts">
          <ProfileFact icon="mail" label="Почта">{email ? <span className="selectable">{email}</span> : <span className="faint">Нет: локальная учётная запись</span>}</ProfileFact>
          <ProfileFact icon="note" label="Должность">{position || <span className="faint">Не указана</span>}</ProfileFact>
          <ProfileFact icon="users" label="Отдел">{m.department || <span className="faint">Не указан</span>}</ProfileFact>
          <ProfileFact icon="history" label="В компании">
            {m.hired_on ? <>{`с ${dateOnly(m.hired_on)}`}{since && <span className="faint"> · {since}</span>}</> : <span className="faint">Не указано</span>}
          </ProfileFact>
          <ProfileFact icon="tree" label="Руководитель">
            {manager ? <PersonLink m={manager} /> : <span className="faint">Нет</span>}
          </ProfileFact>
          {current && <ProfileFact icon="shield" label="Рабочее пространство">{current.name}</ProfileFact>}
        </dl>

        {reports.length > 0 && (
          <section className="col" style={{ gap: 8 }}>
            <h3 className="profile-h">Подчинённые · {reports.length}</h3>
            <div className="profile-reports">{reports.map((r) => <PersonLink key={r.user_id} m={r} />)}</div>
          </section>
        )}
      </div>
      {handing && <HandoverDialog from={{ userId: m.user_id, displayName: m.display_name }} onClose={() => setHanding(false)} />}
      {closing && <HandoverDialog from={{ userId: m.user_id, displayName: m.display_name }} leaving onClose={() => setClosing(false)} onRemove={async () => { await api.wsRemoveMember(m.user_id); await refreshWorkspace(); await refreshTeam(); setState({ section: "people" }); }} />}
      {asking && meMember && <RequestDialog kind={asking} author={meMember} team={team} target={m} onClose={() => setAsking(null)} />}
      {editing && <EditMemberDialog member={m} team={team} onClose={() => setEditing(false)} />}
    </div>
  );
}

export function ProfileFact({ icon, label, children }: { icon: string; label: string; children: React.ReactNode }) {
  return (
    <div className="profile-fact">
      <dt><Icon name={icon} size={14} />{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function PersonLink({ m }: { m: TeamMember }) {
  const me = useStore((s) => s.ws?.me);
  return (
    <button type="button" className="person-chip" onClick={() => openProfile(m.user_id === me ? null : m.user_id)}>
      <Avatar name={m.display_name} src={m.avatar} size={20} />
      <span className="ellipsis">{m.display_name}</span>
    </button>
  );
}

/** Карточка сотрудника: должность из справочника (она выдаёт роль), отдел, руководитель, дата прихода (ADR-079). */
export function EditMemberDialog({ member, team, onClose }: { member: TeamMember; team: TeamMember[]; onClose: () => void }) {
  const actor = useActor();
  const perms = useStore((s) => s.ws?.permissions ?? []);
  const self = actor?.user_id === member.user_id;
  const known = positionOf(member.title);
  const [title, setTitle] = useState(member.title);
  const [department, setDepartment] = useState(member.department);
  const [newDep, setNewDep] = useState("");
  const [manager, setManager] = useState(member.manager_id ?? "");
  const [hired, setHired] = useState(member.hired_on ?? "");
  const [busy, setBusy] = useState(false);
  const mayDepartments = canManageDepartments(actor);
  const mayPosition = !self && assignable(actor, member).length > 0;
  const departments = [...new Set(team.map((m) => m.department.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  const NEW = "\u0000new";
  // Подчинённых (в т.ч. непрямых) руководителем не назначить: получится круг.
  const below = new Set<string>();
  const walk = (id: string) => { for (const r of reportsOf(team, id)) if (!below.has(r.user_id)) { below.add(r.user_id); walk(r.user_id); } };
  walk(member.user_id);
  const options = [{ value: "", label: "Нет" }, ...team.filter((m) => m.user_id !== member.user_id && !below.has(m.user_id)).map((m) => ({ value: m.user_id, label: m.display_name, hint: m.title || m.role_name }))];
  const positionOptions = [
    ...(member.title && !assignable(actor, member).some((p) => p.name === member.title) ? [{ value: member.title, label: member.title, hint: known ? known.hint : "Прежнее название, не из справочника" }] : []),
    ...(member.title ? [] : [{ value: "", label: "Не указана" }]),
    ...assignable(actor, member).map((p) => ({ value: p.name, label: p.name, hint: p.hint })),
  ];
  const depOptions = [
    { value: "", label: "Без отдела" },
    ...departments.map((d) => ({ value: d, label: d })),
    ...(department && !departments.includes(department) ? [{ value: department, label: department }] : []),
    ...(mayDepartments ? [{ value: NEW, label: "Новый отдел…" }] : []),
  ];
  const isLead = member.role === "owner" || !!positionOf(title)?.lead;
  const depName = (department === NEW ? newDep : department).trim();
  const save = async () => {
    setBusy(true);
    const fields: Record<string, unknown> = { managerId: manager || null, hiredOn: hired || null };
    if (mayPosition) fields.title = title;
    if (mayDepartments) fields.department = depName;
    const r = await attempt(() => api.wsUpdateMember(member.user_id, fields));
    if (r && mayPosition && title !== member.title) await grantRole(member, title, actor, perms);
    setBusy(false);
    if (r) { await refreshTeam(); onClose(); }
  };
  return (
    <Dialog title={`Карточка: ${member.display_name}`} onClose={onClose} width={480} footer={
      <>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" busy={busy} disabled={department === NEW && !!departmentError(newDep)} onClick={() => void save()}>Сохранить</Button>
      </>
    }>
      <div className="col" style={{ gap: 14, alignItems: "stretch" }}>
        <Field label="Должность" hint={mayPosition ? "Должность выдаёт роль и права: руководящая — права руководителя." : self ? (member.role === "owner" ? "Вы владелец: эта должность не меняется." : "Свою должность меняет тот, кто выше по должности.") : "Должность назначает тот, кто выше по должности."}>
          <Select value={title} onChange={setTitle} options={positionOptions} disabled={!mayPosition} label="Должность" />
        </Field>
        <Field label="Отдел" hint={mayDepartments ? undefined : "Отделы создают и распределяют владелец, заместители и руководители."}>
          <Select value={department} onChange={setDepartment} options={depOptions} disabled={!mayDepartments} label="Отдел" />
        </Field>
        {department === NEW && (
          <Field label="Название нового отдела" hint={newDep ? departmentError(newDep) ?? undefined : undefined}>
            <TextInput value={newDep} onChange={setNewDep} maxLength={120} placeholder="Например, отдел продаж" aria-label="Название нового отдела" autoFocus />
          </Field>
        )}
        {/* Руководитель — не выбор: руководящая должность (и владелец) делает им автоматически. */}
        <Field label="Руководитель" hint="Определяется должностью: руководящая должность и владелец — руководители автоматически.">
          <div className="row" style={{ gap: 8 }}><Tag tone={isLead ? "green" : "gray"} icon={isLead ? "check" : undefined}>{isLead ? "Да" : "Нет"}</Tag>{isLead && <span className="faint">{member.role === "owner" && !positionOf(title)?.lead ? "Владелец" : title}</span>}</div>
        </Field>
        {member.role !== "owner" && <Field label="Подчиняется"><Select value={manager} onChange={setManager} options={options} label="Подчиняется" /></Field>}
        <Field label="В компании с" hint="По умолчанию — дата входа в рабочее пространство.">
          <TextInput type="date" value={hired} onChange={setHired} aria-label="Дата прихода в компанию" />
        </Field>
      </div>
    </Dialog>
  );
}

/** После смены должности выдать роль, которую она даёт: руководящая должность — права руководителя. Выдаёт тот, кто может менять роли и выше по рангу. */
async function grantRole(member: TeamMember, title: string, actor: { rank: number } | null, perms: string[]) {
  const p = positionOf(title);
  if (!p || !actor) return;
  if (!perms.includes("members.manage")) { toast("Должность записана. Роль и права выдаст владелец или заместитель.", "info"); return; }
  const roles = await api.wsRoles().catch(() => null);
  const key = roleFor(p, roles?.roles ?? []);
  const rank = roles?.roles.find((r) => r.key === key)?.rank ?? p.rank;
  if (!key || key === member.role || rank >= actor.rank) return;
  const done = await attempt(() => api.wsSetMemberRole(member.user_id, key));
  if (done) { await refreshWorkspace(); toast(`Роль «${roles?.roles.find((r) => r.key === key)?.name ?? key}» выдана: ${member.display_name}`, "success"); }
}
