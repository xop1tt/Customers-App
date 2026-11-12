import { useEffect, useRef, useState } from "react";
import { on } from "../api/backend";
import { newSince } from "../lib/leads";
import { useStore } from "./store";

/** Подписка на событие ядра на время жизни компонента. */
export function useEvent<T = unknown>(event: string, handler: (payload: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let off: (() => void) | null = null;
    let dead = false;
    void on<T>(event, (p) => ref.current(p)).then((f) => { if (dead) f(); else off = f; });
    return () => { dead = true; off?.(); };
  }, [event]);
}

/** Ширина окна в CSS-пикселях (с учётом масштаба интерфейса). */
export function useViewportWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const f = () => setW(window.innerWidth);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  return w;
}

/** Граница «новых» лидов по настройке «сколько последних поисков считать новыми» (см. `newSince`). */
export function useNewSince(): string | null {
  return useStore((s) => newSince(s.snap.syncLog, s.account?.newLeadsSearches ?? 1));
}
