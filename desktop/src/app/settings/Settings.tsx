import { useEffect } from "react";
import { Icon } from "../../ui/icons";
import { IconButton } from "../../ui/kit";
import { type SettingsSection, openSettings, useStore } from "../../state/store";
import { Appearance } from "./Appearance";
import { SearchSection } from "./SearchSection";
import { AccountSection } from "./AccountSection";
import { DataSection, ExclusionsSection } from "./DataSection";
import { OutreachSection } from "./OutreachSection";
import { ReportsSection, UpdatesSection } from "./SystemSections";
import { createPortal } from "react-dom";

const SECTIONS: { id: SettingsSection; title: string; icon: string }[] = [
  { id: "appearance", title: "Оформление", icon: "palette" },
  { id: "search", title: "Поиск", icon: "search" },
  { id: "account", title: "Аккаунт", icon: "user" },
  { id: "data", title: "Данные", icon: "database" },
  { id: "exclusions", title: "Исключения", icon: "ban" },
  { id: "outreach", title: "Рассылка", icon: "mail" },
  { id: "reports", title: "Отчёты", icon: "report" },
  { id: "updates", title: "Обновления", icon: "download" },
];

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
  const current = SECTIONS.find((s) => s.id === section) ?? (SECTIONS[0] as (typeof SECTIONS)[number]);
  const hasUpdate = update && ["available", "ready", "downloading"].includes(update.phase);
  return createPortal(
    <div className="settings" role="dialog" aria-modal="true" aria-label="Настройки">
      <nav className="settings-nav" aria-label="Разделы настроек">
        <h3 className="settings-title">Настройки</h3>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className={`nav-item${s.id === section ? " active" : ""}`} onClick={() => openSettings(s.id)} aria-current={s.id === section ? "page" : undefined}>
            <Icon name={s.icon} size={16} />
            <span className="grow ellipsis" style={{ textAlign: "left" }}>{s.title}</span>
            {s.id === "updates" && hasUpdate && <span className="dot-badge" aria-label="Есть обновление" />}
          </button>
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
            {section === "appearance" && <Appearance />}
            {section === "search" && <SearchSection />}
            {section === "account" && <AccountSection />}
            {section === "data" && <DataSection />}
            {section === "exclusions" && <ExclusionsSection />}
            {section === "outreach" && <OutreachSection />}
            {section === "reports" && <ReportsSection />}
            {section === "updates" && <UpdatesSection />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
