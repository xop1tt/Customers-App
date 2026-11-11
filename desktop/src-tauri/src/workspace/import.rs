//! Импорт клиентов из CSV и Excel (пакет B1, docs/IMPORT.md): чтение таблицы, сопоставление колонок с полями CRM,
//! предпросмотр с дубликатами и ошибками, импорт пакетом и отмена пакета целиком.
//!
//! Одна строка таблицы даёт до трёх связанных записей: компанию, контакт и сделку (и заметку). Дубликаты ищутся
//! теми же ключами, что «Похоже на: …» (`dedupe.rs`), и в базе, и среди строк самого файла. Каждый импорт
//! записывается в `import_batches` списком созданных записей: «Отменить импорт» удаляет ровно их (мягко,
//! с синхронизацией), найденные и дополненные существующие записи не трогает.

use super::dedupe;
use super::store::{stamp, WorkspaceStore};
use crate::error::{AppError, AppResult};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Read;

/// Не больше 10 МБ файла и 20 000 строк за один импорт.
pub const MAX_FILE: usize = 10 * 1024 * 1024;
pub const MAX_ROWS: usize = 20_000;
const MAX_UNZIPPED: u64 = 64 * 1024 * 1024;
const PREVIEW_ROWS: usize = 100;

fn err(m: impl Into<String>) -> AppError {
    AppError::msg(m.into())
}

// ------------------------------------------------------------------ таблица

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Table {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// CSV (разделитель `;`, `,` или табуляция; UTF-8, UTF-16 или Windows-1251) или XLSX (первый лист).
pub fn parse(file_name: &str, data: &[u8]) -> AppResult<Table> {
    if data.len() > MAX_FILE {
        return Err(err("Файл больше 10 МБ. Разделите его на части."));
    }
    let lower = file_name.to_lowercase();
    let mut cells = if data.starts_with(b"PK\x03\x04") || lower.ends_with(".xlsx") {
        parse_xlsx(data)?
    } else if lower.ends_with(".xls") {
        return Err(err("Старый формат Excel (.xls) не поддерживается. Сохраните файл как .xlsx или .csv."));
    } else {
        parse_csv(&decode(data))
    };
    cells.retain(|r| r.iter().any(|c| !c.trim().is_empty()));
    if cells.is_empty() {
        return Err(err("В файле нет данных."));
    }
    let width = cells.iter().map(Vec::len).max().unwrap_or(0);
    let mut headers: Vec<String> = cells.remove(0).into_iter().map(|h| h.trim().to_string()).collect();
    headers.resize(width, String::new());
    for (i, h) in headers.iter_mut().enumerate() {
        if h.is_empty() {
            *h = format!("Колонка {}", i + 1);
        }
    }
    if cells.len() > MAX_ROWS {
        return Err(err(format!("В файле больше {MAX_ROWS} строк. Разделите его на части.")));
    }
    for r in &mut cells {
        r.resize(width, String::new());
    }
    Ok(Table { headers, rows: cells })
}

fn decode(data: &[u8]) -> String {
    if let Some(rest) = data.strip_prefix(b"\xEF\xBB\xBF") {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if data.starts_with(b"\xFF\xFE") || data.starts_with(b"\xFE\xFF") {
        let (enc, _) = encoding_rs::Encoding::for_bom(data).unwrap_or((encoding_rs::UTF_16LE, 2));
        return enc.decode(data).0.into_owned();
    }
    match std::str::from_utf8(data) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::WINDOWS_1251.decode(data).0.into_owned(),
    }
}

/// Разделитель — тот из `;`, `,`, табуляции, которого больше всего в первой строке вне кавычек.
fn delimiter(text: &str) -> char {
    let mut counts = [(';', 0usize), (',', 0), ('\t', 0)];
    let mut quoted = false;
    for ch in text.chars() {
        match ch {
            '"' => quoted = !quoted,
            '\n' if !quoted => break,
            c if !quoted => {
                for (d, n) in counts.iter_mut() {
                    if *d == c {
                        *n += 1;
                    }
                }
            }
            _ => {}
        }
    }
    counts.iter().max_by_key(|(_, n)| *n).filter(|(_, n)| *n > 0).map(|(d, _)| *d).unwrap_or(';')
}

/// CSV по RFC 4180: поля в кавычках могут содержать разделитель, перевод строки и `""`.
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let d = delimiter(text);
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' && field.is_empty() {
            quoted = true;
        } else if c == d {
            row.push(std::mem::take(&mut field));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut row));
        } else {
            field.push(c);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

// ------------------------------------------------------------------ XLSX: ZIP + XML первого листа

fn u16le(b: &[u8], at: usize) -> Option<usize> {
    b.get(at..at + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as usize)
}
fn u32le(b: &[u8], at: usize) -> Option<usize> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize)
}

/// Почему архив не прочитан ([`unzip_entries`]).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ZipProblem {
    Corrupt,
    TooBig,
    Method,
}

/// Файлы архива, которые выбрал `wanted`: имя → содержимое (только stored и deflate, распакованных байт не
/// больше `max_total`). Общий для книг XLSX и переносимой копии (пакет G8).
pub(crate) fn unzip_entries(data: &[u8], wanted: &dyn Fn(&str) -> bool, max_total: u64) -> Result<HashMap<String, Vec<u8>>, ZipProblem> {
    let bad = || ZipProblem::Corrupt;
    let eocd = (0..data.len().saturating_sub(21)).rev().take(70_000).find(|&i| data[i..].starts_with(b"PK\x05\x06")).ok_or_else(bad)?;
    let count = u16le(data, eocd + 10).ok_or_else(bad)?;
    let mut at = u32le(data, eocd + 16).ok_or_else(bad)?;
    let mut out = HashMap::new();
    let mut total: u64 = 0;
    for _ in 0..count {
        if !data.get(at..).is_some_and(|s| s.starts_with(b"PK\x01\x02")) {
            return Err(bad());
        }
        let method = u16le(data, at + 10).ok_or_else(bad)?;
        let csize = u32le(data, at + 20).ok_or_else(bad)?;
        let usize_ = u32le(data, at + 24).ok_or_else(bad)?;
        let (nlen, xlen, clen) = (u16le(data, at + 28).ok_or_else(bad)?, u16le(data, at + 30).ok_or_else(bad)?, u16le(data, at + 32).ok_or_else(bad)?);
        let local = u32le(data, at + 42).ok_or_else(bad)?;
        let name = String::from_utf8_lossy(data.get(at + 46..at + 46 + nlen).ok_or_else(bad)?).into_owned();
        at += 46 + nlen + xlen + clen;
        if !wanted(&name) {
            continue;
        }
        if !data.get(local..).is_some_and(|s| s.starts_with(b"PK\x03\x04")) {
            return Err(bad());
        }
        let start = local + 30 + u16le(data, local + 26).ok_or_else(bad)? + u16le(data, local + 28).ok_or_else(bad)?;
        let raw = data.get(start..start + csize).ok_or_else(bad)?;
        total += usize_ as u64;
        if total > max_total {
            return Err(ZipProblem::TooBig);
        }
        let bytes = match method {
            0 => raw.to_vec(),
            8 => {
                let mut v = Vec::with_capacity(usize_.min(16 << 20));
                flate2::read::DeflateDecoder::new(raw).take(max_total).read_to_end(&mut v).map_err(|_| bad())?;
                v
            }
            _ => return Err(ZipProblem::Method),
        };
        out.insert(name, bytes);
    }
    Ok(out)
}

