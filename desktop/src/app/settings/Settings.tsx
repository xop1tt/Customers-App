import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../ui/icons";
import { IconButton } from "../../ui/kit";
import { type SettingsSection, openSettings, useStore } from "../../state/store";
import { Appearance, SystemSection } from "./Appearance";
import { NotificationsSection, SearchSection } from "./SearchSection";
import { AccountSection } from "./AccountSection";
import { DataSection, ExclusionsSection } from "./DataSection";
import { OutreachSection } from "./OutreachSection";
import { ReportsSection, UpdatesSection } from "./SystemSections";

interface Item { id: SettingsSection; title: string; icon: string }

/** Разделы по категориям, как в Discord: заголовок категории и страницы под ним. */
export const CATEGORIES: { title: string; items: Item[] }[] = [
  { title: "Основные", items: [
    { id: "account", title: "Аккаунт", icon: "user" },
    { id: "data", title: "Данные", icon: "database" },
  ] },
  { title: "Приложение", items: [
    { id: "appearance", title: "Оформление", icon: "palette" },
    { id: "system", title: "Система", icon: "settings" },
    { id: "notifications", title: "Уведомления", icon: "bell" },
    { id: "updates", title: "Обновления", icon: "download" },
  ] },
  { title: "Работа", items: [
    { id: "search", title: "Поиск", icon: "search" },
    { id: "exclusions", title: "Исключения", icon: "ban" },
    { id: "outreach", title: "Способы связи", icon: "mail" },
  ] },
  { title: "Поддержка", items: [
    { id: "reports", title: "Отчёты", icon: "report" },
  ] },
];
const ALL = CATEGORIES.flatMap((c) => c.items);

export function Settings() {
  const section = useStore((s) => s.settings);
  const update = useStore((s) => s.update);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".popover, .scrim")) openSettings(null);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  if (!section) return null;
  const current = ALL.find((s) => s.id === section) ?? (ALL[0] as Item);
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
                <button key={s.id} type="button" className={`nav-item${s.id === current.id ? " active" : ""}`} onClick={() => openSettings(s.id)} aria-current={s.id === current.id ? "page" : undefined}>
                  <Icon name={s.icon} size={16} />
                  <span className="grow ellipsis" style={{ textAlign: "left" }}>{s.title}</span>
                  {s.id === "updates" && hasUpdate && <span className="dot-badge" aria-label="Есть обновление" />}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-main">
          <header className="settings-head">
            <h2>{current.title}</h2>
            <span className="grow" />
            <IconButton icon="x" tip="Закрыть (Esc)" onClick={() => openSettings(null)} />
          </header>
          <div className="settings-scroll">
            <div className="settings-content">
              {current.id === "appearance" && <Appearance />}
              {current.id === "system" && <SystemSection />}
              {current.id === "notifications" && <NotificationsSection />}
              {current.id === "search" && <SearchSection />}
              {current.id === "account" && <AccountSection />}
              {current.id === "data" && <DataSection />}
              {current.id === "exclusions" && <ExclusionsSection />}
              {current.id === "outreach" && <OutreachSection />}
              {current.id === "reports" && <ReportsSection />}
              {current.id === "updates" && <UpdatesSection />}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
