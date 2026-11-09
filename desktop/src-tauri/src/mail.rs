//! Отправка писем прямо из приложения по SMTP. Протокол и сборка письма отделены от соединения
//! (трейт `SmtpTransport`), поэтому проверяются тестами с поддельным сервером; настоящее TLS-соединение
//! открывает `TlsSmtpTransport`.

use crate::contact::{is_email, normalize_newlines};
use async_trait::async_trait;
use base64::Engine;
use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailProvider {
    Gmail,
    Yandex,
    Mailru,
    Icloud,
    Custom,
}

impl MailProvider {
    pub const ALL: [MailProvider; 5] = [MailProvider::Gmail, MailProvider::Yandex, MailProvider::Mailru, MailProvider::Icloud, MailProvider::Custom];

    pub fn title(self) -> &'static str {
        match self {
            MailProvider::Gmail => "Gmail",
            MailProvider::Yandex => "Яндекс Почта",
            MailProvider::Mailru => "Почта Mail.ru",
            MailProvider::Icloud => "iCloud Почта",
            MailProvider::Custom => "Другой сервер (SMTP)",
        }
    }
    pub fn host(self) -> &'static str {
        match self {
            MailProvider::Gmail => "smtp.gmail.com",
            MailProvider::Yandex => "smtp.yandex.ru",
            MailProvider::Mailru => "smtp.mail.ru",
            MailProvider::Icloud => "smtp.mail.me.com",
            MailProvider::Custom => "",
        }
    }
    pub fn port(self) -> u16 {
        if self == MailProvider::Icloud {
            587
        } else {
            465
        }
    }
    pub fn security(self) -> MailSecurity {
        if self == MailProvider::Icloud {
            MailSecurity::StartTls
        } else {
            MailSecurity::Tls
        }
    }
    /// Страница, где создаётся пароль приложения (обычный пароль сервисы по SMTP не принимают).
    pub fn app_password_page(self) -> Option<&'static str> {
        match self {
            MailProvider::Gmail => Some("https://myaccount.google.com/apppasswords"),
            MailProvider::Yandex => Some("https://id.yandex.ru/security/app-passwords"),
            MailProvider::Mailru => Some("https://account.mail.ru/user/2-step-auth/passwords/"),
            MailProvider::Icloud => Some("https://account.apple.com/account/manage"),
            MailProvider::Custom => None,
        }
    }
    pub fn hint(self) -> &'static str {
        match self {
            MailProvider::Gmail => "Нужна двухэтапная аутентификация и пароль приложения из 16 букв.",
            MailProvider::Yandex => "Создайте пароль приложения для «Почты» и включите доступ по протоколам в настройках Яндекс Почты.",
            MailProvider::Mailru => "Создайте пароль для внешнего приложения в настройках безопасности Mail.ru.",
            MailProvider::Icloud => "Создайте пароль приложения в настройках Apple ID. Логин — адрес @icloud.com.",
            MailProvider::Custom => "Адрес SMTP-сервера и порт даёт ваш почтовый сервис. 465 — TLS, 587 — STARTTLS.",
        }
    }

    /// Сервис по домену адреса, иначе «другой сервер».
    pub fn detect(email: &str) -> MailProvider {
        let domain = email.rsplit('@').next().unwrap_or("").to_lowercase();
        match domain.as_str() {
            "gmail.com" | "googlemail.com" => MailProvider::Gmail,
            "yandex.ru" | "ya.ru" | "yandex.com" | "yandex.by" | "yandex.kz" | "narod.ru" => MailProvider::Yandex,
            "mail.ru" | "inbox.ru" | "list.ru" | "bk.ru" | "internet.ru" => MailProvider::Mailru,
            "icloud.com" | "me.com" | "mac.com" => MailProvider::Icloud,
            _ => MailProvider::Custom,
        }
    }
}

/// Шифрование соединения. Без шифрования приложение не отправляет: пароль ушёл бы открытым текстом.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MailSecurity {
    /// TLS с первого байта (обычно порт 465).
    Tls,
    /// Открытое соединение, затем обязательная команда STARTTLS (обычно порт 587).
    StartTls,
}

