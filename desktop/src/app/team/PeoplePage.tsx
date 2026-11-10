// «Сотрудники»: справочник Workspace списком или структурой «руководитель → подчинённые».

import { useEffect, useMemo, useState } from "react";
import type { TeamMember } from "../../api/types";
import { shortRelative } from "../../lib/format";
import { buildTree, presenceText, type TreeNode } from "../../lib/team";
import { Avatar, EmptyState, IconButton, Notice, Segmented, Spinner, Tag, TextInput } from "../../ui/kit";
import { openProfile, useStore } from "../../state/store";
import { messageMember, refreshTeam } from "../../state/team";

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
  const [view, setView] = useState<"list" | "tree">("list");
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
        {!cloud && (
          <Notice>Это локальный Workspace: в нём только вы. Сотрудники, их статус и сообщения появятся в облачном Workspace — пригласите коллег в «Рабочем пространстве».</Notice>
        )}
        {team.some((m) => m.offline) && <Notice tone="warn">Нет связи с облаком: показан сохранённый список без карточек и статуса.</Notice>}
        <div className="people-bar">
          <TextInput value={query} onChange={setQuery} icon="search" placeholder="Имя, должность, отдел или почта" aria-label="Поиск сотрудников" wrapClass="grow" onClear={query ? () => setQuery("") : undefined} />
          <Segmented small value={view} onChange={setView} options={[{ value: "list", label: "Список" }, { value: "tree", label: "Структура" }]} />
        </div>
        <div className="faint people-sum">
          Сотрудников: {team.length}{cloud ? ` · в сети: ${online}` : ""}{departments.length ? ` · отделы: ${departments.join(", ")}` : ""}
        </div>
        {shown.length === 0 ? (
          <EmptyState icon="users" title="Никого не нашлось">Измените запрос поиска.</EmptyState>
        ) : view === "list" || q ? (
          <ul className="people-list" aria-label="Сотрудники">
            {shown.map((m) => <PersonRow key={m.user_id} m={m} depth={0} />)}
          </ul>
        ) : (
          <ul className="people-list" aria-label="Структура">
            {buildTree(shown).map((n) => <TreeRows key={n.member.user_id} node={n} depth={0} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

function TreeRows({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <>
      <PersonRow m={node.member} depth={depth} reports={node.children.length} />
      {node.children.map((c) => <TreeRows key={c.member.user_id} node={c} depth={depth + 1} />)}
    </>
  );
}

function PersonRow({ m, depth, reports }: { m: TeamMember; depth: number; reports?: number }) {
  const me = useStore((s) => s.ws?.me);
  const cloud = useStore((s) => s.ws?.workspaces.find((w) => w.id === s.ws?.active)?.remote ?? false);
  const sub = [m.title, m.department].filter(Boolean).join(" · ");
  return (
    <li className="person-row" style={{ paddingLeft: 10 + depth * 22 }}>
      <button type="button" className="person-main" onClick={() => openProfile(m.user_id === me ? null : m.user_id)}>
        <PersonAvatar m={m} />
        <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
          <span className="ellipsis person-name">{m.display_name}{m.user_id === me && <span className="faint"> · вы</span>}</span>
          <span className="ellipsis faint person-sub">{sub || presenceText(m, shortRelative)}</span>
        </span>
        {reports ? <span className="faint person-reports">подчинённых: {reports}</span> : null}
        <Tag>{m.role_name}</Tag>
      </button>
      {cloud && m.user_id !== me && <IconButton icon="chat" tip="Написать сообщение" onClick={() => void messageMember(m.user_id)} />}
    </li>
  );
}
