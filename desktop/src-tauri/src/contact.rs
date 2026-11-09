//! Ссылки для звонка и письма из карточки лида: tel: и mailto:. Систему открывает приложение по
//! умолчанию (на macOS tel: открывает FaceTime, на Windows — «Связь с телефоном» или приложение для звонков).

/// Номер в виде, понятном системе: «+» и цифры. Добавочный номер отбрасывается.
/// Российский номер «8 XXX…» (11 цифр) переводится в «+7 XXX…». Меньше 5 цифр — не номер.
pub fn normalized_phone(raw: &str) -> Option<String> {
    let mut text = raw.to_lowercase();
    for marker in ["доб", "ext", "вн.", "#", ",", ";"] {
        if let Some(i) = text.find(marker) {
            text.truncate(i);
        }
    }
    let trimmed = text.trim();
    let plus = trimmed.starts_with('+');
    let digits: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 5 || digits.len() > 15 {
        return None;
    }
    if !plus && digits.len() == 11 && digits.starts_with('8') {
        return Some(format!("+7{}", &digits[1..]));
    }
    if !plus && digits.len() == 11 && digits.starts_with('7') {
        return Some(format!("+{digits}"));
    }
    Some(format!("{}{}", if plus { "+" } else { "" }, digits))
}

/// tel:+78430000000
pub fn tel_url(phone: &str) -> Option<String> {
    normalized_phone(phone).map(|p| format!("tel:{p}"))
}

/// Программа для звонков. `scheme` — протокол, по которому система находит установленную программу.
pub struct CallApp {
    pub id: &'static str,
    pub title: &'static str,
    pub scheme: &'static str,
    /// Названия программы в папке «Программы» на macOS.
    pub mac_names: &'static [&'static str],
    /// Мессенджеры открывают чат с номером, а звонок начинается кнопкой в самой программе.
    pub opens_chat: bool,
}

pub const CALL_APPS: &[CallApp] = &[
    CallApp { id: "system", title: "Стандартное приложение системы", scheme: "tel", mac_names: &[], opens_chat: false },
    CallApp { id: "whatsapp", title: "WhatsApp", scheme: "whatsapp", mac_names: &["WhatsApp"], opens_chat: true },
    CallApp { id: "telegram", title: "Telegram", scheme: "tg", mac_names: &["Telegram", "Telegram Desktop"], opens_chat: true },
    CallApp { id: "viber", title: "Viber", scheme: "viber", mac_names: &["Viber"], opens_chat: true },
    CallApp { id: "skype", title: "Skype", scheme: "skype", mac_names: &["Skype"], opens_chat: false },
    CallApp { id: "teams", title: "Microsoft Teams", scheme: "msteams", mac_names: &["Microsoft Teams", "Microsoft Teams (work or school)"], opens_chat: false },
    CallApp { id: "facetime", title: "FaceTime", scheme: "facetime-audio", mac_names: &["FaceTime"], opens_chat: false },
];

pub fn call_app(id: &str) -> &'static CallApp {
    CALL_APPS.iter().find(|a| a.id == id).unwrap_or(&CALL_APPS[0])
}

/// Ссылка для звонка через выбранную программу. Неизвестная программа заменяется стандартной.
pub fn call_url(app: &str, phone: &str) -> Option<String> {
    let p = normalized_phone(phone)?;
    let digits: String = p.chars().filter(char::is_ascii_digit).collect();
    Some(match call_app(app).id {
        "whatsapp" => format!("whatsapp://send?phone={digits}"),
        "telegram" => format!("tg://resolve?phone={digits}"),
        "viber" => format!("viber://chat?number=%2B{digits}"),
        "skype" => format!("skype:+{digits}?call"),
        "teams" => format!("msteams://teams.microsoft.com/l/call/0/0?users=4:%2B{digits}"),
        "facetime" => format!("facetime-audio://+{digits}"),
        _ => format!("tel:{p}"),
    })
}

/// Установлена ли программа. Стандартное приложение системы считается установленным всегда.
pub fn call_app_installed(app: &CallApp) -> bool {
    if app.id == "system" {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let dirs = ["/Applications".to_string(), "/System/Applications".to_string(), format!("{home}/Applications")];
        app.mac_names.iter().any(|n| dirs.iter().any(|d| std::path::Path::new(&format!("{d}/{n}.app")).exists()))
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Программа, которая умеет открывать ссылки такого вида, регистрирует протокол в реестре.
        app.id != "facetime"
            && std::process::Command::new("reg")
                .args(["query", &format!("HKEY_CLASSES_ROOT\\{}", app.scheme)])
                .creation_flags(0x0800_0000)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        app.id != "facetime"
            && std::process::Command::new("xdg-mime")
                .args(["query", "default", &format!("x-scheme-handler/{}", app.scheme)])
                .output()
                .map(|o| o.status.success() && !o.stdout.iter().all(u8::is_ascii_whitespace))
                .unwrap_or(false)
    }
}