/// Как отправлять письма из окна «Написать».
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MailDelivery {
    /// Письмо открывается в почтовой программе по умолчанию: она хранит отправленные.
    MailApp,
    /// Отправка прямо из приложения по SMTP.
    Smtp,
}

/// Настройки почтового ящика без пароля. Пароль приложения лежит в защищённом хранилище.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAccount {
    pub provider: MailProvider,
    pub host: String,
    pub port: u16,
    pub security: MailSecurity,
    pub username: String,
    pub from_address: String,
    pub from_name: String,
    /// Скрытая копия себе: письмо попадает и в свой ящик (так оно видно в почте на всех устройствах).
    pub copy_to_self: bool,
}

impl Default for MailAccount {
    fn default() -> Self {
        Self {
            provider: MailProvider::Custom,
            host: String::new(),
            port: 465,
            security: MailSecurity::Tls,
            username: String::new(),
            from_address: String::new(),
            from_name: String::new(),
            copy_to_self: true,
        }
    }
}

impl MailAccount {
    /// Готовые настройки сервиса по адресу.
    pub fn preset(email: &str, name: &str) -> Self {
        let p = MailProvider::detect(email);
        Self {
            provider: p,
            host: p.host().into(),
            port: if p == MailProvider::Custom { 465 } else { p.port() },
            security: p.security(),
            username: email.into(),
            from_address: email.into(),
            from_name: name.into(),
            copy_to_self: true,
        }
    }

    /// Текст ошибки, если настройки неполные; None — можно отправлять.
    pub fn problem(&self) -> Option<String> {
        let h = self.host.trim();
        if h.is_empty() || h.chars().any(|c| c.is_whitespace() || c == '/' || c == ':') {
            return Some("Укажите адрес SMTP-сервера".into());
        }
        if self.port == 0 {
            return Some("Неверный порт".into());
        }
        if self.username.trim().is_empty() {
            return Some("Укажите логин".into());
        }
        if !is_email(&self.from_address) {
            return Some("Укажите адрес отправителя".into());
        }
        if self.from_name.contains(['\n', '\r']) {
            return Some("Имя отправителя не должно содержать переводов строки".into());
        }
        None
    }

    pub fn encoded(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".into())
    }

    pub fn decode(text: Option<&str>) -> Option<Self> {
        text.and_then(|t| serde_json::from_str(t).ok())
    }
}

/// Письмо: один получатель, простой текст в UTF-8.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct OutgoingMail {
    pub to: String,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MailError {
    InvalidRecipient,
    InvalidAccount(String),
    EmptyMessage,
    NoPassword,
    /// Сервер не предложил STARTTLS: пароль открытым текстом не отправляем.
    TlsUnavailable,
    AuthUnsupported,
    /// Ответ сервера с кодом ошибки на шаге `stage`.
    Server {
        code: u16,
        message: String,
        stage: String,
    },
    BadReply(String),
    Connection(String),
}

impl std::fmt::Display for MailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MailError::InvalidRecipient => f.write_str("Неверный адрес получателя"),
            MailError::InvalidAccount(s) => f.write_str(s),
            MailError::EmptyMessage => f.write_str("Пустое письмо: добавьте тему или текст"),
            MailError::NoPassword => f.write_str("Не задан пароль приложения для почты (Настройки → Обращения)"),
            MailError::TlsUnavailable => f.write_str("Сервер не поддерживает шифрование STARTTLS. Выберите TLS (порт 465)"),
            MailError::AuthUnsupported => f.write_str("Сервер не поддерживает вход по логину и паролю (AUTH PLAIN / LOGIN)"),
            MailError::Server { code, message, stage } => {
                if *code == 535 || *code == 534 || (stage == "AUTH" && *code >= 500) {
                    write!(f, "Почтовый сервер не принял логин или пароль. Нужен пароль приложения, а не обычный пароль. ({code})")
                } else if stage == "RCPT" {
                    write!(f, "Сервер отклонил адрес получателя: {message} ({code})")
                } else {
                    write!(f, "Почтовый сервер ответил ошибкой на шаге {stage}: {message} ({code})")
                }
            }
            MailError::BadReply(s) => write!(f, "Непонятный ответ почтового сервера: {s}"),
            MailError::Connection(s) => write!(f, "Не удалось связаться с почтовым сервером: {s}"),
        }
    }
}

