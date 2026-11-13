import { useStore } from "../state/store";

/** Плашка снизу по центру: красная «Переподключение» с вращающимися стрелками; при успехе стрелки сменяются галочкой в кружке. */
export function ReconnectToast() {
  const conn = useStore((s) => s.conn);
  if (conn === "online") return null;
  const ok = conn === "restored";
  return (
    <div className={`reconnect ${ok ? "ok" : "lost"}`} role="status" aria-live="polite">
      <svg className="reconnect-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {ok ? (
          <>
            <circle className="reconnect-ring" cx="12" cy="12" r="9" />
            <path className="reconnect-tick" d="m7.5 12.5 3 3 6-6.5" />
          </>
        ) : (
          <g className="reconnect-spin">
            <path d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6" />
            <path d="M18 3.5v3.2h-3.2M6 20.5v-3.2h3.2" />
          </g>
        )}
      </svg>
      <span>{ok ? "Подключено" : "Переподключение…"}</span>
    </div>
  );
}
