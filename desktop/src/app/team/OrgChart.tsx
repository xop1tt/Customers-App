// «Структура организации»: вертикальное дерево «руководитель → подчинённые» с карточками сотрудников.

import { useEffect, useMemo, useState } from "react";
import { buildTree, type TreeNode } from "../../lib/team";
import { EmptyState, Spinner, Tag } from "../../ui/kit";
import { showMenu } from "../../ui/overlay";
import { openProfile, useStore } from "../../state/store";
import { refreshTeam } from "../../state/team";
import { PersonAvatar, personMenu } from "./PeoplePage";

export function OrgChartPage() {
  const team = useStore((s) => s.team);
  const ws = useStore((s) => s.ws);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { void refreshTeam().then(() => setLoaded(true)); }, [ws?.active]);
  const roots = useMemo(() => buildTree(team), [team]);
  if (!loaded && !team.length) return <div className="page center-fill"><Spinner /></div>;
  if (!team.length) return <div className="page center-fill"><EmptyState icon="tree" title="Структура пока пуста">Сотрудники появятся здесь, когда их добавят в рабочее пространство.</EmptyState></div>;
  return (
    <div className="page scroll">
      <div className="org" aria-label="Структура организации">
        <div className="org-head">
          <h2>Структура организации</h2>
          <span className="faint">Сотрудников: {team.length}. Нажмите на карточку, чтобы открыть профиль; правая кнопка мыши — меню.</span>
        </div>
        <div className="org-scroll">
          <ul className="org-tree" role="tree">
            {roots.map((n) => <OrgNode key={n.member.user_id} node={n} />)}
          </ul>
        </div>
      </div>
    </div>
  );
}

function OrgNode({ node }: { node: TreeNode }) {
  const me = useStore((s) => s.ws?.me);
  const cloud = useStore((s) => s.ws?.workspaces.find((w) => w.id === s.ws?.active)?.remote ?? false);
  const m = node.member;
  return (
    <li role="treeitem" aria-expanded={node.children.length ? true : undefined}>
      <button type="button" className={`org-card${m.user_id === me ? " me" : ""}`} onClick={() => openProfile(m.user_id === me ? null : m.user_id)}
        onContextMenu={(e) => { e.preventDefault(); showMenu(personMenu(m, me, cloud), { x: e.clientX, y: e.clientY }); }}>
        <PersonAvatar m={m} size={44} />
        <strong className="ellipsis org-name">{m.display_name}{m.user_id === me && <span className="faint"> · вы</span>}</strong>
        <span className="ellipsis faint org-sub">{m.title || "Должность не указана"}</span>
        {m.department && <span className="ellipsis faint org-sub">{m.department}</span>}
        <Tag>{m.role_name}</Tag>
        {node.children.length > 0 && <span className="org-count faint">подчинённых: {node.children.length}</span>}
      </button>
      {node.children.length > 0 && <ul role="group">{node.children.map((c) => <OrgNode key={c.member.user_id} node={c} />)}</ul>}
    </li>
  );
}
