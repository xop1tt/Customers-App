//! Экспорт записей CRM в CSV и Excel (пакет G1, docs/EXPORT.md): компании, контакты, сделки, задачи и лиды CRM
//! с выбором колонок и своими полями.
//!
//! Выгружается то же, что показывает список: фильтры коллекции и строка поиска, без удалённых записей.
//! Ссылки заменяются названиями (компания, этап, ответственный), перечисления — подписями. Заголовки колонок
//! подобраны так, чтобы мастер импорта (`import.rs`) сам сопоставил их с полями CRM.
//!
//! CSV: UTF-8 с BOM, разделитель `;`, CRLF, значения-формулы обезврежены (`csvfmt::escape`). XLSX: один лист,
//! строки записаны как текст (формулой стать не могут), числа и даты — настоящими числами и датами.

use super::query::{Filter, Query, Sort, MAX_LIMIT};
use super::schema;
use super::store::WorkspaceStore;
use crate::error::{AppError, AppResult};
use crate::tray_text::Lang;
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Write;

/// Больше записей за один раз не выгружается: файл перестаёт открываться в табличных редакторах.
pub const MAX_ROWS: i64 = 100_000;

fn err(m: impl Into<String>) -> AppError {
    AppError::msg(m.into())
}

// ------------------------------------------------------------------ колонки

