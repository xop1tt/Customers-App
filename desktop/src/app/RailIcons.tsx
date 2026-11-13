// Значки рейки с собственной анимацией у каждого: чат пролистывает сообщения, команда меняет человечков местами,
// список выезжает строками, лупа водит кругами, Ai моргает. Анимация идёт у выбранной кнопки и при наведении.

import type { ReactNode } from "react";

const Svg = ({ id, children }: { id: string; children: ReactNode }) => (
  <svg className={`rail-ico ri-${id}`} width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

export function RailIcon({ id }: { id: string }) {
  switch (id) {
    case "chat":
      return (
        <Svg id="chat">
          <defs><clipPath id="ri-chat-clip"><rect x="6" y="7.5" width="12" height="7" /></clipPath></defs>
          <path d="M4 5h16v11H9l-5 4V5Z" />
          <g clipPath="url(#ri-chat-clip)"><g className="ri-chat-lines"><path d="M8 9h8M8 12h5M8 15h8M8 18h5M8 21h8M8 24h5" /></g></g>
        </Svg>
      );
    case "team":
      return (
        <Svg id="team">
          <g className="ri-team-a"><circle cx="9" cy="8" r="3.2" /><path d="M2.8 20c0-3.4 2.8-5.5 6.2-5.5s6.2 2.1 6.2 5.5" /></g>
          <g className="ri-team-b"><circle cx="16.5" cy="7" r="2.6" /><path d="M13.5 14.3c.9-.3 1.9-.4 3-.4 2.9 0 5 1.8 5 4.6" /></g>
        </Svg>
      );
    case "crm":
      return (
        <Svg id="crm">
          <path className="ri-crm-1" d="M8 6h13" /><path className="ri-crm-2" d="M8 12h13" /><path className="ri-crm-3" d="M8 18h13" />
          <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
        </Svg>
      );
    case "search":
      return <Svg id="search"><g className="ri-search-g"><circle cx="11" cy="11" r="7" /><path d="m20 20-4.2-4.2" /></g></Svg>;
    default:
      return (
        <Svg id="ai">
          <path className="ri-ai-ant" d="M12 3v3" />
          <path d="M7 6h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3ZM9.5 16.5h5M2 11v3M22 11v3" />
          <path className="ri-ai-eye" d="M9 12v1.5M15 12v1.5" />
        </Svg>
      );
  }
}