impl std::error::Error for MailError {}

// ------------------------------------------------------------------ сборка письма

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Письмо целиком, строки через CRLF, без завершающей точки DATA.
pub fn build_message(mail: &OutgoingMail, account: &MailAccount, date: DateTime<Utc>, message_id: &str) -> Result<String, MailError> {
    let to = mail.to.trim();
    if !is_email(to) {
        return Err(MailError::InvalidRecipient);
    }
    if let Some(p) = account.problem() {
        return Err(MailError::InvalidAccount(p));
    }
    let subject = mail.subject.replace(['\r', '\n'], " ");
    if subject.trim().is_empty() && mail.body.trim().is_empty() {
        return Err(MailError::EmptyMessage);
    }
    let from_addr = account.from_address.trim();
    let name = account.from_name.trim();
    let domain = from_addr.rsplit('@').next().unwrap_or("localhost");
    let headers = [
        format!("From: {}", if name.is_empty() { format!("<{from_addr}>") } else { format!("{} <{from_addr}>", encoded_word(name)) }),
        format!("To: <{to}>"),
        format!("Subject: {}", encoded_word(&subject)),
        format!("Date: {}", date.with_timezone(&Local).format("%a, %d %b %Y %H:%M:%S %z")),
        format!("Message-ID: <{message_id}@{domain}>"),
        "MIME-Version: 1.0".to_string(),
        "Content-Type: text/plain; charset=UTF-8".to_string(),
        "Content-Transfer-Encoding: base64".to_string(),
        "X-Mailer: Customers".to_string(),
    ];
    let body = normalize_newlines(&mail.body);
    let encoded = B64.encode(body.as_bytes());
    let wrapped: Vec<&str> = encoded.as_bytes().chunks(76).map(|c| std::str::from_utf8(c).unwrap()).collect();
    Ok(format!("{}\r\n\r\n{}\r\n", headers.join("\r\n"), wrapped.join("\r\n")))
}

/// Заголовок в кодировке RFC 2047 (=?UTF-8?B?…?=). Только ASCII без спецсимволов — как есть.
/// Длинный текст делится на несколько слов, каждое не длиннее 75 символов; символ не разрывается.
pub fn encoded_word(text: &str) -> String {
    let plain_ok = text.chars().all(|c| (' '..'\u{7f}').contains(&c)) && !text.contains("=?") && !text.chars().any(|c| "\"<>()@,;:".contains(c));
    if plain_ok && text.chars().count() <= 70 {
        return text.to_string();
    }
    let mut words: Vec<String> = vec![];
    let mut chunk: Vec<u8> = vec![];
    for ch in text.chars() {
        let mut buf = [0u8; 4];
        let bytes = ch.encode_utf8(&mut buf).as_bytes();
        if chunk.len() + bytes.len() > 45 {
            words.push(format!("=?UTF-8?B?{}?=", B64.encode(&chunk)));
            chunk.clear();
        }
        chunk.extend_from_slice(bytes);
    }
    if !chunk.is_empty() || words.is_empty() {
        words.push(format!("=?UTF-8?B?{}?=", B64.encode(&chunk)));
    }
    words.join("\r\n ")
}

/// Точка в начале строки удваивается, чтобы сервер не принял её за конец письма.
pub fn dot_stuffed(message: &str) -> String {
    message.split("\r\n").map(|l| if l.starts_with('.') { format!(".{l}") } else { l.to_string() }).collect::<Vec<_>>().join("\r\n")
}

// ------------------------------------------------------------------ SMTP

/// Соединение с почтовым сервером: байты туда и обратно и включение TLS по STARTTLS.
#[async_trait]
pub trait SmtpTransport: Send {
    /// Следующая порция байтов от сервера. Пустой ответ — соединение закрыто.
    async fn receive(&mut self) -> Result<Vec<u8>, MailError>;
    async fn send(&mut self, data: &[u8]) -> Result<(), MailError>;
    /// Перевести открытое соединение в TLS (после ответа 220 на STARTTLS).
    async fn start_tls(&mut self) -> Result<(), MailError>;
    async fn close(&mut self);
}

