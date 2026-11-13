// Рейка модулей слева (пакет C2, вариант B макетов C1): CRM, поиск клиентов, сообщения, команда, внизу — кнопка «Ai» (выдвижной чат; настройки — в меню аккаунта).

import { matchesSection } from "../lib/leads";
import { useNewSince } from "../state/hooks";
import { integer } from "../lib/format";
import { MODULES, moduleOf, type ModuleId } from "../lib/modules";
import { RailIcon } from "./RailIcons";
import { openModule, toggleAi, toggleChat, useStore } from "../state/store";
import { unreadTotal } from "../state/team";
import { useHub } from "../state/hub";

export const RAIL_W = 64;

export function ModuleRail() {
  const section = useStore((s) => s.section);
  const leads = useStore((s) => s.snap.leads);
  const since = useNewSince();
  const chat = useStore((s) => s.chat);
  const aiOpen = useStore((s) => s.aiOpen);
  const chatOpen = useStore((s) => s.chatPopup);
  const chatReady = useStore((s) => !!s.ws?.active);
  const unread = unreadTotal(chat);
  const aiOn = useHub().ai.enabled;
  const hasWs = useStore((s) => !!s.ws?.active);
  const current = moduleOf(section);
  const badge: Record<ModuleId, number> = {
    crm: 0,
    search: leads.filter((l) => !l.seen && matchesSection(l, "new", since) && l.data.relevance !== "rejected").length,
    team: 0, // уведомления показывает колокольчик у учётной записи
  };

  return (
    <nav className="rail" aria-label="Модули" style={{ width: RAIL_W }}>
      {MODULES.filter((m) => m.id !== "crm" || hasWs).map((m) => {
        const n = badge[m.id];
        const label = n > 0 ? `${m.title}, новых: ${n}` : m.title;
        return (
          <button key={m.id} type="button" className={`rail-btn${current === m.id ? " active" : ""}`} aria-label={label} aria-current={current === m.id ? "page" : undefined}
            data-tip={m.title} onClick={() => openModule(m.id)}>
            <RailIcon id={m.id === "team" ? "team" : m.id === "crm" ? "crm" : "search"} />
            <span className="rail-label">{m.short}</span>
            {n > 0 && <span className="rail-badge num" aria-hidden="true">{n > 99 ? "99+" : integer(n)}</span>}
          </button>
        );
      })}
      <span className="grow" />
      {chatReady && (
        <button type="button" className={`rail-btn${chatOpen ? " active" : ""}`} id="chat-toggle" aria-label={unread > 0 ? `Чат, новых: ${unread}` : "Чат"} aria-expanded={chatOpen} aria-haspopup="dialog"
          data-tip={chatOpen ? "Свернуть чат" : "Чат"} onClick={() => toggleChat()}>
          <RailIcon id="chat" />
          <span className="rail-label">Чат</span>
          {unread > 0 && <span className="rail-badge num" aria-hidden="true">{unread > 99 ? "99+" : integer(unread)}</span>}
        </button>
      )}
      {aiOn && <button type="button" className={`rail-btn ai-toggle${aiOpen ? " active" : ""}`} id="ai-toggle" aria-label="Ai" aria-expanded={aiOpen} aria-controls="ai-drawer"
        data-tip="Ai" onClick={() => toggleAi()}>
        <RailIcon id="ai" />
        <span className="rail-label">Ai</span>
      </button>}
    </nav>
  );
}
