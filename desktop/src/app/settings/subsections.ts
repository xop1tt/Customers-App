import { SOURCES } from "../../lib/sources";
import type { SettingsSection } from "../../state/store";

export interface SubSection { id: string; title: string }

/** Подразделы каждой страницы настроек. У страницы с одним подразделом список не раскрывается. */
export function subsectionsOf(section: SettingsSection, _cloud: boolean): SubSection[] {
  switch (section) {
    case "account":
      return [
        { id: "profile", title: "Профиль" },
        { id: "security", title: "Вход и безопасность" },
      ];
    case "data": return [{ id: "db", title: "База данных" }, { id: "backups", title: "Резервные копии" }, { id: "portable", title: "Перенос на другой компьютер" }, { id: "drives", title: "Облачные диски" }];
    case "appearance": return [{ id: "look", title: "Внешний вид" }, { id: "sidebar", title: "Боковая панель" }];
    case "system": return [{ id: "startup", title: "Запуск и фон" }, { id: "power", title: "Экономия энергии" }, { id: "gsearch", title: "Поиск" }];
    case "updates": return [{ id: "version", title: "Версия" }, { id: "history", title: "История версий" }];
    case "outreach": return [{ id: "mail", title: "Почта" }, { id: "signature", title: "Подпись" }, { id: "calls", title: "Звонки" }];
    case "reports": return [{ id: "diagnostics", title: "Диагностика" }, { id: "log", title: "Журнал ошибок" }, { id: "crashes", title: "Отчёты о сбоях" }];
    case "ai": return [{ id: "model", title: "Модель" }, { id: "access", title: "Доступ и подтверждения" }];
    case "sources": return SOURCES.map((s) => ({ id: s.key, title: s.title }));
    default: return [];
  }
}