/// Нужные файлы книги Excel.
fn unzip(data: &[u8]) -> AppResult<HashMap<String, Vec<u8>>> {
    let wanted =
        |name: &str| name == "xl/workbook.xml" || name == "xl/_rels/workbook.xml.rels" || name == "xl/sharedStrings.xml" || name.starts_with("xl/worksheets/");
    unzip_entries(data, &wanted, MAX_UNZIPPED).map_err(|p| match p {
        ZipProblem::Corrupt => err("Файл Excel повреждён или это не .xlsx."),
        ZipProblem::TooBig => err("Файл Excel слишком большой после распаковки."),
        ZipProblem::Method => err("Файл Excel сжат неподдерживаемым способом. Сохраните его как .csv."),
    })
}

fn xml_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn attr(e: &quick_xml::events::BytesStart, name: &[u8]) -> Option<String> {
    e.attributes().flatten().find(|a| a.key.as_ref() == name || a.key.local_name().as_ref() == name).and_then(|a| crate::xmltext::attr_value(&a))
}

/// Путь к первому листу книги: workbook.xml → r:id → workbook.xml.rels.
fn first_sheet(files: &HashMap<String, Vec<u8>>) -> Option<String> {
    use quick_xml::events::Event;
    let mut rid = None;
    let wb = xml_text(files.get("xl/workbook.xml")?);
    let mut r = quick_xml::Reader::from_str(&wb);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"sheet" => {
                rid = attr(&e, b"id");
                break;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let rid = rid?;
    let rels = xml_text(files.get("xl/_rels/workbook.xml.rels")?);
    let mut r = quick_xml::Reader::from_str(&rels);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"Relationship" && attr(&e, b"Id").as_deref() == Some(&rid) => {
                let t = attr(&e, b"Target")?;
                let t = t.trim_start_matches('/');
                return Some(if t.starts_with("xl/") { t.to_string() } else { format!("xl/{t}") });
            }
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
    }
}

fn shared_strings(files: &HashMap<String, Vec<u8>>) -> Vec<String> {
    use quick_xml::events::Event;
    let Some(b) = files.get("xl/sharedStrings.xml") else { return vec![] };
    let text = xml_text(b);
    let mut r = quick_xml::Reader::from_str(&text);
    let mut out = Vec::new();
    let (mut cur, mut in_si, mut in_t, mut in_rph) = (String::new(), false, false, false);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"si" => {
                    in_si = true;
                    cur.clear();
                }
                b"t" => in_t = true,
                b"rPh" => in_rph = true,
                _ => {}
            },
            Ok(Event::Empty(e)) if e.local_name().as_ref() == b"si" => out.push(String::new()),
            Ok(Event::Text(t)) if in_si && in_t && !in_rph => cur.push_str(&crate::xmltext::text(&t)),
            Ok(Event::GeneralRef(r)) if in_si && in_t && !in_rph => cur.push_str(&crate::xmltext::entity(&r)),
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"si" => {
                    in_si = false;
                    out.push(std::mem::take(&mut cur));
                }
                b"t" => in_t = false,
                b"rPh" => in_rph = false,
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// «AB12» → 27 (номер колонки с нуля).
fn column_index(cell_ref: &str) -> Option<usize> {
    let letters: String = cell_ref.chars().take_while(char::is_ascii_alphabetic).collect();
    if letters.is_empty() || letters.len() > 3 {
        return None;
    }
    Some(letters.to_ascii_uppercase().bytes().fold(0usize, |n, b| n * 26 + (b - b'A' + 1) as usize) - 1)
}

fn number_text(v: &str) -> String {
    // Целые числа без «.0»: телефоны и ИНН, сохранённые как числа.
    match v.parse::<f64>() {
        Ok(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
        _ => v.to_string(),
    }
}

pub fn parse_xlsx(data: &[u8]) -> AppResult<Vec<Vec<String>>> {
    use quick_xml::events::Event;
    let files = unzip(data)?;
    let sheet = first_sheet(&files).filter(|p| files.contains_key(p)).or_else(|| Some("xl/worksheets/sheet1.xml".into()).filter(|p| files.contains_key(p)));
    let sheet = sheet.ok_or_else(|| err("В файле Excel нет листов."))?;
    let strings = shared_strings(&files);
    let text = xml_text(&files[&sheet]);
    let mut r = quick_xml::Reader::from_str(&text);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let (mut col, mut kind, mut val, mut in_v, mut in_is_t) = (0usize, String::new(), String::new(), false, false);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                b"row" => row.clear(),
                b"c" => {
                    col = attr(&e, b"r").and_then(|c| column_index(&c)).unwrap_or(row.len());
                    kind = attr(&e, b"t").unwrap_or_default();
                    val.clear();
                }
                b"v" => in_v = true,
                b"t" => in_is_t = true,
                _ => {}
            },
            Ok(Event::Text(t)) if in_v || in_is_t => val.push_str(&crate::xmltext::text(&t)),
            Ok(Event::GeneralRef(r)) if in_v || in_is_t => val.push_str(&crate::xmltext::entity(&r)),
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                b"v" => in_v = false,
                b"t" => in_is_t = false,
                b"c" => {
                    let text = match kind.as_str() {
                        "s" => val.trim().parse::<usize>().ok().and_then(|i| strings.get(i).cloned()).unwrap_or_default(),
                        "b" => {
                            if val.trim() == "1" {
                                "да".into()
                            } else {
                                "нет".into()
                            }
                        }
                        "str" | "inlineStr" | "e" => val.clone(),
                        _ => number_text(val.trim()),
                    };
                    if col < 16_384 {
                        if row.len() <= col {
                            row.resize(col + 1, String::new());
                        }
                        row[col] = text;
                    }
                }
                b"row" => {
                    rows.push(std::mem::take(&mut row));
                    if rows.len() > MAX_ROWS + 1 {
                        return Err(err(format!("В файле больше {MAX_ROWS} строк. Разделите его на части.")));
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => return Err(err("Лист Excel не читается: файл повреждён.")),
            _ => {}
        }
    }
    Ok(rows)
}

