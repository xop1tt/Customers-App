import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { isLeadList } from "../lib/leads";
import { HoverReveal } from "../lib/hoverReveal";
import { applyAccent, applyTheme, resolveTheme, systemIsDark } from "../lib/theme";
import { resolveLanguage, setLanguage, systemLanguage } from "../lib/i18n";
import { BASE_AUTO } from "../lib/autoScale";
import { copyText, isMac, readText } from "../lib/platform";
import { Icon } from "../ui/icons";
import { ConfirmHost, MenuHost, TooltipHost, installInputContextMenu } from "../ui/overlay";
import { IconButton, Spinner } from "../ui/kit";
import { boot, checkPower, dismissToast, getState, openSettings, patchDevice, select, setState, useStore } from "../state/store";
import { AuthScreen } from "./Auth";
import { Welcome } from "./Welcome";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { Inspector } from "./Inspector";
import { HomePage } from "./pages/Home";
import { LeadsPage } from "./pages/LeadsPage";
import { SourcesPage } from "./pages/SourcesPage";
import { RunsPage } from "./pages/RunsPage";
import { Settings } from "./settings/Settings";
import { ReportDialog } from "./settings/SystemSections";
import { ExportDialog } from "./ExportDialog";
import { CrashPrompt, StartupError, WhatsNewDialog } from "./Prompts";
import { useViewportWidth } from "../state/hooks";

const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const MIN_CENTER = 560;
const INSP_MIN = 300;
const INSP_MAX = 640;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function App() {
  const phase = useStore((s) => s.phase);
  const device = useStore((s) => s.device);
  const lightMode = useStore((s) => s.lightMode);
  const platform = useStore((s) => s.boot?.platform);

  useEffect(() => { void boot(); }, []);
  useEffect(() => installInputContextMenu(readText, copyText), []);
  useEffect(() => {
    // Тема: свой выбор или тема системы (следим за её сменой).
    const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const apply = () => {
      const theme = resolveTheme(device.theme, systemIsDark());
      applyTheme(theme);
      applyAccent(device.accent, theme);
    };
    apply();
    if (device.theme !== "system" || !media) return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [device.theme, device.accent]);
  useEffect(() => {
    const lang = resolveLanguage(device.language, systemLanguage());
    setLanguage(lang);
    void api.setUiLanguage(lang).catch(() => {});
  }, [device.language]);
  useEffect(() => {
    const off = !device.animations || lightMode !== null;
    document.documentElement.dataset.motion = off ? "off" : "on";
  }, [device.animations, lightMode]);
  useEffect(() => { void api.setZoom(Math.round(device.uiScale * BASE_AUTO * 100) / 100).catch(() => {}); }, [device.uiScale]);
  useEffect(() => { if (platform) document.documentElement.dataset.platform = platform; }, [platform]);
  useEffect(() => {
    // Заряд меняется медленно: проверяем раз в минуту.
    const t = setInterval(() => { void checkPower(); }, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey) return;
      const st = getState();
      if (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "_" || e.key === "0") {
        e.preventDefault();
        const cur = st.device.uiScale;
        const i = SCALES.reduce((best, s, idx) => (Math.abs(s - cur) < Math.abs((SCALES[best] ?? 1) - cur) ? idx : best), 0);
        const next = e.key === "0" ? 1 : SCALES[clamp(i + (e.key === "-" || e.key === "_" ? -1 : 1), 0, SCALES.length - 1)] ?? 1;
        void patchDevice({ uiScale: next });
      } else if (e.key === ",") {
        e.preventDefault();
        openSettings(st.settings ? null : "appearance");
      } else if (e.key.toLowerCase() === "f" && st.phase === "ready") {
        const input = document.querySelector<HTMLInputElement>(".topbar-search input");
        if (input) { e.preventDefault(); input.focus(); input.select(); }
      } else if (e.key.toLowerCase() === "b" && st.phase === "ready") {
        e.preventDefault();
        void patchDevice({ navOpen: !st.device.navOpen });
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  return (
    <>
      {phase === "loading" && <div className="boot"><Spinner size={22} /></div>}
      {phase === "error" && <StartupError />}
      {phase === "auth" && <AuthScreen />}
      {phase === "welcome" && <Welcome />}
      {phase === "ready" && <Shell />}
      <Settings />
      <MenuHost />
      <ConfirmHost />
      <TooltipHost />
      <Toasts />
    </>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <Icon name={t.kind === "error" ? "alert" : t.kind === "success" ? "check" : "info"} size={15} />
          <span className="grow selectable">{t.text}</span>
          <button type="button" onClick={() => dismissToast(t.id)} aria-label="Закрыть"><Icon name="x" size={13} /></button>
        </div>
      ))}
    </div>
  );
}

/** Ручка для изменения ширины панели; итоговое значение сохраняется при отпускании. */
function Resizer({ side, value, min, max, onLive, onCommit }: { side: "left" | "right"; value: number; min: number; max: number; onLive: (v: number) => void; onCommit: (v: number) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const last = useRef(value);
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); start.current = { x: e.clientX, w: value }; last.current = value; document.body.classList.add("resizing"); }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const dx = e.clientX - start.current.x;
        const w = clamp(Math.round(start.current.w + (side === "left" ? dx : -dx)), min, max);
        last.current = w;
        onLive(w);
      }}
      onPointerUp={() => { document.body.classList.remove("resizing"); if (start.current) { start.current = null; onCommit(last.current); } }}
      onPointerCancel={() => { document.body.classList.remove("resizing"); if (start.current) { start.current = null; onCommit(last.current); } }}
      onDoubleClick={() => onCommit(side === "left" ? 260 : 400)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 12;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const sign = (e.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
          onCommit(clamp(value + sign * step, min, max));
        }
      }}
    />
  );
}

