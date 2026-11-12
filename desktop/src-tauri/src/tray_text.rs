//! Подписи меню в строке меню (macOS) и в трее (Windows) на двух языках. Отдельно от оболочки, чтобы проверять без окна.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Ru,
    En,
}

impl Lang {
    /// "ru" и "en" (в том числе "en-US", "ru_RU"); всё остальное — английский, как язык интерфейса по умолчанию.
    pub fn parse(code: &str) -> Lang {
        if code.trim().to_lowercase().starts_with("ru") {
            Lang::Ru
        } else {
            Lang::En
        }
    }
}

pub struct TrayText {
    pub tooltip: &'static str,
    pub open: &'static str,
    pub search: &'static str,
    pub stop: &'static str,
    pub new_leads: &'static str,
    pub sync: &'static str,
    pub updates: &'static str,
    pub settings: &'static str,
    pub quit: &'static str,
}

pub fn text(lang: Lang) -> TrayText {
    match lang {
        Lang::Ru => TrayText {
            tooltip: "Customers",
            open: "Открыть Customers",
            search: "Найти лидов сейчас",
            stop: "Остановить поиск",
            new_leads: "Показать новые лиды",
            sync: "Синхронизировать",
            updates: "Проверить обновления",
            settings: "Настройки…",
            quit: "Выйти",
        },
        Lang::En => TrayText {
            tooltip: "Customers",
            open: "Open Customers",
            search: "Find leads now",
            stop: "Stop search",
            new_leads: "Show new leads",
            sync: "Sync now",
            updates: "Check for updates",
            settings: "Settings…",
            quit: "Quit",
        },
    }
}

/// Строка состояния вверху меню: «Идёт поиск · новых: 3».
pub fn status(lang: Lang, searching: bool, new_leads: i64) -> String {
    match lang {
        Lang::Ru => {
            let s = if searching { "Идёт поиск" } else { "Поиск не идёт" };
            format!("{s} · новых: {new_leads}")
        }
        Lang::En => {
            let s = if searching { "Searching" } else { "Idle" };
            format!("{s} · new: {new_leads}")
        }
    }
}

/// Подсказка у значка: число новых лидов, если они есть.
pub fn tooltip(lang: Lang, new_leads: i64) -> String {
    let base = text(lang).tooltip;
    if new_leads > 0 {
        match lang {
            Lang::Ru => format!("{base}: новых лидов {new_leads}"),
            Lang::En => format!("{base}: {new_leads} new leads"),
        }
    } else {
        base.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_codes() {
        assert_eq!(Lang::parse("ru"), Lang::Ru);
        assert_eq!(Lang::parse("ru-RU"), Lang::Ru);
        assert_eq!(Lang::parse(" RU_ru "), Lang::Ru);
        assert_eq!(Lang::parse("en-US"), Lang::En);
        assert_eq!(Lang::parse("de"), Lang::En);
        assert_eq!(Lang::parse(""), Lang::En);
    }

    #[test]
    fn both_languages_have_every_label() {
        for lang in [Lang::Ru, Lang::En] {
            let t = text(lang);
            for s in [t.tooltip, t.open, t.search, t.stop, t.new_leads, t.sync, t.updates, t.settings, t.quit] {
                assert!(!s.trim().is_empty());
            }
        }
        assert_ne!(text(Lang::Ru).open, text(Lang::En).open);
        assert!(text(Lang::En).open.is_ascii());
    }

    #[test]
    fn status_and_tooltip() {
        assert_eq!(status(Lang::Ru, true, 3), "Идёт поиск · новых: 3");
        assert_eq!(status(Lang::En, false, 0), "Idle · new: 0");
        assert_eq!(tooltip(Lang::En, 0), "Customers");
        assert_eq!(tooltip(Lang::En, 5), "Customers: 5 new leads");
        assert_eq!(tooltip(Lang::Ru, 5), "Customers: новых лидов 5");
    }
}