#[derive(Debug, Clone, PartialEq)]
pub struct SmtpReply {
    pub code: u16,
    pub lines: Vec<String>,
}

impl SmtpReply {
    pub fn text(&self) -> String {
        self.lines.join(" ")
    }
}

pub struct SmtpClient<'a> {
    transport: &'a mut dyn SmtpTransport,
    buffer: Vec<u8>,
    pub log: Vec<String>,
}

impl<'a> SmtpClient<'a> {
    pub fn new(transport: &'a mut dyn SmtpTransport) -> Self {
        Self { transport, buffer: vec![], log: vec![] }
    }

    /// Отправляет письмо. Транспорт для `Tls` должен быть уже зашифрован, для `StartTls` — открыт.
    pub async fn send(&mut self, mail: &OutgoingMail, account: &MailAccount, password: &str, hostname: &str) -> Result<(), MailError> {
        if password.is_empty() {
            return Err(MailError::NoPassword);
        }
        let message = build_message(mail, account, Utc::now(), &uuid::Uuid::new_v4().to_string())?;
        let result = self.dialog(mail, account, password, hostname, &message).await;
        self.transport.close().await;
        result
    }

    async fn dialog(&mut self, mail: &OutgoingMail, account: &MailAccount, password: &str, hostname: &str, message: &str) -> Result<(), MailError> {
        let greeting = self.reply().await?;
        Self::expect(&greeting, &[220], "приветствие")?;
        let mut caps = self.ehlo(hostname).await?;
        if account.security == MailSecurity::StartTls {
            if !caps.iter().any(|c| c.eq_ignore_ascii_case("STARTTLS")) {
                return Err(MailError::TlsUnavailable);
            }
            self.command("STARTTLS", &[220], "STARTTLS", false).await?;
            self.transport.start_tls().await?;
            self.buffer.clear();
            caps = self.ehlo(hostname).await?;
        }
        self.authenticate(&caps, account.username.trim(), password).await?;
        let from = account.from_address.trim().to_string();
        let to = mail.to.trim().to_string();
        self.command(&format!("MAIL FROM:<{from}>"), &[250], "MAIL", false).await?;
        self.command(&format!("RCPT TO:<{to}>"), &[250, 251], "RCPT", false).await?;
        if account.copy_to_self && from.to_lowercase() != to.to_lowercase() {
            self.command(&format!("RCPT TO:<{from}>"), &[250, 251], "RCPT", false).await?;
        }
        self.command("DATA", &[354], "DATA", false).await?;
        self.transport.send(format!("{}.\r\n", dot_stuffed(message)).as_bytes()).await?;
        self.log.push("C: <письмо>".into());
        let r = self.reply().await?;
        Self::expect(&r, &[250], "DATA")?;
        // Письмо уже принято: ошибка на QUIT не считается неудачей.
        let _ = self.command("QUIT", &[221], "QUIT", false).await;
        Ok(())
    }

    async fn ehlo(&mut self, hostname: &str) -> Result<Vec<String>, MailError> {
        let r = self.command(&format!("EHLO {hostname}"), &[250], "EHLO", false).await?;
        Ok(r.lines.iter().skip(1).map(|l| l.trim().to_string()).collect())
    }

    async fn authenticate(&mut self, caps: &[String], user: &str, password: &str) -> Result<(), MailError> {
        let auth: Vec<String> = caps
            .iter()
            .find(|c| c.to_uppercase().starts_with("AUTH"))
            .map(|c| c.to_uppercase().replace("AUTH=", "AUTH ").split(' ').skip(1).map(str::to_string).collect())
            .unwrap_or_default();
        if auth.iter().any(|a| a == "PLAIN") {
            let token = B64.encode(format!("\0{user}\0{password}"));
            self.command(&format!("AUTH PLAIN {token}"), &[235], "AUTH", true).await?;
        } else if auth.iter().any(|a| a == "LOGIN") {
            self.command("AUTH LOGIN", &[334], "AUTH", false).await?;
            self.command(&B64.encode(user), &[334], "AUTH", true).await?;
            self.command(&B64.encode(password), &[235], "AUTH", true).await?;
        } else {
            return Err(MailError::AuthUnsupported);
        }
        Ok(())
    }

