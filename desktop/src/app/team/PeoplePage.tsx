// «Сотрудники»: справочник Workspace списком или структурой «руководитель → подчинённые».

import { useEffect, useMemo, useState } from "react";
import type { TeamMember } from "../../api/types";
import { shortRelative } from "../../lib/format";
import { presenceText } from "../../lib/team";
import { Avatar, Button, EmptyState, Notice, Segmented, Spinner, Tag, TextInput } from "../../ui/kit";
import { openProfile, toast, useStore } from "../../state/store";
import { copyText } from "../../lib/platform";
import { showMenu, type MenuItem } from "../../ui/overlay";
import { messageMember, refreshTeam } from "../../state/team";
import { Departments } from "./Departments";

export function PersonAvatar({ m, size = 32 }: { m: Pick<TeamMember, "display_name" | "avatar" | "online">; size?: number }) {
  return (
    <span className="person-avatar">
      <Avatar name={m.display_name} src={m.avatar} size={size} />
      {m.online && <span className="person-online" role="img" aria-label="В сети" />}
    </span>
  );
}

export function PeoplePage() {
  const team = useStore((s) => s.team);
  const ws = useStore((s) => s.ws);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"list" | "deps">("list");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { void refreshTeam().then(() => setLoaded(true)); }, [ws?.active]);
  const cloud = ws?.workspaces.find((w) => w.id === ws.active)?.remote ?? false;

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => team.filter((m) => !q || [m.display_name, m.title, m.department, m.email ?? "", m.role_name].some((x) => x.toLowerCase().includes(q))), [team, q]);
  const departments = useMemo(() => [...new Set(team.map((m) => m.department).filter(Boolean))].sort(), [team]);
  const online = team.filter((m) => m.online).length;

  if (!loaded && !team.length) return <div className="page center-fill"><Spinner /></div>;

  return (
    <div className="page scroll">
      <div className="people">
        {team.some((m) => m.offline) && <Notice tone="warn">Нет связи с облаком: показан сохранённый список без карточек и статуса.</Notice>}
        <div className="people-bar">
          <TextInput value={query} onChange={setQuery} icon="search" placeholder="Имя, должность, отдел или почта" aria-label="Поиск сотрудников" wrapClass="grow" onClear={query ? () => setQuery("") : undefined} />
          <Segmented small value={view} onChange={setView} options={[{ value: "list", label: "Список" }, { value: "deps", label: "Отделы" }]} />
        </div>
        <div className="faint people-sum">
          Сотрудников: {team.length}{cloud ? ` · в сети: ${online}` : ""}{departments.length ? ` · отделы: ${departments.join(", ")}` : ""}
        </div>
        {view === "deps" && !q ? (
          <Departments team={team} />
        ) : shown.length === 0 ? (
          <EmptyState icon="users" title="Никого не нашлось">Измените запрос поиска.</EmptyState>
        ) : (
          <ul className="people-list cards" aria-label="Сотрудники">
            {shown.map((m) => <PersonRow key={m.user_id} m={m} depth={0} card />)}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Контекстное меню сотрудника: правый клик по карточке или строке. */
export function personMenu(m: TeamMember, me: string | undefined, cloud: boolean): MenuItem[] {
  const self = m.user_id === me;
  return [
    { label: "Открыть профиль", icon: "user", onSelect: () => openProfile(self ? null : m.user_id) },
    ...(cloud && !self ? [{ label: "Открыть чат", icon: "chat", onSelect: () => void messageMember(m.user_id) } as MenuItem] : []),
    { separator: true },
    { label: "Скопировать имя", icon: "copy", onSelect: () => { void copyText(m.display_name); toast("Имя скопировано"); } },
    ...(m.email ? [{ label: "Скопировать почту", icon: "mail", onSelect: () => { void copyText(m.email!); toast("Почта скопирована"); } } as MenuItem] : []),
  ];
}

export function PersonRow({ m, depth, reports, card }: { m: TeamMember; depth: number; reports?: number; card?: boolean }) {
  const me = useStore((s) => s.ws?.me);
  const cloud = useStore((s) => s.ws?.workspaces.find((w) => w.id === s.ws?.active)?.remote ?? false);
  const sub = [m.title, m.department].filter(Boolean).join(" · ");
  return (
    <li className={`person-row${card ? " card" : ""}`} style={card ? undefined : { paddingLeft: 10 + depth * 22 }}
      onContextMenu={(e) => { e.preventDefault(); showMenu(personMenu(m, me, cloud), { x: e.clientX, y: e.clientY }); }}>
      <button type="button" className="person-main" onClick={() => openProfile(m.user_id === me ? null : m.user_id)}>
        <PersonAvatar m={m} size={card ? 64 : 32} />
        <span className="col grow" style={{ gap: card ? 3 : 1, minWidth: 0 }}>
          <span className="ellipsis person-name">{m.display_name}{m.user_id === me && <span className="faint"> · вы</span>}</span>
          <span className="ellipsis faint person-sub">{sub || presenceText(m, shortRelative)}</span>
          {card && m.email && <span className="ellipsis faint person-sub">{m.email}</span>}
          {card && <span className="ellipsis faint person-sub">{presenceText(m, shortRelative)}</span>}
        </span>
        {reports ? <span className="faint person-reports">подчинённых: {reports}</span> : null}
        <Tag>{m.role_name}</Tag>
      </button>
      {cloud && m.user_id !== me && <Button small icon="chat" className="person-chat" aria-label={`Открыть чат: ${m.display_name}`} onClick={() => void messageMember(m.user_id)}>Открыть чат</Button>}
    </li>
  );
}
