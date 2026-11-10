// Заголовок группы левой панели, который сворачивает и разворачивает группу. Состояние — в настройках устройства.

import type { ReactNode } from "react";
import { toggled } from "../lib/sidebarPrefs";
import { Icon } from "../ui/icons";
import { getState, patchDevice, useStore } from "../state/store";

export type SidebarGroupId = "collections" | "sources" | "scores" | "work" | "team";

/** Свёрнута ли группа. В режиме настройки панели все группы раскрыты. */
export function useCollapsed(id: SidebarGroupId): boolean {
  return useStore((s) => !s.customizeNav && s.device.sidebarCollapsed.includes(id));
}

export function toggleGroup(id: SidebarGroupId) {
  const list = getState().device.sidebarCollapsed;
  const collapsed = list.includes(id);
  void patchDevice({ sidebarCollapsed: toggled(list, id, collapsed) });
}

export function GroupTitle({ id, title, extra }: { id: SidebarGroupId; title: string; extra?: ReactNode }) {
  const collapsed = useCollapsed(id);
  const customize = useStore((s) => s.customizeNav);
  return (
    <div className="nav-title row nav-title-toggle">
      <button type="button" className="nav-toggle grow" aria-expanded={!collapsed} disabled={customize} onClick={() => toggleGroup(id)}
        data-tip={customize ? undefined : collapsed ? "Развернуть" : "Свернуть"}>
        <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} className="nav-toggle-icon" />
        <span className="ellipsis">{title}</span>
      </button>
      {extra}
    </div>
  );
}
