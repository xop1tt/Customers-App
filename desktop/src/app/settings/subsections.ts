import type { SettingsSection } from "../../state/store";

export interface SubSection { id: string; title: string }

/** Подразделы каждой страницы настроек. У страницы с одним подразделом список не раскрывается. */
export function subsectionsOf(section: SettingsSection, cloud: boolean): SubSection[] {
  switch (section) {
    case "account":
      return [
        { id: "profile", title: "Профиль" },
        { id: "security", title: "Вход и безопасность" },
        ...(cloud ? [{ id: "cloud", title: "Синхронизация и данные" }] : []),
      ];
    case "data": return [{ id: "db", title: "База данных" }, { id: "backups", title: "Резервные копии" }, { id: "drives", title: "Облачные диски" }];
    case "appearance": return [{ id: "look", title: "Внешний вид" }, { id: "sidebar", title: "Боковая панель" }];
    case "system": return [{ id: "startup", title: "Запуск и фон" }, { id: "power", title: "Экономия энергии" }];
    case "updates": return [{ id: "version", title: "Версия" }, { id: "params", title: "Параметры" }, { id: "history", title: "История версий" }];
    case "outreach": return [{ id: "mail", title: "Почта" }, { id: "signature", title: "Подпись" }, { id: "calls", title: "Звонки" }];
    case "reports": return [{ id: "diagnostics", title: "Диагностика" }, { id: "log", title: "Журнал ошибок" }, { id: "crashes", title: "Отчёты о сбоях" }];
    default: return [];
  }
}
