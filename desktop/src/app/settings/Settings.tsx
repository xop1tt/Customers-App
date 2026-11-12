import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../ui/icons";
import { IconButton, SubContext } from "../../ui/kit";
import { subsectionsOf } from "./subsections";
import { type SettingsSection, openSettings, setState, useStore } from "../../state/store";
import { Appearance, SystemSection } from "./Appearance";
import { NotificationsSection, SearchSection } from "./SearchSection";
import { AccountSection } from "./AccountSection";
import { DataSection, ExclusionsSection } from "./DataSection";
import { SourcesSection } from "./SourcesSection";
import { OutreachSection } from "./OutreachSection";
import { ReportsSection, UpdatesSection } from "./SystemSections";
import { AiSection } from "./AiSection";

interface Item { id: SettingsSection; title: string; icon: string }

/** Разделы по категориям, как в Discord: заголовок категории и страницы под ним. */
export const CATEGORIES: { title: string; items: Item[] }[] = [
  { title: "Личное", items: [
    { id: "account", title: "Аккаунт", icon: "user" },
    { id: "appearance", title: "Оформление", icon: "palette" },
    { id: "notifications", title: "Уведомления", icon: "bell" },
  ] },
  { title: "Приложение", items: [
    { id: "system", title: "Система", icon: "settings" },
    { id: "updates", title: "Обновления", icon: "download" },
  ] },
  { title: "Поиск клиентов", items: [
    { id: "search", title: "Автопоиск", icon: "search" },
    { id: "sources", title: "Источники", icon: "database" },
    { id: "exclusions", title: "Исключения из поиска", icon: "ban" },
    { id: "outreach", title: "Почта и звонки", icon: "mail" },
  ] },
  { title: "Ai", items: [
    { id: "ai", title: "Локальная модель", icon: "bot" },
  ] },
  { title: "Данные", items: [
    { id: "data", title: "Копии и перенос", icon: "database" },
  ] },
  { title: "Поддержка", items: [
    { id: "reports", title: "Диагностика и сбои", icon: "report" },
  ] },
];
/** Администрирование рабочего пространства: видно только тем, у кого есть право управлять им (открывает диалог пространства). */
export function canAdminister(perms: string[] | undefined): boolean {
  return !!perms && (perms.includes("workspace.manage") || perms.includes("members.manage"));
}
const ALL = CATEGORIES.flatMap((c) => c.items);

export function Settings() {
  const section = useStore((s) => s.settings);
  const sub = useStore((s) => s.settingsSub);
  const update = useStore((s) => s.update);
  const cloud = useStore((s) => !!s.session?.isCloud);
  const appVersion = useStore((s) => s.boot?.version ?? s.update?.current ?? "");
  const admin = useStore((s) => canAdminister(s.ws?.active ? s.ws.permissions : undefined));
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".popover, .scrim")) openSettings(null);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  if (!section) return null;
  const current = ALL.find((s) => s.id === section) ?? (ALL[0] as Item);
  const subs = subsectionsOf(current.id, cloud);
  const activeSub = subs.find((x) => x.id === sub)?.id ?? subs[0]?.id ?? null;
  const hasUpdate = update && ["available", "ready", "downloading"].includes(update.phase);
  return createPortal(
    <div className="settings-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) openSettings(null); }}>
      <div className="settings" role="dialog" aria-modal="true" aria-label="Настройки">
        <nav className="settings-nav" aria-label="Разделы настроек">
          <h3 className="settings-title">Настройки</h3>
          {CATEGORIES.map((c) => (
            <div key={c.title} className="settings-cat">
              <div className="nav-title">{c.title}</div>
              {c.items.map((s) => (
                <div key={s.id} className="settings-item">
                  <button type="button" className={`nav-item${s.id === current.id ? " active" : ""}`} onClick={() => openSettings(s.id)} aria-current={s.id === current.id ? "page" : undefined} aria-expanded={s.id === current.id && subs.length > 1 ? true : undefined}>
                    <Icon name={s.icon} size={16} />
                    <span className="grow ellipsis" style={{ textAlign: "left" }}>{s.title}</span>
                    {s.id === "updates" && hasUpdate && <span className="dot-badge" aria-label="Есть обновление" />}
                  </button>
                  {s.id === current.id && subs.length > 1 && (
                    <div className="settings-subs" role="group" aria-label={`Подразделы: ${s.title}`}>
                      {subs.map((x) => (
                        <button key={x.id} type="button" className={`nav-sub${x.id === activeSub ? " active" : ""}`} onClick={() => openSettings(s.id, x.id)} aria-current={x.id === activeSub ? "true" : undefined}>
                          <span className="ellipsis">{x.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
          {admin && (
            <div className="settings-cat">
              <div className="nav-title">Администрирование</div>
              <div className="settings-item">
                <button type="button" className="nav-item" onClick={() => { openSettings(null); setState({ workspaceOpen: true }); }}>
                  <Icon name="users" size={16} />
                  <span className="grow ellipsis" style={{ textAlign: "left" }}>Участники, воронки, поля</span>
                  <Icon name="external" size={12} className="faint" />
                </button>
              </div>
            </div>
          )}
          {appVersion && <div className="settings-version" aria-label="Версия программы">v{appVersion.replace(/^v/i, "")}</div>}
        </nav>
        <div className="settings-main">
          <header className="settings-head">
            <h2>{current.title}{subs.length > 1 && activeSub && <span className="settings-crumb"> / {subs.find((x) => x.id === activeSub)?.title}</span>}</h2>
            <span className="grow" />
            <IconButton icon="x" tip="Закрыть (Esc)" onClick={() => openSettings(null)} />
          </header>
          <div className="settings-scroll">
            <SubContext.Provider value={subs.length > 1 ? activeSub : null}>
            <div className="settings-content">
              {current.id === "appearance" && <Appearance />}
              {current.id === "system" && <SystemSection />}
              {current.id === "notifications" && <NotificationsSection />}
              {current.id === "sources" && <SourcesSection />}
              {current.id === "search" && <SearchSection />}
              {current.id === "account" && <AccountSection />}
              {current.id === "data" && <DataSection />}
              {current.id === "exclusions" && <ExclusionsSection />}
              {current.id === "outreach" && <OutreachSection />}
              {current.id === "reports" && <ReportsSection />}
              {current.id === "updates" && <UpdatesSection />}
              {current.id === "ai" && <AiSection />}
            </div>
            </SubContext.Provider>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