// ------------------------------------------------------------------ поля и сопоставление

/// Поля, в которые можно загрузить колонку: ключ, подпись, слова в заголовке для автосопоставления.
pub const FIELDS: &[(&str, &str, &[&str])] = &[
    ("company.name", "Компания: название", &["компани", "организац", "название", "наименование", "клиент", "company", "organization", "account"]),
    ("company.inn", "Компания: ИНН", &["инн", "inn", "tax id"]),
    ("company.website", "Компания: сайт", &["сайт", "website", "web", "url", "домен"]),
    ("company.phone", "Компания: телефон", &["телефон компании", "company phone"]),
    ("company.email", "Компания: почта", &["почта компании", "company email"]),
    ("company.address", "Компания: адрес", &["адрес", "город", "address", "city"]),
    ("company.industry", "Компания: отрасль", &["отрасль", "сфера", "industry", "категори"]),
    ("contact.full_name", "Контакт: имя и фамилия", &["контакт", "фио", "имя", "contact", "name", "person"]),
    ("contact.position", "Контакт: должность", &["должность", "position", "title", "job"]),
    ("contact.phone", "Контакт: телефон", &["телефон", "тел", "мобильный", "phone", "mobile"]),
    ("contact.email", "Контакт: почта", &["почта", "email", "e-mail", "mail"]),
    ("deal.title", "Сделка: название", &["сделка", "deal", "opportunity"]),
    ("deal.amount", "Сделка: сумма", &["сумма", "бюджет", "amount", "budget", "стоимость"]),
    ("deal.currency", "Сделка: валюта", &["валюта", "currency"]),
    ("deal.stage", "Сделка: этап", &["этап", "стадия", "статус", "stage", "status"]),
    ("note", "Заметка", &["заметка", "комментарий", "примечание", "описание", "note", "comment", "description"]),
];

pub fn field_label(key: &str) -> Option<&'static str> {
    FIELDS.iter().find(|(k, _, _)| *k == key).map(|(_, l, _)| *l)
}

/// Автосопоставление: каждое поле — не больше одной колонке, побеждает самое длинное совпавшее слово.
pub fn suggest(headers: &[String]) -> Vec<Option<String>> {
    let mut best: Vec<(usize, Option<&str>)> = vec![(0, None); headers.len()];
    for (i, h) in headers.iter().enumerate() {
        let h = h.to_lowercase().replace('ё', "е");
        for (key, _, words) in FIELDS {
            if let Some(len) = words.iter().filter(|w| h.contains(*w)).map(|w| w.chars().count()).max() {
                if len > best[i].0 {
                    best[i] = (len, Some(key));
                }
            }
        }
    }
    let mut used = std::collections::HashSet::new();
    best.into_iter().map(|(_, k)| k.filter(|k| used.insert(*k)).map(String::from)).collect()
}

