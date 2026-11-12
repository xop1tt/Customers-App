import { QuickSearch, toggleQuick } from "./QuickSearch";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { isLeadList } from "../lib/leads";
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
import { RunsPage } from "./pages/RunsPage";
import { Settings } from "./settings/Settings";
import { Marketplace } from "./market/Marketplace";
import { useMarketInstalled } from "../state/market";
import { useHubSync } from "../state/hub";
import { AiPage } from "./pages/AiPage";
import { ReportDialog } from "./settings/SystemSections";
import { ExportDialog } from "./ExportDialog";
import { CrashPrompt, StartupError, WhatsNewDialog } from "./Prompts";
import { useViewportWidth } from "../state/hooks";
import { CalendarPage } from "./crm/CalendarPage";
import { CollectionPage } from "./crm/CollectionPage";
import { ModuleRail, RAIL_W } from "./ModuleRail";
import { DealBoard } from "./crm/DealBoard";
import { ReportsPage } from "./crm/ReportsPage";
import { TodayPage } from "./crm/TodayPage";
import { CrmCard } from "./crm/CrmCard";
import { CollectionDialog } from "./crm/Collections";
import { WorkspaceDialog } from "./crm/WorkspaceDialog";
import { JournalPage } from "./crm/JournalPage";
import { TrashPage } from "./crm/TrashPage";
import { ProfilePage } from "./team/ProfilePage";
import { PeoplePage } from "./team/PeoplePage";
import { ChatPage } from "./team/ChatPage";
import { NotificationsPage } from "./team/NotificationsPage";
import { useChatPolling } from "../state/team";


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
      } else if (e.key.toLowerCase() === "k" && !e.shiftKey && st.phase === "ready") {
        // ⇧⌘K занято пунктом меню «Отметить все как просмотренные».
        e.preventDefault();
        toggleQuick();
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
      <Marketplace />
      {phase === "ready" && <QuickSearch />}
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

/**
 * Ручка у края панели. Тянется в обе стороны: если потянуть до `collapseAt` и меньше, панель сворачивается (0);
 * у свёрнутой панели ручка остаётся у края, курсор над ней — «вытянуть панель», зажатием панель выдвигается.
 * `value` — текущая ширина (0 — свёрнута); итог сохраняется при отпускании.
 */
function Resizer({ side, value, min, max, collapseAt, defaultW, onLive, onCommit }: { side: "left" | "right"; value: number; min: number; max: number; collapseAt: number; defaultW: number; onLive: (v: number) => void; onCommit: (v: number) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const last = useRef(value);
  const finish = () => { document.body.classList.remove("resizing"); if (start.current) { start.current = null; onCommit(last.current); } };
  return (
    <div
      className={`resizer${value === 0 ? ` collapsed ${side}` : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Ширина панели"
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); start.current = { x: e.clientX, w: value }; last.current = value; document.body.classList.add("resizing"); }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const dx = e.clientX - start.current.x;
        const raw = Math.round(start.current.w + (side === "left" ? dx : -dx));
        const w = raw < collapseAt ? 0 : clamp(raw, min, max);
        last.current = w;
        onLive(w);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={() => onCommit(value === 0 ? defaultW : 0)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 12;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const sign = (e.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
          const next = value + sign * step;
          onCommit(next < collapseAt ? 0 : clamp(value === 0 ? min : next, min, max));
        }
      }}
    />
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
  // Видимая ширина левой панели: при перетаскивании — живое значение, иначе сохранённое (0 — свёрнута).
  const navVis = navLive ?? (device.navOpen ? device.navWidth : 0);
  const navW = navVis || device.navWidth;
  const inspW = inspLive && inspLive > 0 ? inspLive : device.inspectorWidth;

  useEffect(() => {
    void api.whatsNew().then((w) => { if (w.show) setState({ whatsNewOpen: true }); }).catch(() => {});
  }, []);

  const reportOpen = useStore((s) => s.reportOpen);
  const width = useViewportWidth();
  const narrow = width < 900;
  // Рабочая область не должна становиться уже MIN_CENTER: иначе панель сведений наезжает на кнопки верхней панели.
  const navTaken = RAIL_W + (narrow ? 0 : navVis);
  const room = width - navTaken - MIN_CENTER;
  const floatInsp = room < INSP_MIN;
  const inspDock = clamp(inspW, INSP_MIN, Math.max(INSP_MIN, Math.min(INSP_MAX, room)));
  const selected = useStore((st) => st.selection.length);
  const peek = useStore((st) => st.navPeek);
  const crmRecord = useStore((st) => st.record);
  const collectionId = useStore((st) => st.collectionId);
  const profileId = useStore((st) => st.profileId);
  useChatPolling();
  useMarketInstalled();
  useHubSync();
  const collectionKey = useStore((st) => (st.collectionEdit ? st.collectionEdit.id ?? "new" : "closed"));
  const crm = section === "collection" || section === "today" || section === "calendar" || section === "deals" || section === "reports" || section === "trash" || section === "journal";
  const leadOpen = lead && (inspLive !== null ? inspLive > 0 && !floatInsp : device.inspectorShown && (!floatInsp || selected === 1));
  const showInsp = leadOpen || (crm && !!crmRecord && inspLive !== 0);
  const inspHandle = !floatInsp && (lead || (crm && !!crmRecord));
  const commitInsp = (w: number) => {
    setInspLive(null);
    if (crm) { if (w === 0) setState({ record: null }); else void patchDevice({ inspectorWidth: w }); return; }
    void patchDevice(w === 0 ? { inspectorShown: false } : { inspectorShown: true, inspectorWidth: w });
  };
  const InspectorBody = crm ? CrmCard : Inspector;
  // Esc закрывает панель карточки, если не открыто другое окно и курсор не в поле ввода.
  useEffect(() => {
    if (!(crm && crmRecord)) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable='true']") || document.querySelector(".popover, .scrim, .settings-scrim, [role='dialog'][aria-modal='true']"))) return;
      setState({ record: null });
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [crm, crmRecord]);
  const inspLabel = crm ? "Карточка записи" : "Сведения о лиде";

  return (
    <div className="shell" style={{ ["--rail-w" as string]: `${RAIL_W}px`, ["--nav-w" as string]: `${navW}px`, ["--insp-w" as string]: `${floatInsp ? Math.min(inspW, 460) : inspDock}px` }}>
      <ModuleRail />
      {narrow ? (
        <>
          {!peek && <div className="hover-edge" onPointerEnter={() => setState({ navPeek: true })} onPointerDown={() => setState({ navPeek: true })} />}
          {peek && (
            <>
              <div className="scrim-nav" onPointerDown={() => setState({ navPeek: false })} />
              <div className="hover-panel"><Sidebar overlay /></div>
            </>
          )}
        </>
      ) : (
        <>
          {navVis > 0 && <Sidebar />}
          <Resizer side="left" value={navVis} min={200} max={380} collapseAt={140} defaultW={260} onLive={setNavLive}
            onCommit={(w) => { setNavLive(null); void patchDevice(w === 0 ? { navOpen: false } : { navOpen: true, navWidth: w }); }} />
        </>
      )}
      <main className="center">
        <TopBar />
        <div className="page-host" key={section === "collection" ? `collection:${collectionId}` : section === "profile" ? `profile:${profileId ?? "me"}` : section}>
          {section === "home" && <HomePage />}
          {lead && <LeadsPage />}
          {section === "runs" && <RunsPage />}
          {section === "collection" && <CollectionPage />}
          {section === "today" && <TodayPage />}
          {section === "calendar" && <CalendarPage />}
          {section === "deals" && <DealBoard />}
          {section === "reports" && <ReportsPage />}
          {section === "trash" && <TrashPage />}
          {section === "journal" && <JournalPage />}
          {section === "profile" && <ProfilePage />}
          {section === "people" && <PeoplePage />}
          {section === "chat" && <ChatPage />}
          {section === "notifications" && <NotificationsPage />}
          {section === "ai" && <AiPage />}
        </div>
      </main>
      {showInsp && floatInsp && (
        <aside className="inspector float" aria-label={inspLabel}>
          {!crm && <IconButton icon="x" tip="Закрыть" className="inspector-close" onClick={() => select([])} />}
          <InspectorBody />
        </aside>
      )}
      {inspHandle && (
        <Resizer side="right" value={showInsp ? inspDock : 0} min={INSP_MIN} max={Math.max(INSP_MIN, Math.min(INSP_MAX, room))} collapseAt={INSP_MIN - 100} defaultW={400} onLive={setInspLive} onCommit={commitInsp} />
      )}
      {showInsp && !floatInsp && (
        <aside className="inspector" aria-label={inspLabel}>
          <InspectorBody />
        </aside>
      )}
      {exportOpen && <ExportDialog />}
      {whatsNew && <WhatsNewDialog />}
      {reportOpen && <ReportDialog onClose={() => setState({ reportOpen: false })} />}
      <WorkspaceDialog />
      <CollectionDialog key={collectionKey} />
      <CrashPrompt />
    </div>
  );
}