function HoverNav() {
  const [revealed, setRevealed] = useState(false);
  const hr = useRef(new HoverReveal());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = () => performance.now() / 1000;
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const delay = hr.current.nextDelay(now());
    if (delay === null) return;
    timer.current = setTimeout(() => {
      hr.current.setBusy(!!document.querySelector(".popover, .scrim"), now());
      if (hr.current.tick(now())) setRevealed(hr.current.revealed);
      schedule();
    }, delay * 1000 + 5);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const touch = (fn: () => void) => { fn(); schedule(); };
  return (
    <>
      <div className="hover-edge" onPointerEnter={() => touch(() => hr.current.setEdge(true, now()))} onPointerLeave={() => touch(() => hr.current.setEdge(false, now()))} />
      {revealed && (
        <div className="hover-panel" onPointerEnter={() => touch(() => hr.current.setPanel(true, now()))} onPointerLeave={() => touch(() => hr.current.setPanel(false, now()))}>
          <Sidebar overlay />
        </div>
      )}
    </>
  );
}

function Shell() {
  const section = useStore((s) => s.section);
  const device = useStore((s) => s.device);
  const exportOpen = useStore((s) => s.exportOpen);
  const whatsNew = useStore((s) => s.whatsNewOpen);
  const [navLive, setNavLive] = useState<number | null>(null);
  const [inspLive, setInspLive] = useState<number | null>(null);
  const lead = isLeadList(section);
  const navW = navLive ?? device.navWidth;
  const inspW = inspLive ?? device.inspectorWidth;

  useEffect(() => {
    void api.whatsNew().then((w) => { if (w.show) setState({ whatsNewOpen: true }); }).catch(() => {});
  }, []);

  const reportOpen = useStore((s) => s.reportOpen);
  const width = useViewportWidth();
  const narrow = width < 900;
  // Рабочая область не должна становиться уже MIN_CENTER: иначе панель сведений наезжает на кнопки верхней панели.
  const navTaken = narrow || !device.navOpen ? 0 : navW;
  const room = width - navTaken - MIN_CENTER;
  const floatInsp = room < INSP_MIN;
  const inspDock = clamp(inspW, INSP_MIN, Math.max(INSP_MIN, Math.min(INSP_MAX, room)));
  const selected = useStore((st) => st.selection.length);
  const peek = useStore((st) => st.navPeek);
  const showInsp = lead && device.inspectorShown && (!floatInsp || selected === 1);

  return (
    <div className="shell" style={{ ["--nav-w" as string]: `${navW}px`, ["--insp-w" as string]: `${floatInsp ? Math.min(inspW, 460) : inspDock}px` }}>
      {narrow ? (
        peek && (
          <>
            <div className="scrim-nav" onPointerDown={() => setState({ navPeek: false })} />
            <div className="hover-panel"><Sidebar overlay /></div>
          </>
        )
      ) : device.navOpen ? (
        <>
          <Sidebar />
          <Resizer side="left" value={navW} min={200} max={380} onLive={setNavLive} onCommit={(v) => { setNavLive(null); void patchDevice({ navWidth: v }); }} />
        </>
      ) : device.sidebarHover ? <HoverNav /> : null}
      <main className="center">
        <TopBar narrow={narrow} />
        <div className="page-host" key={section}>
          {section === "home" && <HomePage />}
          {lead && <LeadsPage />}
          {section === "sources" && <SourcesPage />}
          {section === "runs" && <RunsPage />}
        </div>
      </main>
      {showInsp && (
        floatInsp ? (
          <aside className="inspector float" aria-label="Сведения о лиде">
            <IconButton icon="x" tip="Закрыть" className="inspector-close" onClick={() => select([])} />
            <Inspector />
          </aside>
        ) : (
          <>
            <Resizer side="right" value={inspDock} min={INSP_MIN} max={Math.max(INSP_MIN, Math.min(INSP_MAX, room))} onLive={setInspLive} onCommit={(v) => { setInspLive(null); void patchDevice({ inspectorWidth: v }); }} />
            <aside className="inspector" aria-label="Сведения о лиде">
              <Inspector />
            </aside>
          </>
        )
      )}
      {exportOpen && <ExportDialog />}
      {whatsNew && <WhatsNewDialog />}
      {reportOpen && <ReportDialog onClose={() => setState({ reportOpen: false })} />}
      <CrashPrompt />
    </div>
  );
}