// ------------------------------------------------------------------ план импорта

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Duplicates {
    /// Найденная компания или контакт используется, новые сделка и заметка привязываются к ней.
    #[default]
    Link,
    /// Строка с уже существующей компанией (или контактом без компании) пропускается целиком.
    Skip,
    /// Всегда создаются новые записи.
    Create,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImportOptions {
    /// Для каждой колонки — ключ поля из `FIELDS` или `null` (не загружать).
    pub mapping: Vec<Option<String>>,
    pub duplicates: Duplicates,
    pub pipeline_id: Option<String>,
    pub owner_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct Row {
    company: Map<String, Value>,
    contact: Map<String, Value>,
    deal: Map<String, Value>,
    stage: Option<String>,
    note: String,
    warnings: Vec<String>,
}

fn put_text(m: &mut Map<String, Value>, key: &str, v: &str, max: usize) {
    let v = v.trim();
    if !v.is_empty() && !m.contains_key(key) {
        m.insert(key.into(), json!(v.chars().take(max).collect::<String>()));
    }
}

fn push_list(m: &mut Map<String, Value>, key: &str, v: &str) {
    let list = m.entry(key.to_string()).or_insert_with(|| json!([])).as_array_mut().map(std::mem::take).unwrap_or_default();
    let mut list = list;
    for part in v.split([',', ';', '\n']).map(str::trim).filter(|p| !p.is_empty()) {
        if list.len() < 20 && !list.iter().any(|x| x == part) {
            list.push(json!(part.chars().take(200).collect::<String>()));
        }
    }
    if list.is_empty() {
        m.remove(key);
    } else {
        m.insert(key.into(), Value::Array(list));
    }
}

/// «1 250 000,50 ₽» → 1250000.5
fn amount(v: &str) -> Option<f64> {
    let s: String = v.chars().filter(|c| c.is_ascii_digit() || matches!(c, ',' | '.' | '-')).collect();
    let s = if s.contains(',') && !s.contains('.') { s.replace(',', ".") } else { s.replace(',', "") };
    s.parse::<f64>().ok().filter(|f| f.is_finite() && *f >= 0.0)
}

fn build_row(table: &Table, cells: &[String], opts: &ImportOptions) -> Row {
    let mut r = Row::default();
    for (i, key) in opts.mapping.iter().enumerate() {
        let (Some(key), Some(v)) = (key.as_deref(), cells.get(i)) else { continue };
        let v = v.trim();
        if v.is_empty() {
            continue;
        }
        let col = table.headers.get(i).map(String::as_str).unwrap_or("");
        match key {
            "company.name" => put_text(&mut r.company, "name", v, 300),
            "company.inn" => {
                let inn: String = v.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
                put_text(&mut r.company, "inn", &inn, 20);
            }
            "company.website" => {
                put_text(&mut r.company, "website", v, 500);
                if let Some(d) = dedupe::domain(v) {
                    put_text(&mut r.company, "domain", &d, 253);
                }
            }
            "company.phone" => push_list(&mut r.company, "phones", v),
            "company.email" => {
                if v.split([',', ';']).all(|e| dedupe::email(e).is_some()) {
                    push_list(&mut r.company, "emails", v)
                } else {
                    r.warnings.push(format!("«{col}»: не похоже на адрес почты, пропущено"));
                }
            }
            "company.address" => put_text(&mut r.company, "address", v, 500),
            "company.industry" => put_text(&mut r.company, "industry", v, 200),
            "contact.full_name" => {
                let (first, last) = v.split_once(char::is_whitespace).map(|(a, b)| (a.trim(), b.trim())).unwrap_or((v, ""));
                put_text(&mut r.contact, "first_name", first, 120);
                put_text(&mut r.contact, "last_name", last, 120);
            }
            "contact.position" => put_text(&mut r.contact, "position", v, 200),
            "contact.phone" => push_list(&mut r.contact, "phones", v),
            "contact.email" => {
                if v.split([',', ';']).all(|e| dedupe::email(e).is_some()) {
                    push_list(&mut r.contact, "emails", v)
                } else {
                    r.warnings.push(format!("«{col}»: не похоже на адрес почты, пропущено"));
                }
            }
            "deal.title" => put_text(&mut r.deal, "title", v, 300),
            "deal.amount" => match amount(v) {
                Some(a) => {
                    r.deal.insert("amount".into(), json!(a));
                }
                None => r.warnings.push(format!("«{col}»: «{v}» — не число, сумма пропущена")),
            },
            "deal.currency" => {
                let c = v.to_uppercase().replace(['₽', '.'], "");
                let c = match c.trim() {
                    "РУБ" | "Р" | "" => "RUB".to_string(),
                    "$" | "ДОЛЛ" => "USD".into(),
                    "€" | "ЕВРО" => "EUR".into(),
                    other => other.to_string(),
                };
                if c.len() == 3 && c.chars().all(|x| x.is_ascii_uppercase()) {
                    r.deal.insert("currency".into(), json!(c));
                } else {
                    r.warnings.push(format!("«{col}»: «{v}» — неизвестная валюта, пропущено"));
                }
            }
            "deal.stage" => r.stage = Some(v.to_string()),
            "note" => {
                if !r.note.is_empty() {
                    r.note.push('\n');
                }
                r.note.push_str(&format!("{col}: {v}"));
            }
            _ => {}
        }
    }
    let has_contact = !r.contact.is_empty();
    if r.deal.contains_key("title") || r.deal.contains_key("amount") {
        if !r.deal.contains_key("title") {
            let who = r.company.get("name").or(r.contact.get("first_name")).and_then(Value::as_str).unwrap_or("клиент").to_string();
            r.deal.insert("title".into(), json!(format!("Сделка: {who}").chars().take(300).collect::<String>()));
        }
    } else {
        r.deal.clear();
    }
    if has_contact && !r.contact.contains_key("first_name") && !r.contact.contains_key("last_name") && !r.company.is_empty() {
        // Телефон и почта без имени человека — контакты самой компании.
        for key in ["phones", "emails"] {
            if let Some(Value::Array(list)) = r.contact.remove(key) {
                for v in list.iter().filter_map(Value::as_str) {
                    push_list(&mut r.company, key, v);
                }
            }
        }
        if r.contact.contains_key("position") {
            r.warnings.push("Должность без имени контакта пропущена".into());
        }
        r.contact.clear();
    }
    r
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowPreview {
    /// Номер строки в файле (заголовок — строка 1).
    pub line: usize,
    pub company: Option<String>,
    pub contact: Option<String>,
    pub deal: Option<String>,
    /// new | existing | skip | empty | error
    pub status: &'static str,
    pub existing: Option<String>,
    pub messages: Vec<String>,
}

fn display_contact(c: &Map<String, Value>) -> Option<String> {
    if c.is_empty() {
        return None;
    }
    let name = [c.get("first_name"), c.get("last_name")].iter().flatten().filter_map(|v| v.as_str()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
    if !name.is_empty() {
        return Some(name);
    }
    ["phones", "emails"].iter().find_map(|k| c.get(*k).and_then(|v| v.get(0)).and_then(Value::as_str).map(String::from))
}

struct Planned {
    row: Row,
    preview: RowPreview,
    company_match: Option<String>,
    contact_match: Option<String>,
}

/// Строки → план: что будет создано, что найдено, что пропущено. Дубликаты внутри файла склеиваются по ключам.
fn plan(store: &WorkspaceStore, table: &Table, opts: &ImportOptions) -> AppResult<Vec<Planned>> {
    if opts.mapping.iter().flatten().all(|k| field_label(k).is_none()) {
        return Err(err("Выберите, какие колонки загружать: ни одна не сопоставлена с полем CRM."));
    }
    let mut seen_companies: HashMap<String, usize> = HashMap::new();
    let mut seen_contacts: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::with_capacity(table.rows.len());
    for (i, cells) in table.rows.iter().enumerate() {
        let row = build_row(table, cells, opts);
        let mut p = RowPreview {
            line: i + 2,
            company: row.company.get("name").and_then(Value::as_str).map(String::from),
            contact: display_contact(&row.contact),
            deal: row.deal.get("title").and_then(Value::as_str).map(String::from),
            status: "new",
            existing: None,
            messages: row.warnings.clone(),
        };
        let mut company_match = None;
        let mut contact_match = None;
        if row.company.is_empty() && row.contact.is_empty() {
            p.status = if row.deal.is_empty() && row.note.is_empty() { "empty" } else { "error" };
            if p.status == "error" {
                p.messages.push("Нет ни компании, ни контакта: сделку и заметку не к чему привязать".into());
            }
        } else if !row.company.is_empty() && !row.company.contains_key("name") {
            p.status = "error";
            p.messages.push("У компании нет названия".into());
        } else if !row.contact.is_empty() && !row.contact.contains_key("first_name") && !row.contact.contains_key("last_name") {
            p.status = "error";
            p.messages.push("У контакта нет имени, а компании в строке нет".into());
        } else if opts.duplicates != Duplicates::Create {
            if !row.company.is_empty() {
                let keys = dedupe::keys("companies", &row.company);
                if let Some(found) = store.duplicates("companies", &keys, None)?.into_iter().next() {
                    company_match = found["id"].as_str().map(String::from);
                    p.existing = found["name"].as_str().map(|n| format!("Компания уже есть: {n}"));
                } else if let Some(line) = keys.iter().find_map(|k| seen_companies.get(k)) {
                    p.existing = Some(format!("Та же компания, что в строке {line}"));
                    company_match = Some(format!("line:{line}"));
                }
                for k in keys {
                    seen_companies.entry(k).or_insert(p.line);
                }
            }
            if !row.contact.is_empty() {
                let keys = dedupe::keys("contacts", &row.contact);
                if let Some(found) = store.duplicates("contacts", &keys, None)?.into_iter().next() {
                    contact_match = found["id"].as_str().map(String::from);
                    if p.existing.is_none() {
                        p.existing = found["full_name"].as_str().map(|n| format!("Контакт уже есть: {n}"));
                    }
                } else if let Some(line) = keys.iter().find_map(|k| seen_contacts.get(k)) {
                    contact_match = Some(format!("line:{line}"));
                    if p.existing.is_none() {
                        p.existing = Some(format!("Тот же контакт, что в строке {line}"));
                    }
                }
                for k in keys {
                    seen_contacts.entry(k).or_insert(p.line);
                }
            }
            let main_match = if row.company.is_empty() { &contact_match } else { &company_match };
            if main_match.is_some() {
                p.status = if opts.duplicates == Duplicates::Skip { "skip" } else { "existing" };
            }
        }
        out.push(Planned { row, preview: p, company_match, contact_match });
    }
    Ok(out)
}

pub fn preview(store: &WorkspaceStore, table: &Table, opts: &ImportOptions) -> AppResult<Value> {
    let planned = plan(store, table, opts)?;
    let count = |s: &str| planned.iter().filter(|p| p.preview.status == s).count();
    let active = |p: &&Planned| matches!(p.preview.status, "new" | "existing");
    let deals = planned.iter().filter(active).filter(|p| !p.row.deal.is_empty()).count();
    let contacts = planned.iter().filter(active).filter(|p| !p.row.contact.is_empty()).count();
    let warnings = planned.iter().filter(|p| !p.preview.messages.is_empty()).count();
    let mut rows: Vec<&RowPreview> = planned.iter().map(|p| &p.preview).filter(|p| p.status != "empty").collect();
    // Сначала строки, требующие внимания.
    rows.sort_by_key(|p| {
        (
            match p.status {
                "error" => 0,
                "skip" => 1,
                "existing" => 2,
                _ => {
                    if p.messages.is_empty() {
                        4
                    } else {
                        3
                    }
                }
            },
            p.line,
        )
    });
    rows.truncate(PREVIEW_ROWS);
    Ok(json!({
        "rows": table.rows.len(),
        "new": count("new"), "existing": count("existing"), "skipped": count("skip"), "errors": count("error"), "empty": count("empty"),
        "deals": deals, "contacts": contacts, "warnings": warnings,
        "items": rows,
    }))
}

// ------------------------------------------------------------------ импорт и отмена

fn ensure_table(store: &WorkspaceStore) -> AppResult<()> {
    store.conn().execute_batch(
        "CREATE TABLE IF NOT EXISTS import_batches(id TEXT PRIMARY KEY, file TEXT NOT NULL, created_at TEXT NOT NULL,
             created TEXT NOT NULL, summary TEXT NOT NULL, undone_at TEXT)",
    )?;
    Ok(())
}

fn stage_by_name(store: &WorkspaceStore, pipeline: &str, name: &str) -> Option<String> {
    store
        .conn()
        .query_row(
            "SELECT id FROM pipeline_stages WHERE pipeline_id=?1 AND deleted_at IS NULL AND lower(trim(name))=lower(trim(?2)) LIMIT 1",
            params![pipeline, name],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
}

pub fn run(store: &WorkspaceStore, file_name: &str, table: &Table, opts: &ImportOptions) -> AppResult<Value> {
    ensure_table(store)?;
    let planned = plan(store, table, opts)?;
    let batch = super::store::new_id();
    let mut created: Vec<(String, String)> = Vec::new();
    let mut by_line_company: HashMap<usize, String> = HashMap::new();
    let mut by_line_contact: HashMap<usize, String> = HashMap::new();
    let (mut companies, mut contacts, mut deals, mut notes, mut linked, mut skipped) = (0, 0, 0, 0, 0, 0);
    let mut errors: Vec<Value> = Vec::new();
    let mut stage_misses: Vec<String> = Vec::new();
    let pipeline = if planned.iter().any(|p| !p.row.deal.is_empty()) { Some(store.first_stage(opts.pipeline_id.as_deref())?) } else { None };
    let source = format!("import:{}", file_name.chars().take(80).collect::<String>());

    let resolve = |m: &Option<String>, by_line: &HashMap<usize, String>| -> Option<String> {
        match m.as_deref() {
            Some(s) if s.starts_with("line:") => s[5..].parse::<usize>().ok().and_then(|l| by_line.get(&l).cloned()),
            other => other.map(String::from),
        }
    };

    for p in &planned {
        match p.preview.status {
            "empty" => continue,
            "skip" => {
                skipped += 1;
                continue;
            }
            "error" => {
                errors.push(json!({"line": p.preview.line, "message": p.preview.messages.join("; ")}));
                continue;
            }
            _ => {}
        }
        let line = p.preview.line;
        let mut step = || -> AppResult<()> {
            let mut company_id = None;
            if !p.row.company.is_empty() {
                match resolve(&p.company_match, &by_line_company).filter(|_| opts.duplicates == Duplicates::Link) {
                    Some(id) => {
                        linked += 1;
                        company_id = Some(id);
                    }
                    None => {
                        let mut c = p.row.company.clone();
                        c.insert("source".into(), json!(source));
                        if let Some(o) = &opts.owner_id {
                            c.insert("owner_id".into(), json!(o));
                        }
                        let id = store.save("companies", None, &c)?["id"].as_str().unwrap_or_default().to_string();
                        created.push(("companies".into(), id.clone()));
                        companies += 1;
                        company_id = Some(id);
                    }
                }
                if let Some(id) = &company_id {
                    by_line_company.insert(line, id.clone());
                }
            }
            let mut contact_id = None;
            if !p.row.contact.is_empty() {
                match resolve(&p.contact_match, &by_line_contact).filter(|_| opts.duplicates == Duplicates::Link) {
                    Some(id) => contact_id = Some(id),
                    None => {
                        let mut c = p.row.contact.clone();
                        c.insert("source".into(), json!(source));
                        if let Some(id) = &company_id {
                            c.insert("company_id".into(), json!(id));
                        }
                        if let Some(o) = &opts.owner_id {
                            c.insert("owner_id".into(), json!(o));
                        }
                        let id = store.save("contacts", None, &c)?["id"].as_str().unwrap_or_default().to_string();
                        created.push(("contacts".into(), id.clone()));
                        contacts += 1;
                        contact_id = Some(id);
                    }
                }
                if let Some(id) = &contact_id {
                    by_line_contact.insert(line, id.clone());
                }
            }
            if let (false, Some((pid, first))) = (p.row.deal.is_empty(), &pipeline) {
                let mut d = p.row.deal.clone();
                let stage = match &p.row.stage {
                    Some(name) => stage_by_name(store, pid, name).unwrap_or_else(|| {
                        if !stage_misses.contains(name) {
                            stage_misses.push(name.clone());
                        }
                        first.clone()
                    }),
                    None => first.clone(),
                };
                d.insert("pipeline_id".into(), json!(pid));
                d.insert("stage_id".into(), json!(stage));
                if let Some(id) = &company_id {
                    d.insert("company_id".into(), json!(id));
                }
                if let Some(o) = &opts.owner_id {
                    d.insert("owner_id".into(), json!(o));
                }
                let did = store.save("deals", None, &d)?["id"].as_str().unwrap_or_default().to_string();
                created.push(("deals".into(), did.clone()));
                deals += 1;
                if let Some(cid) = &contact_id {
                    let link_id = super::store::deal_contact_id(&did, cid);
                    let mut link = Map::new();
                    link.insert("deal_id".into(), json!(did));
                    link.insert("contact_id".into(), json!(cid));
                    store.save("deal_contacts", Some(&link_id), &link)?;
                    created.push(("deal_contacts".into(), link_id));
                }
            }
            if !p.row.note.trim().is_empty() {
                let (t, id) = match (&company_id, &contact_id) {
                    (Some(c), _) => ("company", c),
                    (None, Some(c)) => ("contact", c),
                    _ => return Ok(()),
                };
                let mut n = Map::new();
                n.insert("body".into(), json!(p.row.note.chars().take(20000).collect::<String>()));
                n.insert("entity_type".into(), json!(t));
                n.insert("entity_id".into(), json!(id));
                let nid = store.save("notes", None, &n)?["id"].as_str().unwrap_or_default().to_string();
                created.push(("notes".into(), nid));
                notes += 1;
            }
            Ok(())
        };
        if let Err(e) = step() {
            errors.push(json!({"line": line, "message": e.to_string()}));
        }
    }

    let summary = json!({
        "companies": companies, "contacts": contacts, "deals": deals, "notes": notes, "linked": linked,
        "skipped": skipped, "errors": errors.len(), "unknownStages": stage_misses,
    });
    if !created.is_empty() {
        store.conn().execute(
            "INSERT INTO import_batches(id, file, created_at, created, summary) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![batch, file_name.chars().take(200).collect::<String>(), stamp(Utc::now()), json!(created).to_string(), summary.to_string()],
        )?;
    }
    let mut out = summary;
    out["batchId"] = if created.is_empty() { Value::Null } else { json!(batch) };
    out["errorRows"] = json!(errors.into_iter().take(200).collect::<Vec<_>>());
    Ok(out)
}

/// Последние импорты этого Workspace (для «Отменить импорт»).
pub fn history(store: &WorkspaceStore) -> AppResult<Value> {
    ensure_table(store)?;
    let mut st = store.conn().prepare("SELECT id, file, created_at, summary, undone_at FROM import_batches ORDER BY created_at DESC LIMIT 20")?;
    let rows = st.query_map([], |r| {
        let summary: String = r.get(3)?;
        Ok(json!({"id": r.get::<_, String>(0)?, "file": r.get::<_, String>(1)?, "createdAt": r.get::<_, String>(2)?,
                  "summary": serde_json::from_str::<Value>(&summary).unwrap_or(Value::Null), "undoneAt": r.get::<_, Option<String>>(4)?}))
    })?;
    Ok(Value::Array(rows.collect::<Result<_, _>>()?))
}

/// Отмена импорта: созданные им записи удаляются (связи и сделки первыми). Записи, уже удалённые вручную,
/// пропускаются; повторная отмена ничего не делает.
pub fn undo(store: &WorkspaceStore, batch: &str) -> AppResult<Value> {
    ensure_table(store)?;
    let row: Option<(String, Option<String>)> =
        store.conn().query_row("SELECT created, undone_at FROM import_batches WHERE id=?1", [batch], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let (created, undone) = row.ok_or_else(|| err("Импорт не найден."))?;
    if undone.is_some() {
        return Ok(json!({"removed": 0, "alreadyUndone": true}));
    }
    let created: Vec<(String, String)> = serde_json::from_str(&created)?;
    let order = ["notes", "deal_contacts", "deals", "contacts", "companies"];
    let mut removed = 0;
    let mut failed: Vec<String> = Vec::new();
    for table in order {
        for (_, id) in created.iter().filter(|(t, _)| t == table) {
            match store.get(table, id)? {
                Some(r) if r["deleted_at"].is_null() => match store.delete(table, id) {
                    Ok(_) => removed += 1,
                    Err(e) => failed.push(e.to_string()),
                },
                _ => {}
            }
        }
    }
    if failed.is_empty() {
        store.conn().execute("UPDATE import_batches SET undone_at=?2 WHERE id=?1", params![batch, stamp(Utc::now())])?;
    }
    Ok(json!({"removed": removed, "failed": failed.len(), "message": failed.first()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WS: &str = "11111111-1111-4111-8111-111111111111";
    const ME: &str = "22222222-2222-4222-8222-222222222222";

    fn open() -> (tempfile::TempDir, WorkspaceStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = WorkspaceStore::open(&dir.path().join("ws.db"), None, WS, ME).unwrap();
        s.seed_local().unwrap();
        (dir, s)
    }

    fn opts(mapping: &[Option<&str>], duplicates: Duplicates) -> ImportOptions {
        ImportOptions { mapping: mapping.iter().map(|m| m.map(String::from)).collect(), duplicates, ..Default::default() }
    }

    fn live(s: &WorkspaceStore, table: &str) -> i64 {
        s.conn().query_row(&format!("SELECT count(*) FROM {table} WHERE deleted_at IS NULL"), [], |r| r.get(0)).unwrap()
    }

    /// Минимальный .xlsx (ZIP без сжатия) из листа и общих строк.
    fn xlsx(sheet: &str, shared: &str) -> Vec<u8> {
        let files = [
            ("xl/workbook.xml", r#"<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Клиенты" sheetId="1" r:id="rId1"/></sheets></workbook>"#.to_string()),
            ("xl/_rels/workbook.xml.rels", r#"<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_string()),
            ("xl/sharedStrings.xml", shared.to_string()),
            ("xl/worksheets/sheet1.xml", sheet.to_string()),
        ];
        let (mut out, mut central) = (Vec::new(), Vec::new());
        for (name, body) in &files {
            let off = out.len() as u32;
            let (n, b) = (name.as_bytes(), body.as_bytes());
            out.extend_from_slice(b"PK\x03\x04");
            out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            out.extend_from_slice(&(b.len() as u32).to_le_bytes());
            out.extend_from_slice(&(b.len() as u32).to_le_bytes());
            out.extend_from_slice(&(n.len() as u16).to_le_bytes());
            out.extend_from_slice(&[0, 0]);
            out.extend_from_slice(n);
            out.extend_from_slice(b);
            central.extend_from_slice(b"PK\x01\x02");
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend_from_slice(&(b.len() as u32).to_le_bytes());
            central.extend_from_slice(&(b.len() as u32).to_le_bytes());
            central.extend_from_slice(&(n.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]);
            central.extend_from_slice(&off.to_le_bytes());
            central.extend_from_slice(n);
        }
        let cd_off = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_off.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    #[test]
    fn csv_detects_delimiter_quotes_and_encodings() {
        let t = parse("a.csv", "Компания;Телефон;Заметка\r\n\"ООО \"\"Ромашка\"\"\";8 999 123-45-67;\"две\nстроки\"\n;;\n".as_bytes()).unwrap();
        assert_eq!(t.headers, ["Компания", "Телефон", "Заметка"]);
        assert_eq!(t.rows, vec![vec!["ООО \"Ромашка\"".to_string(), "8 999 123-45-67".into(), "две\nстроки".into()]]);
        let comma = parse("b.csv", b"name,email\nAcme,a@acme.com\n").unwrap();
        assert_eq!(comma.rows[0], ["Acme", "a@acme.com"]);
        let (cp1251, _, _) = encoding_rs::WINDOWS_1251.encode("Компания;Город\nЗерно;Казань\n");
        assert_eq!(parse("c.csv", &cp1251).unwrap().rows[0], ["Зерно", "Казань"]);
        let bom = [b"\xEF\xBB\xBF".as_slice(), "Имя\nАнна\n".as_bytes()].concat();
        assert_eq!(parse("d.csv", &bom).unwrap().headers, ["Имя"]);
        assert!(parse("e.xls", b"\xD0\xCF\x11\xE0").unwrap_err().to_string().contains(".xlsx"));
        assert!(parse("f.csv", b"\n\n").is_err());
    }

    #[test]
    fn xlsx_first_sheet_with_shared_strings_numbers_and_gaps() {
        let shared = r#"<sst><si><t>Компания</t></si><si><t>Телефон</t></si><si><r><t>Кофейня </t></r><r><t>&quot;Зерно&quot;</t></r></si></sst>"#;
        let sheet = r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>79991234567</v></c></row></sheetData></worksheet>"#;
        let t = parse("clients.xlsx", &xlsx(sheet, shared)).unwrap();
        assert_eq!(t.headers, ["Компания", "Колонка 2", "Телефон"]);
        assert_eq!(t.rows, vec![vec!["Кофейня \"Зерно\"".to_string(), String::new(), "79991234567".into()]]);
        assert!(parse("broken.xlsx", b"PK\x03\x04garbage").is_err());
    }

    #[test]
    fn suggest_maps_common_headers_once() {
        let h: Vec<String> =
            ["Название компании", "ФИО", "Телефон", "E-mail", "Сумма сделки", "Комментарий", "Что-то ещё", "Компания 2"].map(String::from).to_vec();
        let m = suggest(&h);
        assert_eq!(m[0].as_deref(), Some("company.name"));
        assert_eq!(m[1].as_deref(), Some("contact.full_name"));
        assert_eq!(m[2].as_deref(), Some("contact.phone"));
        assert_eq!(m[3].as_deref(), Some("contact.email"));
        assert_eq!(m[4].as_deref(), Some("deal.amount"));
        assert_eq!(m[5].as_deref(), Some("note"));
        assert_eq!(m[6], None);
        assert_eq!(m[7], None, "одно поле — одна колонка");
    }

    fn sample() -> Table {
        let t = "Компания;Контакт;Телефон;Почта;Сделка;Сумма;Этап;Заметка\n\
                 ООО Ромашка;Иван Петров;8 999 111-22-33;ivan@romashka.ru;Сайт;120 000;Переговоры;VIP\n\
                 Ромашка;Анна Смирнова;;anna@romashka.ru;;;;\n\
                 Зерно;;;не почта;;сто;;\n\
                 ;;;;Сделка без клиента;;;\n\
                 ;;;;;;;\n";
        parse("clients.csv", t.as_bytes()).unwrap()
    }

    const MAP: [Option<&str>; 8] = [
        Some("company.name"),
        Some("contact.full_name"),
        Some("contact.phone"),
        Some("contact.email"),
        Some("deal.title"),
        Some("deal.amount"),
        Some("deal.stage"),
        Some("note"),
    ];

    #[test]
    fn preview_finds_duplicates_in_file_and_base_and_reports_problems() {
        let (_d, s) = open();
        let p = preview(&s, &sample(), &opts(&MAP, Duplicates::Link)).unwrap();
        assert_eq!(p["rows"], 4);
        assert_eq!(p["new"], 2, "Ромашка (строка 2) и Зерно");
        assert_eq!(p["existing"], 1, "«Ромашка» в строке 3 — та же компания без ООО");
        assert_eq!(p["errors"], 1, "сделка без компании и контакта");
        let items = p["items"].as_array().unwrap();
        assert_eq!(items[0]["status"], "error");
        let zerno = items.iter().find(|i| i["company"] == "Зерно").unwrap();
        assert_eq!(zerno["messages"].as_array().unwrap().len(), 2, "плохая почта и сумма — предупреждения");

        s.save("companies", None, &json!({"name": "Зерно"}).as_object().unwrap().clone()).unwrap();
        let skip = preview(&s, &sample(), &opts(&MAP, Duplicates::Skip)).unwrap();
        assert_eq!(skip["skipped"], 2);
        let create = preview(&s, &sample(), &opts(&MAP, Duplicates::Create)).unwrap();
        assert_eq!(create["new"], 3);
        assert!(preview(&s, &sample(), &opts(&[None; 8], Duplicates::Link)).is_err(), "ничего не сопоставлено");
    }

    #[test]
    fn run_links_records_and_undo_removes_exactly_the_batch() {
        let (_d, s) = open();
        let existing = s.save("companies", None, &json!({"name": "Зерно", "industry": "Кофе"}).as_object().unwrap().clone()).unwrap();
        let r = run(&s, "clients.csv", &sample(), &opts(&MAP, Duplicates::Link)).unwrap();
        assert_eq!(r["companies"], 1, "Ромашка создана один раз, Зерно найдено");
        assert_eq!(r["linked"], 2);
        assert_eq!(r["contacts"], 2);
        assert_eq!(r["deals"], 1);
        assert_eq!(r["notes"], 1);
        assert_eq!(r["errors"], 1);
        assert_eq!(r["errorRows"][0]["line"], 5);

        let romashka: String = s.conn().query_row("SELECT id FROM companies WHERE name='ООО Ромашка'", [], |x| x.get(0)).unwrap();
        let anna_company: String = s.conn().query_row("SELECT company_id FROM contacts WHERE first_name='Анна'", [], |x| x.get(0)).unwrap();
        assert_eq!(anna_company, romashka, "контакт из строки 3 привязан к компании из строки 2");
        let (stage, amount): (String, f64) = s
            .conn()
            .query_row("SELECT s.name, d.amount FROM deals d JOIN pipeline_stages s ON s.id=d.stage_id", [], |x| Ok((x.get(0)?, x.get(1)?)))
            .unwrap_or(("".into(), 0.0));
        assert_eq!(amount, 120000.0);
        let known = !stage.is_empty();
        assert!(known);
        assert_eq!(live(&s, "deal_contacts"), 1);

        let hist = history(&s).unwrap();
        let batch = hist[0]["id"].as_str().unwrap().to_string();
        assert_eq!(hist[0]["file"], "clients.csv");
        let u = undo(&s, &batch).unwrap();
        assert_eq!(u["removed"], 6, "компания, 2 контакта, сделка, связь, заметка");
        assert_eq!(live(&s, "companies"), 1, "найденная компания «Зерно» не тронута");
        assert_eq!(s.get("companies", existing["id"].as_str().unwrap()).unwrap().unwrap()["industry"], "Кофе");
        assert_eq!(live(&s, "contacts") + live(&s, "deals") + live(&s, "notes") + live(&s, "deal_contacts"), 0);
        assert_eq!(undo(&s, &batch).unwrap()["alreadyUndone"], true);
        assert!(history(&s).unwrap()[0]["undoneAt"].is_string());
    }

    #[test]
    fn unknown_stage_falls_back_to_first_and_is_reported() {
        let (_d, s) = open();
        let t = parse("d.csv", "Компания;Сделка;Этап\nАльфа;Внедрение;Марсианский этап\n".as_bytes()).unwrap();
        let r = run(&s, "d.csv", &t, &opts(&[Some("company.name"), Some("deal.title"), Some("deal.stage")], Duplicates::Link)).unwrap();
        assert_eq!(r["deals"], 1);
        assert_eq!(r["unknownStages"], json!(["Марсианский этап"]));
    }

    #[test]
    fn amounts_and_contacts_without_names() {
        assert_eq!(amount("1 250 000,50 ₽"), Some(1250000.5));
        assert_eq!(amount("1,250,000.50"), Some(1250000.5));
        assert_eq!(amount("сто"), None);
        let (_d, s) = open();
        let alone = parse("p.csv", "Телефон\n+7 999 000-11-22\n".as_bytes()).unwrap();
        let r = run(&s, "p.csv", &alone, &opts(&[Some("contact.phone")], Duplicates::Link)).unwrap();
        assert_eq!((r["contacts"].as_i64(), r["errors"].as_i64()), (Some(0), Some(1)), "{r}");
        let t = parse("p.csv", "Компания;Телефон;Почта\nАльфа;+7 999 000-11-22;info@alfa.ru\n".as_bytes()).unwrap();
        let map = [Some("company.name"), Some("contact.phone"), Some("contact.email")];
        let r = run(&s, "p.csv", &t, &opts(&map, Duplicates::Link)).unwrap();
        assert_eq!((r["companies"].as_i64(), r["contacts"].as_i64()), (Some(1), Some(0)), "{r}");
        let c: String = s.conn().query_row("SELECT phones || emails FROM companies WHERE name='Альфа'", [], |x| x.get(0)).unwrap();
        assert!(c.contains("+7 999 000-11-22") && c.contains("info@alfa.ru"), "{c}");
        let again = preview(&s, &t, &opts(&map, Duplicates::Link)).unwrap();
        assert_eq!(again["existing"], 1, "компания найдена по телефону");
    }
}