    async fn command(&mut self, line: &str, ok: &[u16], stage: &str, secret: bool) -> Result<SmtpReply, MailError> {
        self.log.push(format!("C: {}", if secret { "<скрыто>" } else { line }));
        self.transport.send(format!("{line}\r\n").as_bytes()).await?;
        let r = self.reply().await?;
        Self::expect(&r, ok, stage)?;
        Ok(r)
    }

    fn expect(r: &SmtpReply, ok: &[u16], stage: &str) -> Result<(), MailError> {
        if ok.contains(&r.code) {
            Ok(())
        } else {
            Err(MailError::Server { code: r.code, message: r.text(), stage: stage.into() })
        }
    }

    /// Ответ сервера, возможно многострочный («250-…» … «250 …»).
    pub async fn reply(&mut self) -> Result<SmtpReply, MailError> {
        let mut lines = vec![];
        loop {
            let line = self.read_line().await?;
            self.log.push(format!("S: {line}"));
            let code = line.get(..3).and_then(|c| c.parse::<u16>().ok()).ok_or_else(|| MailError::BadReply(line.clone()))?;
            let sep = line.chars().nth(3).unwrap_or(' ');
            lines.push(line.get(4..).unwrap_or("").to_string());
            if sep != '-' {
                return Ok(SmtpReply { code, lines });
            }
        }
    }

    async fn read_line(&mut self) -> Result<String, MailError> {
        loop {
            if let Some(i) = self.buffer.iter().position(|b| *b == b'\n') {
                let mut line: Vec<u8> = self.buffer.drain(..=i).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(String::from_utf8_lossy(&line).into_owned());
            }
            if self.buffer.len() > 64 * 1024 {
                return Err(MailError::BadReply("слишком длинная строка".into()));
            }
            let chunk = self.transport.receive().await?;
            if chunk.is_empty() {
                return Err(MailError::Connection("сервер закрыл соединение".into()));
            }
            self.buffer.extend_from_slice(&chunk);
        }
    }
}

// ------------------------------------------------------------------ настоящее соединение

mod net {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio_rustls::client::TlsStream;
    use tokio_rustls::TlsConnector;

    enum Stream {
        Plain(TcpStream),
        Tls(Box<TlsStream<TcpStream>>),
        Closed,
    }

    pub struct TlsSmtpTransport {
        host: String,
        stream: Stream,
        timeout: Duration,
    }

    fn connector() -> TlsConnector {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
        TlsConnector::from(Arc::new(config))
    }

    fn err(e: impl std::fmt::Display) -> MailError {
        MailError::Connection(e.to_string())
    }

    impl TlsSmtpTransport {
        pub async fn connect(host: &str, port: u16, security: MailSecurity) -> Result<Self, MailError> {
            let timeout = Duration::from_secs(30);
            let tcp = tokio::time::timeout(timeout, TcpStream::connect((host, port))).await.map_err(|_| err("время ожидания вышло"))?.map_err(err)?;
            let mut t = Self { host: host.into(), stream: Stream::Plain(tcp), timeout };
            if security == MailSecurity::Tls {
                t.upgrade().await?;
            }
            Ok(t)
        }

        async fn upgrade(&mut self) -> Result<(), MailError> {
            let Stream::Plain(tcp) = std::mem::replace(&mut self.stream, Stream::Closed) else {
                return Err(err("соединение уже зашифровано"));
            };
            let name = rustls_pki_types::ServerName::try_from(self.host.clone()).map_err(err)?;
            let tls = tokio::time::timeout(self.timeout, connector().connect(name, tcp)).await.map_err(|_| err("время ожидания вышло"))?.map_err(err)?;
            self.stream = Stream::Tls(Box::new(tls));
            Ok(())
        }
    }

