// Профиль сотрудника: свой (меню учётной записи) или коллеги (из «Сотрудников», чата, упоминаний).
// Имя и фото меняются в настройках учётной записи; должность, отдел, руководителя и дату прихода — тот, у кого есть права.

import { useEffect, useState } from "react";
import { api } from "../../api";
import type { TeamMember } from "../../api/types";
import { dateOnly, shortRelative } from "../../lib/format";
import { presenceText, reportsOf, tenure } from "../../lib/team";
import { openLink } from "../../state/actions";
import { Avatar, Button, Field, Notice, Select, Tag, TextInput } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { Dialog } from "../../ui/overlay";
import { attempt, openProfile, openSettings, setState, useStore } from "../../state/store";
import { messageMember, refreshTeam } from "../../state/team";

export function ProfilePage() {
  const session = useStore((s) => s.session);
  const ws = useStore((s) => s.ws);
  const team = useStore((s) => s.team);
  const id = useStore((s) => s.profileId);
  const [editing, setEditing] = useState(false);
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
        <Notice>Сотрудника нет в этом Workspace. Возможно, его удалили или вы переключились на другой Workspace.</Notice>
        <div><Button icon="users" onClick={() => setState({ section: "people" })}>К сотрудникам</Button></div>
      </div></div>
    );
  }
  const manager = team.find((x) => x.user_id === m.manager_id);
  const reports = reportsOf(team, m.user_id);
  const email = m.email ?? (self ? session.cloudUser?.email ?? null : null);
  const since = tenure(m.hired_on);

  return (
    <div className="page scroll">
      <div className="profile">
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
              {cloud ? <Tag tone={m.online ? "green" : "gray"}>{presenceText(m, shortRelative)}</Tag> : <Tag>{session.isCloud ? "Облачная учётная запись" : "Локальная учётная запись"}</Tag>}
            </div>
          </div>
          <span className="grow" />
          <div className="profile-actions">
            {self ? (
              <Button icon="edit" onClick={() => openSettings("account", "profile")}>Изменить профиль</Button>
            ) : (
              <>
                {cloud && <Button variant="primary" icon="chat" onClick={() => void messageMember(m.user_id)}>Отправить сообщение</Button>}
                {email && <Button icon="mail" onClick={() => void openLink(`mailto:${email}`)}>Написать на почту</Button>}
              </>
            )}
            {m.can_edit && cloud && <Button icon="edit" onClick={() => setEditing(true)}>{self ? "Должность и отдел" : "Изменить карточку"}</Button>}
          </div>
        </header>

        <dl className="profile-facts">
          <ProfileFact icon="mail" label="Почта">{email ? <span className="selectable">{email}</span> : <span className="faint">Нет: локальная учётная запись</span>}</ProfileFact>
          <ProfileFact icon="note" label="Должность">{m.title || <span className="faint">Не указана</span>}</ProfileFact>
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

/** Карточка сотрудника: должность, отдел, руководитель, дата прихода. */
export function EditMemberDialog({ member, team, onClose }: { member: TeamMember; team: TeamMember[]; onClose: () => void }) {
  const [title, setTitle] = useState(member.title);
  const [department, setDepartment] = useState(member.department);
  const [manager, setManager] = useState(member.manager_id ?? "");
  const [hired, setHired] = useState(member.hired_on ?? "");
  const [busy, setBusy] = useState(false);
  const departments = [...new Set(team.map((m) => m.department).filter(Boolean))].sort();
  // Подчинённых (в т.ч. непрямых) руководителем не назначить: получится круг.
  const below = new Set<string>();
  const walk = (id: string) => { for (const r of reportsOf(team, id)) if (!below.has(r.user_id)) { below.add(r.user_id); walk(r.user_id); } };
  walk(member.user_id);
  const options = [{ value: "", label: "Нет" }, ...team.filter((m) => m.user_id !== member.user_id && !below.has(m.user_id)).map((m) => ({ value: m.user_id, label: m.display_name, hint: m.title || m.role_name }))];
  const save = async () => {
    setBusy(true);
    const r = await attempt(() => api.wsUpdateMember(member.user_id, { title, department, managerId: manager || null, hiredOn: hired || null }));
    setBusy(false);
    if (r) { await refreshTeam(); onClose(); }
  };
  return (
    <Dialog title={`Карточка: ${member.display_name}`} onClose={onClose} width={480} footer={
      <>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" busy={busy} onClick={() => void save()}>Сохранить</Button>
      </>
    }>
      <div className="col" style={{ gap: 14, alignItems: "stretch" }}>
        <Field label="Должность"><TextInput value={title} onChange={setTitle} maxLength={120} placeholder="Например, менеджер по продажам" autoFocus /></Field>
        <Field label="Отдел" hint={departments.length ? `Уже есть: ${departments.join(", ")}` : undefined}>
          <TextInput value={department} onChange={setDepartment} maxLength={120} placeholder="Например, отдел продаж" list="team-departments" />
        </Field>
        <datalist id="team-departments">{departments.map((d) => <option key={d} value={d} />)}</datalist>
        <Field label="Руководитель"><Select value={manager} onChange={setManager} options={options} /></Field>
        <Field label="В компании с" hint="По умолчанию — дата входа в Workspace.">
          <TextInput type="date" value={hired} onChange={setHired} aria-label="Дата прихода в компанию" />
        </Field>
      </div>
    </Dialog>
  );
}
