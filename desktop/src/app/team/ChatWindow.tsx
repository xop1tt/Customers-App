// Чат: всплывающее окно над рабочей областью (не на весь экран). Открывается и сворачивается кнопкой «Чат» в рейке.

import { useEffect } from "react";
import { IconButton } from "../../ui/kit";
import { setState, useStore } from "../../state/store";
import { ChatPage } from "./ChatPage";

export function ChatWindow() {
  const open = useStore((s) => s.chatPopup);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".popover, .scrim, .settings-scrim")) setState({ chatPopup: false });
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);
  if (!open) return null;
  return (
    <section className="chat-window" role="dialog" aria-label="Чат">
      <header className="chat-window-head"><strong className="grow">Чат</strong><IconButton icon="chevronDown" tip="Свернуть" aria-label="Свернуть чат" onClick={() => setState({ chatPopup: false })} /></header>
      <ChatPage />
    </section>
  );
}