    #[async_trait]
    impl SmtpTransport for TlsSmtpTransport {
        async fn receive(&mut self) -> Result<Vec<u8>, MailError> {
            let mut buf = vec![0u8; 4096];
            let n = match &mut self.stream {
                Stream::Plain(s) => tokio::time::timeout(self.timeout, s.read(&mut buf)).await,
                Stream::Tls(s) => tokio::time::timeout(self.timeout, s.read(&mut buf)).await,
                Stream::Closed => return Ok(vec![]),
            }
            .map_err(|_| err("время ожидания ответа вышло"))?
            .map_err(err)?;
            buf.truncate(n);
            Ok(buf)
        }

        async fn send(&mut self, data: &[u8]) -> Result<(), MailError> {
            match &mut self.stream {
                Stream::Plain(s) => s.write_all(data).await,
                Stream::Tls(s) => s.write_all(data).await,
                Stream::Closed => return Err(err("соединение закрыто")),
            }
            .map_err(err)
        }

        async fn start_tls(&mut self) -> Result<(), MailError> {
            self.upgrade().await
        }

        async fn close(&mut self) {
            match std::mem::replace(&mut self.stream, Stream::Closed) {
                Stream::Plain(mut s) => {
                    let _ = s.shutdown().await;
                }
                Stream::Tls(mut s) => {
                    let _ = s.shutdown().await;
                }
                Stream::Closed => {}
            }
        }
    }
}

pub use net::TlsSmtpTransport;

