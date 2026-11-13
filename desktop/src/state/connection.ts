// Связь с облаком: пропал интернет — показываем «Переподключение», раз в несколько секунд пробуем синхронизироваться.
// Изменения, сделанные без связи, лежат в очереди ядра (workspace::sync) и уходят на сервер при первой удачной синхронизации.

import { useEffect } from "react";
import { api } from "../api";
import { getState, refreshWorkspace, setState } from "./store";

export type Connection = "online" | "reconnecting" | "restored";

export const RETRY_MS = 4000;
export const RESTORED_MS = 2200;
let timer: ReturnType<typeof setTimeout> | null = null;
let hide: ReturnType<typeof setTimeout> | null = null;
let busy = false;

const clear = () => { if (timer) clearTimeout(timer); timer = null; };

/** Связь потеряна: показать плашку и начать повторные попытки. */
export function connectionLost() {
  if (hide) { clearTimeout(hide); hide = null; }
  if (getState().conn !== "reconnecting") setState({ conn: "reconnecting" });
  schedule();
}

function schedule() {
  clear();
  timer = setTimeout(() => void tryReconnect(), RETRY_MS);
}

/** Одна попытка: удалась — плашка превращается в галочку и исчезает, нет — ждём следующей. */
export async function tryReconnect(): Promise<boolean> {
  if (busy || getState().conn !== "reconnecting") return false;
  busy = true;
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("offline");
    await api.wsSyncNow();
    clear();
    setState({ conn: "restored" });
    void refreshWorkspace();
    hide = setTimeout(() => { setState({ conn: "online" }); hide = null; }, RESTORED_MS);
    return true;
  } catch {
    schedule();
    return false;
  } finally {
    busy = false;
  }
}

/** Следит за событиями браузера/WebView «нет сети — есть сеть» на время работы окна. */
export function useConnectionWatch() {
  useEffect(() => {
    const lost = () => connectionLost();
    const back = () => { if (getState().conn === "reconnecting") void tryReconnect(); };
    window.addEventListener("offline", lost);
    window.addEventListener("online", back);
    if (typeof navigator !== "undefined" && navigator.onLine === false) connectionLost();
    return () => { window.removeEventListener("offline", lost); window.removeEventListener("online", back); clear(); };
  }, []);
}
