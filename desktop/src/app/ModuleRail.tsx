// Рейка модулей слева (пакет C2, вариант B макетов C1): CRM, поиск клиентов, сообщения, команда, внизу — кнопка «Ai» (выдвижной чат; настройки — в меню аккаунта).

import { matchesSection } from "../lib/leads";
import { useNewSince } from "../state/hooks";
import { integer } from "../lib/format";
import { MODULES, moduleOf, type ModuleId } from "../lib/modules";
import { Icon } from "../ui/icons";
import { openModule, toggleAi, useStore } from "../state/store";
import { unreadNotifications, unreadTotal } from "../state/team";
import appIcon from "../assets/app-icon.png";
import appIconLight from "../assets/app-icon-light.png";

export const RAIL_W = 64;

export function ModuleRail() {
  const section = useStore((s) => s.section);
  const leads = useStore((s) => s.snap.leads);
  const since = useNewSince();
  const chat = useStore((s) => s.chat);
  const aiOpen = useStore((s) => s.aiOpen);
  const hasWs = useStore((s) => !!s.ws?.active);
  const current = moduleOf(section);
  const badge: Record<ModuleId, number> = {
    crm: 0,
    search: leads.filter((l) => !l.seen && matchesSection(l, "new", since) && l.data.relevance !== "rejected").length,
    messages: unreadTotal(chat),
    team: unreadNotifications(chat),
  };

  return (
    <nav className="rail" aria-label="Модули" style={{ width: RAIL_W }}>
      <span className="rail-brand" aria-hidden="true">
        <img className="icon-dark" src={appIcon} width={26} height={26} alt="" draggable={false} />
        <img className="icon-light" src={appIconLight} width={26} height={26} alt="" draggable={false} />
      </span>
      {MODULES.filter((m) => m.id !== "crm" || hasWs).map((m) => {
        const n = badge[m.id];
        const label = n > 0 ? `${m.title}, новых: ${n}` : m.title;
        return (
          <button key={m.id} type="button" className={`rail-btn${current === m.id ? " active" : ""}`} aria-label={label} aria-current={current === m.id ? "page" : undefined}
            data-tip={m.title} onClick={() => openModule(m.id)}>
            <Icon name={m.icon} size={18} />
            <span className="rail-label">{m.short}</span>
            {n > 0 && <span className="rail-badge num" aria-hidden="true">{n > 99 ? "99+" : integer(n)}</span>}
          </button>
        );
      })}
      <span className="grow" />
      <button type="button" className={`rail-btn ai-toggle${aiOpen ? " active" : ""}`} id="ai-toggle" aria-label="Ai" aria-expanded={aiOpen} aria-controls="ai-drawer"
        data-tip="Ai" onClick={() => toggleAi()}>
        <Icon name="bot" size={18} />
        <span className="rail-label">Ai</span>
      </button>
    </nav>
  );
}