/// Отправка через настоящий сервер.
pub async fn send_via_smtp(mail: &OutgoingMail, account: &MailAccount, password: &str) -> Result<(), MailError> {
    if let Some(p) = account.problem() {
        return Err(MailError::InvalidAccount(p));
    }
    let mut t = TlsSmtpTransport::connect(account.host.trim(), account.port, account.security).await?;
    SmtpClient::new(&mut t).send(mail, account, password, "localhost").await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// Поддельный сервер: заранее заданные ответы по одному на каждую команду клиента.
    struct Fake {
        script: VecDeque<&'static str>,
        pending: VecDeque<Vec<u8>>,
        sent: Vec<String>,
        tls_started: bool,
        closed: bool,
    }

    impl Fake {
        fn new(greeting: &'static str, replies: &[&'static str]) -> Self {
            let mut f = Fake { script: replies.iter().copied().collect(), pending: VecDeque::new(), sent: vec![], tls_started: false, closed: false };
            f.pending.push_back(greeting.as_bytes().to_vec());
            f
        }
    }

    #[async_trait]
    impl SmtpTransport for Fake {
        async fn receive(&mut self) -> Result<Vec<u8>, MailError> {
            Ok(self.pending.pop_front().unwrap_or_default())
        }
        async fn send(&mut self, data: &[u8]) -> Result<(), MailError> {
            self.sent.push(String::from_utf8_lossy(data).into_owned());
            if let Some(r) = self.script.pop_front() {
                self.pending.push_back(r.as_bytes().to_vec());
            }
            Ok(())
        }
        async fn start_tls(&mut self) -> Result<(), MailError> {
            self.tls_started = true;
            Ok(())
        }
        async fn close(&mut self) {
            self.closed = true;
        }
    }

    fn account() -> MailAccount {
        let mut a = MailAccount::preset("me@gmail.com", "Анна");
        a.copy_to_self = true;
        a
    }

    fn mail() -> OutgoingMail {
        OutgoingMail {
            to: "client@example.com".into(), subject: "Сайт для кафе".into(), body: "Здравствуйте!\n.\nТочка в начале строки.".into()
        }
    }

    const OK_SCRIPT: [&str; 9] = [
        "250-mx\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 100\r\n",
        "235 ok\r\n",
        "250 ok\r\n",
        "250 ok\r\n",
        "250 ok\r\n",
        "354 go\r\n",
        "250 queued\r\n",
        "221 bye\r\n",
        "",
    ];

    #[tokio::test]
    async fn full_dialog_with_tls_and_copy_to_self() {
        let mut f = Fake::new("220 hello\r\n", &OK_SCRIPT);
        SmtpClient::new(&mut f).send(&mail(), &account(), "app-password", "localhost").await.unwrap();
        let s = f.sent.join("");
        assert!(s.starts_with("EHLO localhost\r\n"));
        assert!(s.contains(&format!("AUTH PLAIN {}", B64.encode("\0me@gmail.com\0app-password"))));
        assert!(s.contains("MAIL FROM:<me@gmail.com>\r\n"));
        assert!(s.contains("RCPT TO:<client@example.com>\r\n") && s.contains("RCPT TO:<me@gmail.com>\r\n"));
        assert!(s.ends_with("QUIT\r\n"));
        assert!(f.closed && !f.tls_started);
        let data = f.sent.iter().find(|p| p.ends_with("\r\n.\r\n")).unwrap();
        assert!(data.contains("Subject: =?UTF-8?B?"));
        assert!(data.contains("Content-Transfer-Encoding: base64"));
    }

    #[tokio::test]
    async fn password_never_reaches_the_log() {
        let mut f = Fake::new("220 hello\r\n", &OK_SCRIPT);
        let mut c = SmtpClient::new(&mut f);
        c.send(&mail(), &account(), "app-password", "localhost").await.unwrap();
        let log = c.log.join("\n");
        assert!(!log.contains("app-password") && !log.contains(&B64.encode("app-password")));
        assert!(log.contains("C: <скрыто>"));
    }

    #[tokio::test]
    async fn starttls_is_mandatory_and_restarts_ehlo() {
        let mut a = account();
        a.security = MailSecurity::StartTls;
        let mut denied = Fake::new("220 hi\r\n", &["250-mx\r\n250 SIZE 1\r\n"]);
        assert_eq!(SmtpClient::new(&mut denied).send(&mail(), &a, "p", "h").await.unwrap_err(), MailError::TlsUnavailable);
        assert!(!denied.sent.iter().any(|s| s.starts_with("AUTH")), "пароль не отправлен");
        let mut script = vec!["250-mx\r\n250 STARTTLS\r\n", "220 ready\r\n"];
        script.extend(OK_SCRIPT);
        let mut ok = Fake::new("220 hi\r\n", &script);
        SmtpClient::new(&mut ok).send(&mail(), &a, "p", "h").await.unwrap();
        assert!(ok.tls_started);
        assert_eq!(ok.sent.iter().filter(|s| s.starts_with("EHLO")).count(), 2);
    }

    #[tokio::test]
    async fn auth_failure_and_recipient_rejection_have_clear_messages() {
        let mut f = Fake::new("220 hi\r\n", &["250-mx\r\n250 AUTH LOGIN\r\n", "334 VXNlcg==\r\n", "334 UGFzcw==\r\n", "535 5.7.8 bad\r\n"]);
        let e = SmtpClient::new(&mut f).send(&mail(), &account(), "p", "h").await.unwrap_err();
        assert!(matches!(e, MailError::Server { code: 535, .. }));
        assert!(e.to_string().contains("пароль приложения"));
        let mut f = Fake::new("220 hi\r\n", &["250-mx\r\n250 AUTH PLAIN\r\n", "235 ok\r\n", "250 ok\r\n", "550 no such user\r\n"]);
        let e = SmtpClient::new(&mut f).send(&mail(), &account(), "p", "h").await.unwrap_err();
        assert!(e.to_string().starts_with("Сервер отклонил адрес получателя"));
        assert!(f.closed);
        let mut f = Fake::new("220 hi\r\n", &["250-mx\r\n250 SIZE 1\r\n"]);
        assert_eq!(SmtpClient::new(&mut f).send(&mail(), &account(), "p", "h").await.unwrap_err(), MailError::AuthUnsupported);
    }

    #[tokio::test]
    async fn validation_happens_before_connecting() {
        let mut f = Fake::new("220 hi\r\n", &[]);
        assert_eq!(SmtpClient::new(&mut f).send(&mail(), &account(), "", "h").await.unwrap_err(), MailError::NoPassword);
        let mut bad = mail();
        bad.to = "not-an-email".into();
        assert_eq!(SmtpClient::new(&mut f).send(&bad, &account(), "p", "h").await.unwrap_err(), MailError::InvalidRecipient);
        let empty = OutgoingMail { to: "a@b.ru".into(), subject: " ".into(), body: "\n".into() };
        assert_eq!(SmtpClient::new(&mut f).send(&empty, &account(), "p", "h").await.unwrap_err(), MailError::EmptyMessage);
        assert!(f.sent.is_empty());
        let closed = {
            let mut f = Fake::new("", &[]);
            SmtpClient::new(&mut f).send(&mail(), &account(), "p", "h").await.unwrap_err()
        };
        assert!(matches!(closed, MailError::Connection(_)));
    }

    #[tokio::test]
    async fn multiline_replies_and_split_chunks_are_assembled() {
        let mut f = Fake::new("220-a\r\n220 b\r\n", &[]);
        f.pending = VecDeque::from(vec![b"220-a\r".to_vec(), b"\n220 b\r\n".to_vec()]);
        let r = SmtpClient::new(&mut f).reply().await.unwrap();
        assert_eq!((r.code, r.lines), (220, vec!["a".to_string(), "b".to_string()]));
        let mut g = Fake::new("garbage\r\n", &[]);
        assert!(matches!(SmtpClient::new(&mut g).reply().await, Err(MailError::BadReply(_))));
    }

    #[test]
    fn message_headers_are_safe_and_encoded() {
        let when = DateTime::parse_from_rfc3339("2026-11-05T09:42:00Z").unwrap().with_timezone(&Utc);
        let mut m = mail();
        m.subject = "Тема\r\nBcc: evil@x.ru".into();
        let text = build_message(&m, &account(), when, "id1").unwrap();
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        assert!(!head.to_lowercase().contains("\nbcc:"), "перевод строки в теме не создаёт заголовок");
        assert!(head.contains("To: <client@example.com>") && head.contains("Message-ID: <id1@gmail.com>"));
        assert!(head.contains("From: =?UTF-8?B?"));
        let decoded = B64.decode(body.replace("\r\n", "")).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "Здравствуйте!\r\n.\r\nТочка в начале строки.");
        assert!(body.split("\r\n").all(|l| l.len() <= 76));
    }

    #[test]
    fn encoded_words() {
        assert_eq!(encoded_word("Hello world"), "Hello world");
        assert!(encoded_word("a@b").starts_with("=?UTF-8?B?"));
        let long = "я".repeat(100);
        let enc = encoded_word(&long);
        let words: Vec<&str> = enc.split("\r\n ").collect();
        assert!(words.len() > 1 && words.iter().all(|w| w.len() <= 75));
        let back: String =
            words.iter().map(|w| String::from_utf8(B64.decode(w.trim_start_matches("=?UTF-8?B?").trim_end_matches("?=")).unwrap()).unwrap()).collect();
        assert_eq!(back, long, "символ не разрывается между словами");
    }

    #[test]
    fn dot_stuffing() {
        assert_eq!(dot_stuffed("a\r\n.b\r\n..c"), "a\r\n..b\r\n...c");
    }

    #[test]
    fn providers_and_settings() {
        assert_eq!(MailProvider::detect("x@Yandex.RU"), MailProvider::Yandex);
        assert_eq!(MailProvider::detect("x@me.com"), MailProvider::Icloud);
        assert_eq!(MailProvider::detect("x@corp.example"), MailProvider::Custom);
        let p = MailAccount::preset("x@icloud.com", "");
        assert_eq!((p.port, p.security), (587, MailSecurity::StartTls));
        assert!(MailAccount::preset("x@corp.example", "").problem().is_some());
        let mut a = account();
        a.from_name = "A\nB".into();
        assert!(a.problem().unwrap().contains("переводов строки"));
        a.from_name = "A".into();
        a.host = "smtp.example.com:465".into();
        assert!(a.problem().is_some());
        let acc = account();
        assert_eq!(MailAccount::decode(Some(&acc.encoded())), Some(acc));
        assert_eq!(MailAccount::decode(Some("{}")), None);
    }
}