#[derive(Debug, Clone, Copy, PartialEq)]
enum Src {
    Text(&'static str),
    /// Массив строк одной ячейкой через запятую.
    List(&'static str),
    Num(&'static str),
    Date(&'static str),
    Time(&'static str),
    Member(&'static str),
    Enum(&'static str),
    /// Название записи другой таблицы по ссылке: столбец, таблица.
    Name(&'static str, &'static str),
    /// Первый контакт сделки.
    DealContact,
    /// Запись, к которой привязана задача.
    Related,
}

struct Col {
    key: &'static str,
    ru: &'static str,
    en: &'static str,
    src: Src,
    default: bool,
}

const fn col(key: &'static str, ru: &'static str, en: &'static str, src: Src, default: bool) -> Col {
    Col { key, ru, en, src, default }
}

const OWNER: Col = col("owner_id", "Ответственный", "Owner", Src::Member("owner_id"), true);
const CREATED: Col = col("created_at", "Создано", "Created", Src::Time("created_at"), false);
const UPDATED: Col = col("updated_at", "Изменено", "Updated", Src::Time("updated_at"), false);
const SOURCE: Col = col("source", "Источник", "Source", Src::Text("source"), false);

const COMPANIES: &[Col] = &[
    col("name", "Компания", "Company", Src::Text("name"), true),
    col("legal_name", "Юридическое название", "Legal entity", Src::Text("legal_name"), false),
    col("inn", "ИНН", "Tax ID", Src::Text("inn"), true),
    col("website", "Сайт", "Website", Src::Text("website"), true),
    col("domain", "Домен", "Domain", Src::Text("domain"), false),
    col("phones", "Телефон компании", "Company phone", Src::List("phones"), true),
    col("emails", "Почта компании", "Company email", Src::List("emails"), true),
    col("address", "Адрес", "Address", Src::Text("address"), true),
    col("industry", "Отрасль", "Industry", Src::Text("industry"), true),
    col("size_range", "Размер", "Size", Src::Text("size_range"), false),
    SOURCE,
    OWNER,
    CREATED,
    UPDATED,
];

const CONTACTS: &[Col] = &[
    col("full_name", "Контакт", "Contact", Src::Text("full_name"), true),
    col("first_name", "Имя", "First name", Src::Text("first_name"), false),
    col("last_name", "Фамилия", "Last name", Src::Text("last_name"), false),
    col("position", "Должность", "Position", Src::Text("position"), true),
    col("company_id", "Компания", "Company", Src::Name("company_id", "companies"), true),
    col("phones", "Телефон", "Phone", Src::List("phones"), true),
    col("emails", "Почта", "Email", Src::List("emails"), true),
    SOURCE,
    OWNER,
    CREATED,
    UPDATED,
];

const DEALS: &[Col] = &[
    col("title", "Сделка", "Deal", Src::Text("title"), true),
    col("pipeline_id", "Воронка", "Pipeline", Src::Name("pipeline_id", "pipelines"), false),
    col("stage_id", "Этап", "Stage", Src::Name("stage_id", "pipeline_stages"), true),
    col("status", "Статус", "Status", Src::Enum("status"), true),
    col("amount", "Сумма", "Amount", Src::Num("amount"), true),
    col("currency", "Валюта", "Currency", Src::Text("currency"), true),
    col("expected_close_date", "Ожидаемое закрытие", "Expected close", Src::Date("expected_close_date"), true),
    col("company_id", "Компания", "Company", Src::Name("company_id", "companies"), true),
    col("contact", "Контакт", "Contact", Src::DealContact, true),
    col("lost_reason", "Причина проигрыша", "Lost reason", Src::Text("lost_reason"), false),
    col("closed_at", "Закрыта", "Closed", Src::Time("closed_at"), false),
    OWNER,
    CREATED,
    UPDATED,
];

const TASKS: &[Col] = &[
    col("title", "Задача", "Task", Src::Text("title"), true),
    col("description", "Описание", "Description", Src::Text("description"), false),
    col("status", "Статус", "Status", Src::Enum("status"), true),
    col("priority", "Приоритет", "Priority", Src::Enum("priority"), true),
    col("due_at", "Срок", "Due", Src::Time("due_at"), true),
    col("remind_at", "Напомнить", "Reminder", Src::Time("remind_at"), false),
    col("assignee_id", "Исполнитель", "Assignee", Src::Member("assignee_id"), true),
    col("related", "Связано с", "Related to", Src::Related, true),
    col("completed_at", "Выполнена", "Completed", Src::Time("completed_at"), false),
    CREATED,
    UPDATED,
];

const CRM_LEADS: &[Col] = &[
    col("title", "Лид", "Lead", Src::Text("title"), true),
    col("person_name", "Контакт", "Contact", Src::Text("person_name"), true),
    col("company_name", "Компания", "Company", Src::Text("company_name"), true),
    col("phones", "Телефон", "Phone", Src::List("phones"), true),
    col("emails", "Почта", "Email", Src::List("emails"), true),
    col("status", "Статус", "Status", Src::Enum("status"), true),
    SOURCE,
    OWNER,
    CREATED,
    UPDATED,
];

/// Таблицы, которые можно выгрузить: колонки и название листа.
fn spec(table: &str) -> Option<(&'static [Col], &'static str, &'static str)> {
    Some(match table {
        "companies" => (COMPANIES, "Компании", "Companies"),
        "contacts" => (CONTACTS, "Контакты", "Contacts"),
        "deals" => (DEALS, "Сделки", "Deals"),
        "tasks" => (TASKS, "Задачи", "Tasks"),
        "crm_leads" => (CRM_LEADS, "Лиды", "Leads"),
        _ => return None,
    })
}

fn enum_label(table: &str, field: &str, value: &str, lang: Lang) -> String {
    let (ru, en) = match (table, field, value) {
        ("deals", "status", "open") => ("Открыта", "Open"),
        ("deals", "status", "won") => ("Успешна", "Won"),
        ("deals", "status", "lost") => ("Потеряна", "Lost"),
        ("tasks", "status", "todo") => ("К выполнению", "To do"),
        ("tasks", "status", "in_progress") | ("crm_leads", "status", "in_progress") => ("В работе", "In progress"),
        ("tasks", "status", "done") => ("Готово", "Done"),
        ("tasks", "status", "cancelled") => ("Отменена", "Cancelled"),
        ("tasks", "priority", "low") => ("Низкий", "Low"),
        ("tasks", "priority", "normal") => ("Обычный", "Normal"),
        ("tasks", "priority", "high") => ("Высокий", "High"),
        ("tasks", "priority", "urgent") => ("Срочный", "Urgent"),
        ("crm_leads", "status", "new") => ("Новый", "New"),
        ("crm_leads", "status", "qualified") => ("Квалифицирован", "Qualified"),
        ("crm_leads", "status", "disqualified") => ("Отклонён", "Disqualified"),
        ("crm_leads", "status", "converted") => ("Переведён", "Converted"),
        _ => return value.to_string(),
    };
    pick(lang, ru, en).to_string()
}

fn pick<'a>(lang: Lang, ru: &'a str, en: &'a str) -> &'a str {
    match lang {
        Lang::Ru => ru,
        Lang::En => en,
    }
}

/// Ключ колонки своего поля: `cf:<id определения>`.
const CUSTOM: &str = "cf:";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FieldInfo {
    pub key: String,
    pub title: String,
    pub default: bool,
    /// Своё поле Workspace (в интерфейсе показывается отдельной группой).
    pub custom: bool,
}

fn custom_defs(store: &WorkspaceStore, table: &str) -> AppResult<Vec<Value>> {
    let Some(t) = schema::entity(table).and_then(|e| e.entity_type) else { return Ok(vec![]) };
    let q = Query {
        filters: vec![Filter::eq("entity_type", t)],
        sort: vec![Sort { field: "position".into(), dir: "asc".into() }],
        limit: Some(MAX_LIMIT),
        ..Default::default()
    };
    store.list("custom_fields", &q)
}

/// Колонки, доступные для выгрузки: поля записи и свои поля Workspace.
pub fn fields(store: &WorkspaceStore, table: &str, lang: Lang) -> AppResult<Vec<FieldInfo>> {
    let (cols, _, _) = spec(table).ok_or_else(|| err("Эти записи не выгружаются."))?;
    let mut out: Vec<FieldInfo> =
        cols.iter().map(|c| FieldInfo { key: c.key.into(), title: pick(lang, c.ru, c.en).into(), default: c.default, custom: false }).collect();
    for d in custom_defs(store, table)? {
        let (Some(id), Some(label)) = (d["id"].as_str(), d["label"].as_str()) else { continue };
        out.push(FieldInfo { key: format!("{CUSTOM}{id}"), title: label.to_string(), default: true, custom: true });
    }
    Ok(out)
}

// ------------------------------------------------------------------ таблица значений

#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Empty,
    Text(String),
    Num(f64),
    Date(NaiveDate),
    Time(NaiveDateTime),
}

impl Cell {
    fn text(s: &str) -> Cell {
        if s.is_empty() {
            Cell::Empty
        } else {
            Cell::Text(s.to_string())
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sheet {
    pub name: String,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
    lang: Lang,
}

/// Момент времени из базы (RFC 3339, UTC) во времени пользователя, с точностью до минуты.
fn to_naive<Tz: TimeZone>(v: &str, tz: &Tz) -> Option<NaiveDateTime> {
    let t = DateTime::parse_from_rfc3339(v).ok()?.with_timezone(tz).naive_local();
    t.with_second(0).and_then(|t| t.with_nanosecond(0))
}

fn date(v: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(v.get(..10)?, "%Y-%m-%d").ok()
}

fn list_text(v: &Value) -> String {
    match v {
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(str::trim).filter(|s| !s.is_empty())).collect::<Vec<_>>().join(", "),
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

fn custom_cell(kind: &str, v: &Value, lang: Lang) -> Cell {
    match v {
        Value::Null => Cell::Empty,
        Value::Bool(b) => Cell::Text(if *b { pick(lang, "да", "yes") } else { pick(lang, "нет", "no") }.into()),
        Value::Number(n) => n.as_f64().map(Cell::Num).unwrap_or(Cell::Empty),
        Value::String(s) if kind == "date" => date(s).map(Cell::Date).unwrap_or_else(|| Cell::text(s)),
        Value::String(s) => Cell::text(s),
        Value::Array(_) => Cell::text(&list_text(v)),
        other => Cell::Text(other.to_string()),
    }
}

/// Справочники для замены ссылок названиями. Загружаются только те, что нужны выбранным колонкам.
#[derive(Default)]
struct Lookups {
    members: HashMap<String, String>,
    names: HashMap<&'static str, HashMap<String, String>>,
    deal_contact: HashMap<String, String>,
    custom: HashMap<(String, String), Value>,
}

/// Таблицы, на которые ссылаются колонки, и столбец с названием записи.
const NAME_TABLES: [(&str, &str); 6] =
    [("companies", "name"), ("contacts", "full_name"), ("deals", "title"), ("crm_leads", "title"), ("pipelines", "name"), ("pipeline_stages", "name")];

impl Lookups {
    fn load_names(&mut self, store: &WorkspaceStore, table: &'static str) -> AppResult<()> {
        if self.names.contains_key(table) {
            return Ok(());
        }
        let Some((_, title)) = NAME_TABLES.iter().find(|(t, _)| *t == table) else { return Ok(()) };
        let mut st = store.conn().prepare(&format!("SELECT id, {title} FROM {table}"))?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default())))?;
        self.names.insert(table, rows.collect::<Result<_, _>>()?);
        Ok(())
    }

    fn name(&self, table: &str, id: &str) -> String {
        self.names.get(table).and_then(|m| m.get(id)).cloned().unwrap_or_default()
    }
}

/// Строки для выгрузки: запрос списка без ограничения числа записей, без удалённых.
fn all_rows(store: &WorkspaceStore, table: &str, query: &Query) -> AppResult<Vec<Value>> {
    let mut q = Query { deleted: false, limit: Some(MAX_LIMIT), offset: Some(0), ..query.clone() };
    if store.count(table, &q)? > MAX_ROWS {
        return Err(err(format!("Записей больше {MAX_ROWS}. Сузьте выборку фильтром или поиском.")));
    }
    let mut out = Vec::new();
    loop {
        let page = store.list(table, &q)?;
        let n = page.len();
        out.extend(page);
        if n < MAX_LIMIT as usize {
            return Ok(out);
        }
        q.offset = Some(out.len() as u32);
    }
}

/// Таблица для файла: выбранные колонки в порядке описания сущности, свои поля — после них.
pub fn build(store: &WorkspaceStore, table: &str, query: &Query, keys: &[String], lang: Lang) -> AppResult<Sheet> {
    build_in(store, table, query, keys, lang, &Local)
}

fn build_in<Tz: TimeZone>(store: &WorkspaceStore, table: &str, query: &Query, keys: &[String], lang: Lang, tz: &Tz) -> AppResult<Sheet> {
    if !store.can("records.export") {
        return Err(err("Недостаточно прав для экспорта записей."));
    }
    let (cols, ru, en) = spec(table).ok_or_else(|| err("Эти записи не выгружаются."))?;
    let entity_type = schema::entity(table).and_then(|e| e.entity_type).unwrap_or_default();
    let defs = custom_defs(store, table)?;
    for k in keys {
        let known = cols.iter().any(|c| c.key == k) || k.strip_prefix(CUSTOM).is_some_and(|id| defs.iter().any(|d| d["id"] == id));
        if !known {
            return Err(err(format!("Неизвестная колонка: {k}")));
        }
    }
    let chosen: Vec<&Col> = cols.iter().filter(|c| keys.iter().any(|k| k == c.key)).collect();
    let custom: Vec<&Value> = defs.iter().filter(|d| d["id"].as_str().is_some_and(|id| keys.iter().any(|k| k.strip_prefix(CUSTOM) == Some(id)))).collect();
    if chosen.is_empty() && custom.is_empty() {
        return Err(err("Выберите хотя бы одну колонку."));
    }

    let mut lk = Lookups::default();
    for c in &chosen {
        match c.src {
            Src::Member(_) => lk.members = store.members()?.into_iter().map(|m| (m.user_id, m.display_name)).collect(),
            Src::Name(_, t) => lk.load_names(store, t)?,
            Src::DealContact => {
                lk.load_names(store, "contacts")?;
                let mut st =
                    store.conn().prepare("SELECT deal_id, contact_id FROM deal_contacts WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC")?;
                // Строки идут от новых к старым: в словаре остаётся первый добавленный контакт сделки.
                lk.deal_contact = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<Result<_, _>>()?;
            }
            Src::Related => {
                for t in ["companies", "contacts", "deals", "crm_leads"] {
                    lk.load_names(store, t)?;
                }
            }
            _ => {}
        }
    }
    if !custom.is_empty() {
        let mut st = store.conn().prepare("SELECT entity_id, field_id, value FROM custom_field_values WHERE entity_type = ?1 AND deleted_at IS NULL")?;
        let rows = st.query_map([entity_type], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))?;
        for row in rows {
            let (entity, field, value) = row?;
            lk.custom.insert((entity, field), value.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or(Value::Null));
        }
    }

    let str_of = |r: &Value, f: &str| r[f].as_str().unwrap_or_default().to_string();
    let cell = |r: &Value, c: &Col| -> Cell {
        match c.src {
            Src::Text(f) => Cell::text(r[f].as_str().unwrap_or_default().trim()),
            Src::List(f) => Cell::text(&list_text(&r[f])),
            Src::Num(f) => r[f].as_f64().map(Cell::Num).unwrap_or(Cell::Empty),
            Src::Date(f) => r[f].as_str().and_then(date).map(Cell::Date).unwrap_or(Cell::Empty),
            Src::Time(f) => r[f].as_str().and_then(|v| to_naive(v, tz)).map(Cell::Time).unwrap_or(Cell::Empty),
            Src::Member(f) => match r[f].as_str() {
                Some(id) => Cell::Text(lk.members.get(id).cloned().unwrap_or_else(|| pick(lang, "Участник", "Member").to_string())),
                None => Cell::Empty,
            },
            Src::Enum(f) => r[f].as_str().map(|v| Cell::text(&enum_label(table, f, v, lang))).unwrap_or(Cell::Empty),
            Src::Name(f, t) => Cell::text(&lk.name(t, &str_of(r, f))),
            Src::DealContact => Cell::text(&lk.deal_contact.get(&str_of(r, "id")).map(|c| lk.name("contacts", c)).unwrap_or_default()),
            Src::Related => {
                let t = r["entity_type"].as_str().and_then(schema::by_type).map(|e| e.table).unwrap_or_default();
                Cell::text(&lk.name(t, &str_of(r, "entity_id")))
            }
        }
    };

    let mut headers: Vec<String> = chosen.iter().map(|c| pick(lang, c.ru, c.en).to_string()).collect();
    headers.extend(custom.iter().map(|d| d["label"].as_str().unwrap_or_default().to_string()));
    let rows = all_rows(store, table, query)?
        .iter()
        .map(|r| {
            let id = str_of(r, "id");
            let mut row: Vec<Cell> = chosen.iter().map(|c| cell(r, c)).collect();
            for d in &custom {
                let key = (id.clone(), d["id"].as_str().unwrap_or_default().to_string());
                row.push(lk.custom.get(&key).map(|v| custom_cell(d["kind"].as_str().unwrap_or("text"), v, lang)).unwrap_or(Cell::Empty));
            }
            row
        })
        .collect();
    Ok(Sheet { name: pick(lang, ru, en).to_string(), headers, rows, lang })
}

// ------------------------------------------------------------------ CSV

fn number_text(n: f64, lang: Lang) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        return format!("{}", n as i64);
    }
    // Дробная часть: в русской локали табличные редакторы ждут запятую.
    let s = format!("{n}");
    match lang {
        Lang::Ru => s.replace('.', ","),
        Lang::En => s,
    }
}

fn cell_text(c: &Cell, lang: Lang) -> String {
    match c {
        Cell::Empty => String::new(),
        Cell::Text(s) => s.clone(),
        Cell::Num(n) => number_text(*n, lang),
        Cell::Date(d) => d.format("%d.%m.%Y").to_string(),
        Cell::Time(t) => t.format("%d.%m.%Y %H:%M").to_string(),
    }
}

/// Текстовая ячейка CSV. Несколько телефонов через запятую («+7 …, 8 …») формулой быть не могут — в них нет
/// ни букв, ни знака равенства, — поэтому апостроф им не добавляется; остальное идёт через `csvfmt::escape`.
fn csv_text(s: &str) -> String {
    let phones = s.contains(',') && s.chars().all(|c| "0123456789+-() ,".contains(c)) && s.chars().any(|c| c.is_ascii_digit());
    if phones {
        return format!("\"{s}\"");
    }
    crate::csvfmt::escape(s)
}

/// CSV для Excel и Google Таблиц: BOM, `;`, CRLF.
pub fn to_csv(sheet: &Sheet) -> Vec<u8> {
    let mut text = sheet.headers.iter().map(|h| crate::csvfmt::escape(h)).collect::<Vec<_>>().join(";");
    text.push_str("\r\n");
    for row in &sheet.rows {
        // Числа и даты формулой быть не могут, а отрицательная сумма не должна получить апостроф.
        let line: Vec<String> = row.iter().map(|c| if let Cell::Text(s) = c { csv_text(s) } else { cell_text(c, sheet.lang) }).collect();
        text.push_str(&line.join(";"));
        text.push_str("\r\n");
    }
    let mut out = vec![0xEF, 0xBB, 0xBF];
    out.extend(text.into_bytes());
    out
}

// ------------------------------------------------------------------ XLSX: XML листа + ZIP

fn xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // Управляющие символы в XML 1.0 запрещены: файл с ними Excel не открывает.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            '\u{FFFE}' | '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
    out
}

/// «A», «B», … «Z», «AA» по номеру колонки с нуля.
fn column_name(mut i: usize) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b'A' + (i % 26) as u8);
        if i < 26 {
            break;
        }
        i = i / 26 - 1;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

/// Дата и время как число Excel: дни от 30.12.1899 и доля суток.
fn serial(t: &NaiveDateTime) -> f64 {
    let base = NaiveDate::from_ymd_opt(1899, 12, 30).unwrap_or_default().and_hms_opt(0, 0, 0).unwrap_or_default();
    (*t - base).num_seconds() as f64 / 86_400.0
}

const STYLE_HEADER: u8 = 1;
const STYLE_DATE: u8 = 2;
const STYLE_TIME: u8 = 3;

fn sheet_xml(sheet: &Sheet) -> String {
    let mut widths: Vec<usize> = sheet.headers.iter().map(|h| h.chars().count()).collect();
    for row in sheet.rows.iter().take(200) {
        for (i, c) in row.iter().enumerate() {
            let w = cell_text(c, sheet.lang).lines().map(|l| l.chars().count()).max().unwrap_or(0);
            if let Some(cur) = widths.get_mut(i) {
                *cur = (*cur).max(w);
            }
        }
    }
    let mut x = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>"#,
    );
    for (i, w) in widths.iter().enumerate() {
        x.push_str(&format!(r#"<col min="{n}" max="{n}" width="{}" customWidth="1"/>"#, (*w + 2).clamp(10, 60), n = i + 1));
    }
    x.push_str("</cols><sheetData>");
    let text_cell = |x: &mut String, at: &str, s: &str, style: u8| {
        let st = if style > 0 { format!(r#" s="{style}""#) } else { String::new() };
        x.push_str(&format!(r#"<c r="{at}"{st} t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#, xml(s)));
    };
    x.push_str(r#"<row r="1">"#);
    for (i, h) in sheet.headers.iter().enumerate() {
        text_cell(&mut x, &format!("{}1", column_name(i)), h, STYLE_HEADER);
    }
    x.push_str("</row>");
    for (n, row) in sheet.rows.iter().enumerate() {
        let r = n + 2;
        x.push_str(&format!(r#"<row r="{r}">"#));
        for (i, c) in row.iter().enumerate() {
            let at = format!("{}{r}", column_name(i));
            match c {
                Cell::Empty => {}
                Cell::Text(s) => text_cell(&mut x, &at, s, 0),
                Cell::Num(v) if v.is_finite() => x.push_str(&format!(r#"<c r="{at}"><v>{v}</v></c>"#)),
                Cell::Num(_) => {}
                Cell::Date(d) => x.push_str(&format!(r#"<c r="{at}" s="{STYLE_DATE}"><v>{}</v></c>"#, serial(&d.and_hms_opt(0, 0, 0).unwrap_or_default()))),
                Cell::Time(t) => x.push_str(&format!(r#"<c r="{at}" s="{STYLE_TIME}"><v>{}</v></c>"#, serial(t))),
            }
        }
        x.push_str("</row>");
    }
    x.push_str("</sheetData></worksheet>");
    x
}

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>"#;
const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#;
const WORKBOOK_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;
/// Стили ячеек: 0 — обычная, 1 — заголовок (полужирный), 2 — дата, 3 — дата и время (встроенные форматы 14 и 22
/// показываются в формате системы пользователя).
const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>"#;

fn workbook_xml(sheet_name: &str) -> String {
    // Имя листа: не длиннее 31 символа и без знаков, запрещённых Excel.
    let name: String = sheet_name.chars().filter(|c| !matches!(c, '\\' | '/' | '?' | '*' | '[' | ']' | ':')).take(31).collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="{}" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
        xml(if name.is_empty() { "Sheet1" } else { &name })
    )
}

/// ZIP со сжатием deflate: то, что нужно книге Excel и переносимой копии, без внешних библиотек.
pub(crate) fn zip(files: &[(&str, &[u8])]) -> AppResult<Vec<u8>> {
    let too_big = || err("Файл получается слишком большим. Сузьте выборку или выберите CSV.");
    let u32_of = |n: usize| u32::try_from(n).map_err(|_| too_big());
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, body) in files {
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(body)?;
        let packed = enc.finish()?;
        let mut crc = flate2::Crc::new();
        crc.update(body);
        let offset = u32_of(out.len())?;
        // Общая часть заголовков: версия 2.0, флаги, deflate, время и дата (01.01.1980), CRC, размеры, длина имени.
        let mut head = Vec::new();
        head.extend_from_slice(&[20, 0, 0, 0, 8, 0, 0, 0, 0x21, 0]);
        head.extend_from_slice(&crc.sum().to_le_bytes());
        head.extend_from_slice(&u32_of(packed.len())?.to_le_bytes());
        head.extend_from_slice(&u32_of(body.len())?.to_le_bytes());
        head.extend_from_slice(&(name.len() as u16).to_le_bytes());
        head.extend_from_slice(&[0, 0]);
        out.extend_from_slice(b"PK\x03\x04");
        out.extend_from_slice(&head);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&packed);
        central.extend_from_slice(b"PK\x01\x02");
        central.extend_from_slice(&[20, 0]);
        central.extend_from_slice(&head);
        central.extend_from_slice(&[0; 10]);
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let start = u32_of(out.len())?;
    let size = u32_of(central.len())?;
    out.extend_from_slice(&central);
    out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    Ok(out)
}

/// Книга Excel с одним листом: закреплённая строка заголовков, ширина колонок по содержимому.
pub fn to_xlsx(sheet: &Sheet) -> AppResult<Vec<u8>> {
    let workbook = workbook_xml(&sheet.name);
    let body = sheet_xml(sheet);
    zip(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", ROOT_RELS.as_bytes()),
        ("xl/workbook.xml", workbook.as_bytes()),
        ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS.as_bytes()),
        ("xl/styles.xml", STYLES.as_bytes()),
        ("xl/worksheets/sheet1.xml", body.as_bytes()),
    ])
}

/// Запрос интерфейса на выгрузку: что, в каком формате и с какими колонками.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Request {
    /// Таблица записей (`companies`, `contacts`, `deals`, `tasks`, `crm_leads`), если не задана коллекция.
    pub entity: String,
    /// Коллекция: выгружается то, что она показывает.
    pub collection: Option<String>,
    pub query: Query,
    /// `csv` или `xlsx`.
    pub format: String,
    pub fields: Vec<String>,
    /// Язык заголовков и подписей: `ru` или `en`.
    pub lang: String,
}

/// Файл выгрузки и число записей в нём. `format`: `csv` или `xlsx`.
pub fn file(store: &WorkspaceStore, table: &str, query: &Query, keys: &[String], format: &str, lang: Lang) -> AppResult<(Vec<u8>, usize)> {
    let sheet = match format {
        "csv" | "xlsx" => build(store, table, query, keys, lang)?,
        other => return Err(err(format!("Неизвестный формат файла: {other}"))),
    };
    let bytes = if format == "csv" { to_csv(&sheet) } else { to_xlsx(&sheet)? };
    Ok((bytes, sheet.rows.len()))
}

#[cfg(test)]
mod tests {
    use super::super::import;
    use super::*;
    use chrono::FixedOffset;
    use serde_json::{json, Map};

    const WS: &str = "11111111-1111-4111-8111-111111111111";
    const ME: &str = "22222222-2222-4222-8222-222222222222";

    fn open() -> (tempfile::TempDir, WorkspaceStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = WorkspaceStore::open(&dir.path().join("ws.db"), None, WS, ME).unwrap();
        s.seed_local().unwrap();
        (dir, s)
    }

    fn m(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn id(v: &Value) -> String {
        v["id"].as_str().unwrap().to_string()
    }

    fn keys(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn defaults(s: &WorkspaceStore, table: &str) -> Vec<String> {
        fields(s, table, Lang::Ru).unwrap().into_iter().filter(|f| f.default).map(|f| f.key).collect()
    }

    /// Компания с контактом и сделкой на этапе «Переговоры» (или первом, если такого нет).
    fn sample(s: &WorkspaceStore) -> (String, String, String) {
        let company = id(&s
            .save("companies", None, &m(json!({"name": "ООО «Ромашка»", "inn": "7701234567", "website": "https://romashka.ru", "phones": ["+7 999 111-22-33", "8 800 555-35-35"], "emails": ["info@romashka.ru"], "address": "Казань; Баумана, 1", "industry": "Ритейл", "owner_id": ME})))
            .unwrap());
        let contact = id(&s
            .save("contacts", None, &m(json!({"first_name": "Иван", "last_name": "Петров", "position": "Директор", "company_id": company, "phones": ["+7 999 000-00-01"], "emails": ["ivan@romashka.ru"]})))
            .unwrap());
        let (pipeline, stage) = s.first_stage(None).unwrap();
        let deal = id(&s
            .save("deals", None, &m(json!({"title": "Сайт", "pipeline_id": pipeline, "stage_id": stage, "amount": 120000.5, "currency": "RUB", "expected_close_date": "2026-12-15", "company_id": company})))
            .unwrap());
        s.save("deal_contacts", None, &m(json!({"deal_id": deal, "contact_id": contact}))).unwrap();
        (company, contact, deal)
    }

    #[test]
    fn fields_list_entity_columns_and_custom_fields() {
        let (_d, s) = open();
        let f = fields(&s, "companies", Lang::Ru).unwrap();
        assert_eq!(f[0], FieldInfo { key: "name".into(), title: "Компания".into(), default: true, custom: false });
        assert!(f.iter().any(|x| x.key == "updated_at" && !x.default));
        assert_eq!(fields(&s, "deals", Lang::En).unwrap()[0].title, "Deal");
        let def = s
            .save("custom_fields", None, &m(json!({"entity_type": "company", "label": "Сегмент", "kind": "select", "options": ["A", "B"], "position": 1})))
            .unwrap();
        s.save("custom_fields", None, &m(json!({"entity_type": "contact", "label": "День рождения", "kind": "date", "position": 1}))).unwrap();
        let f = fields(&s, "companies", Lang::Ru).unwrap();
        let last = f.last().unwrap();
        assert_eq!((last.key.as_str(), last.title.as_str(), last.custom), (format!("cf:{}", id(&def)).as_str(), "Сегмент", true));
        assert_eq!(f.iter().filter(|x| x.custom).count(), 1, "поля другой сущности не показываются");
        assert!(fields(&s, "notes", Lang::Ru).is_err());
    }

    #[test]
    fn companies_csv_has_bom_semicolons_crlf_and_reimports_with_auto_mapping() {
        let (_d, s) = open();
        sample(&s);
        let (bytes, n) = file(&s, "companies", &Query::default(), &defaults(&s, "companies"), "csv", Lang::Ru).unwrap();
        assert_eq!(n, 1);
        assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
        assert!(text.starts_with("Компания;ИНН;Сайт;Телефон компании;Почта компании;Адрес;Отрасль;Ответственный\r\n"));
        assert!(text.ends_with("\r\n"));
        assert!(text.contains("\"Казань; Баумана, 1\""), "разделитель внутри значения — в кавычках");
        assert!(text.contains(";\"+7 999 111-22-33, 8 800 555-35-35\";"), "список телефонов остаётся как есть, без апострофа");
        // Тот же файл читает мастер импорта и сам сопоставляет колонки.
        let t = import::parse("companies.csv", &bytes).unwrap();
        assert_eq!(t.rows[0][0], "ООО «Ромашка»");
        assert_eq!(t.rows[0][3], "+7 999 111-22-33, 8 800 555-35-35");
        let map = import::suggest(&t.headers);
        let expect = ["company.name", "company.inn", "company.website", "company.phone", "company.email", "company.address", "company.industry"];
        assert_eq!(map[..7].iter().map(|x| x.as_deref()).collect::<Vec<_>>(), expect.map(Some));
        assert_eq!(map[7], None);
    }

    #[test]
    fn deals_xlsx_reads_back_with_names_instead_of_ids() {
        let (_d, s) = open();
        sample(&s);
        let (_, first) = s.first_stage(None).unwrap();
        let stage = s.get("pipeline_stages", &first).unwrap().unwrap()["name"].as_str().unwrap().to_string();
        let (bytes, n) = file(
            &s,
            "deals",
            &Query::default(),
            &keys(&["title", "pipeline_id", "stage_id", "status", "amount", "currency", "company_id", "contact"]),
            "xlsx",
            Lang::Ru,
        )
        .unwrap();
        assert_eq!(n, 1);
        assert!(bytes.starts_with(b"PK\x03\x04"));
        let t = import::parse("deals.xlsx", &bytes).unwrap();
        assert_eq!(t.headers, ["Сделка", "Воронка", "Этап", "Статус", "Сумма", "Валюта", "Компания", "Контакт"]);
        assert_eq!(
            t.rows,
            vec![vec![
                "Сайт".to_string(),
                "Продажи".into(),
                stage,
                "Открыта".into(),
                "120000.5".into(),
                "RUB".into(),
                "ООО «Ромашка»".into(),
                "Иван Петров".into()
            ]]
        );
        let map = import::suggest(&t.headers);
        assert_eq!(
            map.iter().map(|x| x.as_deref()).collect::<Vec<_>>(),
            [Some("deal.title"), None, Some("deal.stage"), None, Some("deal.amount"), Some("deal.currency"), Some("company.name"), Some("contact.full_name")]
        );
    }

    #[test]
    fn exported_clients_import_into_empty_workspace() {
        let (_d, s) = open();
        sample(&s);
        let (bytes, _) = file(&s, "contacts", &Query::default(), &defaults(&s, "contacts"), "xlsx", Lang::Ru).unwrap();
        let (_d2, other) = open();
        let t = import::parse("contacts.xlsx", &bytes).unwrap();
        let opts = import::ImportOptions { mapping: import::suggest(&t.headers), ..Default::default() };
        import::run(&other, "contacts.xlsx", &t, &opts).unwrap();
        let contact = &other.list("contacts", &Query::default()).unwrap()[0];
        assert_eq!((contact["full_name"].as_str(), contact["position"].as_str()), (Some("Иван Петров"), Some("Директор")));
        assert_eq!(contact["emails"], json!(["ivan@romashka.ru"]));
        let company = &other.list("companies", &Query::default()).unwrap()[0];
        assert_eq!(company["name"], "ООО «Ромашка»");
        assert_eq!(contact["company_id"], company["id"]);
    }

    #[test]
    fn query_limits_rows_and_deleted_records_are_never_exported() {
        let (_d, s) = open();
        sample(&s);
        let gone = id(&s.save("companies", None, &m(json!({"name": "Удалённая"}))).unwrap());
        s.save("companies", None, &m(json!({"name": "Пекарня", "industry": "Еда"}))).unwrap();
        s.delete("companies", &gone).unwrap();
        let names = |q: Query| -> Vec<String> {
            build(&s, "companies", &q, &keys(&["name"]), Lang::Ru).unwrap().rows.into_iter().map(|r| cell_text(&r[0], Lang::Ru)).collect()
        };
        let mut all = names(Query::default());
        all.sort();
        assert_eq!(all, ["ООО «Ромашка»", "Пекарня"]);
        assert_eq!(names(Query { search: Some("пекар".into()), ..Default::default() }), ["Пекарня"]);
        assert_eq!(names(Query { filters: vec![Filter::eq("industry", "Ритейл")], limit: Some(1), ..Default::default() }), ["ООО «Ромашка»"]);
        // Запрос корзины не выгружает удалённые записи: экспорт всегда про действующие.
        assert_eq!(names(Query { deleted: true, ..Default::default() }).len(), 2);
    }

    #[test]
    fn limit_of_the_list_does_not_cut_the_export() {
        let (_d, s) = open();
        for i in 0..7 {
            s.save("companies", None, &m(json!({"name": format!("Компания {i}")}))).unwrap();
        }
        let sheet = build(&s, "companies", &Query { limit: Some(3), ..Default::default() }, &keys(&["name"]), Lang::Ru).unwrap();
        assert_eq!(sheet.rows.len(), 7);
    }

    #[test]
    fn formulas_are_neutralized_in_csv_and_stay_text_in_xlsx() {
        let (_d, s) = open();
        s.save("companies", None, &m(json!({"name": "=HYPERLINK(\"http://evil\")", "address": "a<b & \u{1}c", "phones": ["+7 (843) 212-48-90"]}))).unwrap();
        let k = keys(&["name", "phones", "address"]);
        let csv = String::from_utf8(file(&s, "companies", &Query::default(), &k, "csv", Lang::Ru).unwrap().0).unwrap();
        assert!(csv.contains("\"'=HYPERLINK(\"\"http://evil\"\")\";+7 (843) 212-48-90;"));
        let sheet = build(&s, "companies", &Query::default(), &k, Lang::Ru).unwrap();
        let x = sheet_xml(&sheet);
        assert!(x.contains(r#"t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://evil&quot;)</t>"#));
        assert!(!x.contains("<f>"), "формул в файле нет");
        let t = import::parse("c.xlsx", &to_xlsx(&sheet).unwrap()).unwrap();
        assert_eq!(t.rows[0], ["=HYPERLINK(\"http://evil\")", "+7 (843) 212-48-90", "a<b & c"]);
    }

    #[test]
    fn custom_fields_tasks_and_english_labels() {
        let (_d, s) = open();
        let (company, _, deal) = sample(&s);
        let seg = id(&s
            .save("custom_fields", None, &m(json!({"entity_type": "company", "label": "Сегмент", "kind": "select", "options": ["A", "B"], "position": 1})))
            .unwrap());
        let vip = id(&s.save("custom_fields", None, &m(json!({"entity_type": "company", "label": "VIP", "kind": "bool", "position": 2}))).unwrap());
        let since = id(&s.save("custom_fields", None, &m(json!({"entity_type": "company", "label": "Клиент с", "kind": "date", "position": 3}))).unwrap());
        for (f, v) in [(&seg, json!("B")), (&vip, json!(true)), (&since, json!("2024-03-01"))] {
            s.save("custom_field_values", None, &m(json!({"field_id": f, "entity_type": "company", "entity_id": company, "value": v}))).unwrap();
        }
        let k = vec!["name".to_string(), format!("cf:{vip}"), format!("cf:{seg}"), format!("cf:{since}")];
        let sheet = build(&s, "companies", &Query::default(), &k, Lang::Ru).unwrap();
        assert_eq!(sheet.headers, ["Компания", "Сегмент", "VIP", "Клиент с"], "свои поля — в порядке настройки");
        assert_eq!(sheet.rows[0][1..], [Cell::Text("B".into()), Cell::Text("да".into()), Cell::Date(NaiveDate::from_ymd_opt(2024, 3, 1).unwrap())]);
        assert!(build(&s, "companies", &Query::default(), &keys(&["cf:нет"]), Lang::Ru).is_err());

        s.save("tasks", None, &m(json!({"title": "Позвонить", "priority": "high", "assignee_id": ME, "due_at": "2026-12-01T09:30:00.000Z", "entity_type": "deal", "entity_id": deal}))).unwrap();
        let tz = FixedOffset::east_opt(3 * 3600).unwrap();
        let tasks =
            build_in(&s, "tasks", &Query::default(), &keys(&["title", "status", "priority", "due_at", "assignee_id", "related"]), Lang::En, &tz).unwrap();
        assert_eq!(tasks.headers, ["Task", "Status", "Priority", "Due", "Assignee", "Related to"]);
        let due = NaiveDate::from_ymd_opt(2026, 12, 1).unwrap().and_hms_opt(12, 30, 0).unwrap();
        assert_eq!(
            tasks.rows[0],
            [
                Cell::Text("Позвонить".into()),
                Cell::Text("To do".into()),
                Cell::Text("High".into()),
                Cell::Time(due),
                Cell::Text("Member".into()),
                Cell::Text("Сайт".into())
            ]
        );
        assert_eq!(cell_text(&Cell::Time(due), Lang::Ru), "01.12.2026 12:30");
        assert!(sheet_xml(&tasks).contains(&format!(r#"s="{STYLE_TIME}"><v>{}</v>"#, serial(&due))));
    }

    #[test]
    fn numbers_dates_and_column_names() {
        assert_eq!((number_text(120000.0, Lang::Ru), number_text(1.5, Lang::Ru), number_text(1.5, Lang::En)), ("120000".into(), "1,5".into(), "1.5".into()));
        assert_eq!(cell_text(&Cell::Date(NaiveDate::from_ymd_opt(2026, 12, 15).unwrap()), Lang::Ru), "15.12.2026");
        assert_eq!(serial(&NaiveDate::from_ymd_opt(2026, 1, 1).unwrap().and_hms_opt(12, 0, 0).unwrap()), 46023.5);
        assert_eq!(
            [column_name(0), column_name(25), column_name(26), column_name(27), column_name(701), column_name(702)],
            ["A", "Z", "AA", "AB", "ZZ", "AAA"]
        );
        assert_eq!(to_naive("2026-06-30T22:15:42.123Z", &FixedOffset::east_opt(5 * 3600).unwrap()).unwrap().to_string(), "2026-07-01 03:15:00");
    }

    #[test]
    fn export_needs_permission_columns_and_known_format() {
        let (_d, s) = open();
        sample(&s);
        assert!(file(&s, "companies", &Query::default(), &[], "csv", Lang::Ru).unwrap_err().to_string().contains("хотя бы одну"));
        assert!(file(&s, "companies", &Query::default(), &keys(&["name"]), "json", Lang::Ru).is_err());
        assert!(file(&s, "companies", &Query::default(), &keys(&["dedupe_keys"]), "csv", Lang::Ru).is_err());
        assert!(file(&s, "notes", &Query::default(), &keys(&["body"]), "csv", Lang::Ru).is_err());
        s.set_permissions(&["records.view".to_string(), "records.create".to_string()]).unwrap();
        assert!(file(&s, "companies", &Query::default(), &keys(&["name"]), "csv", Lang::Ru).unwrap_err().to_string().contains("прав"));
    }
}