/// Простая проверка адреса: одна «@», непустые части, точка в домене, без пробелов и управляющих
/// символов (перевод строки в адресе открыл бы подстановку заголовков письма).
pub fn is_email(raw: &str) -> bool {
    let s = raw.trim_matches([' ', '\t']);
    if s.chars().count() > 254 || s.chars().any(|c| c.is_whitespace() || c.is_control() || "<>()[]\\,;:\"".contains(c)) {
        return false;
    }
    let parts: Vec<&str> = s.split('@').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[0].chars().count() > 64 {
        return false;
    }
    let d = parts[1];
    d.contains('.') && !d.starts_with('.') && !d.ends_with('.') && !d.contains("..")
}

pub fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n").replace('\n', "\r\n")
}

const UNRESERVED: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');
const ADDRESS: &percent_encoding::AsciiSet = &UNRESERVED.remove(b'@').remove(b'!').remove(b'$').remove(b'\'').remove(b'*').remove(b'+');

fn encode(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, UNRESERVED).to_string()
}

/// mailto:адрес?subject=…&body=… с кодированием по RFC 6068 (пробел — %20, перевод строки — %0D%0A).
pub fn mailto_url(address: &str, subject: &str, body: &str) -> Option<String> {
    let to = address.trim();
    if !is_email(to) {
        return None;
    }
    let mut query = vec![];
    if !subject.is_empty() {
        query.push(format!("subject={}", encode(subject)));
    }
    if !body.is_empty() {
        query.push(format!("body={}", encode(&normalize_newlines(body))));
    }
    let addr = percent_encoding::utf8_percent_encode(to, ADDRESS).to_string();
    Some(format!("mailto:{addr}{}", if query.is_empty() { String::new() } else { format!("?{}", query.join("&")) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phones() {
        assert_eq!(normalized_phone("+7 (843) 212-48-90").as_deref(), Some("+78432124890"));
        assert_eq!(normalized_phone("8 843 212-48-90").as_deref(), Some("+78432124890"));
        assert_eq!(normalized_phone("7 843 212 48 90").as_deref(), Some("+78432124890"));
        assert_eq!(normalized_phone("+7 843 212-48-90 доб. 12").as_deref(), Some("+78432124890"));
        assert_eq!(normalized_phone("+995 32 2 00 00 00").as_deref(), Some("+995322000000"));
        assert_eq!(normalized_phone("123"), None);
        assert_eq!(normalized_phone("+1234567890123456"), None);
        assert_eq!(normalized_phone("тел."), None);
        assert_eq!(tel_url("8 843 212-48-90").as_deref(), Some("tel:+78432124890"));
    }

    #[test]
    fn call_links_per_app() {
        let n = "8 843 212-48-90";
        assert_eq!(call_url("system", n).as_deref(), Some("tel:+78432124890"));
        assert_eq!(call_url("unknown", n).as_deref(), Some("tel:+78432124890"));
        assert_eq!(call_url("whatsapp", n).as_deref(), Some("whatsapp://send?phone=78432124890"));
        assert_eq!(call_url("telegram", n).as_deref(), Some("tg://resolve?phone=78432124890"));
        assert_eq!(call_url("viber", n).as_deref(), Some("viber://chat?number=%2B78432124890"));
        assert_eq!(call_url("skype", n).as_deref(), Some("skype:+78432124890?call"));
        assert_eq!(call_url("facetime", n).as_deref(), Some("facetime-audio://+78432124890"));
        assert_eq!(call_url("whatsapp", "тел."), None);
        assert!(call_app_installed(call_app("system")));
    }

    #[test]
    fn emails() {
        for ok in ["a@b.ru", " a.b+c@mail.example.com "] {
            assert!(is_email(ok), "{ok}");
        }
        for bad in ["", "a@b", "a b@c.ru", "a@@b.ru", "@b.ru", "a@.ru", "a@b..ru", "a@b.", "a\n@b.ru", "a<b>@c.ru", "a@b.ru\r\nBcc: x@y.ru"] {
            assert!(!is_email(bad), "{bad:?}");
        }
        assert!(!is_email(&format!("{}@b.ru", "a".repeat(65))));
    }

    #[test]
    fn mailto_encoding_follows_rfc6068() {
        assert_eq!(
            mailto_url("a@b.ru", "Тема & раз", "Строка 1\nСтрока 2").unwrap(),
            "mailto:a@b.ru?subject=%D0%A2%D0%B5%D0%BC%D0%B0%20%26%20%D1%80%D0%B0%D0%B7&body=%D0%A1%D1%82%D1%80%D0%BE%D0%BA%D0%B0%201%0D%0A%D0%A1%D1%82%D1%80%D0%BE%D0%BA%D0%B0%202"
        );
        assert_eq!(mailto_url("a+tag@b.ru", "", "").unwrap(), "mailto:a+tag@b.ru");
        assert_eq!(mailto_url("bad", "x", "y"), None);
        // подстановка заголовков через адрес невозможна
        assert_eq!(mailto_url("a@b.ru\nBcc: evil@x.ru", "", ""), None);
    }
}
