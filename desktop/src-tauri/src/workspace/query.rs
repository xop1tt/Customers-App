//! Фильтры, сортировка и поиск по базе Workspace — то, что исполняют разделы CRM и коллекции
//! (`collections.config`). Имена полей сверяются с описанием сущности, значения передаются параметрами,
//! поэтому текст фильтра не может стать частью SQL.

use super::schema::{Entity, Kind};
use crate::error::{AppError, AppResult};
use chrono::{DateTime, Datelike, Duration, Local, Utc};
use rusqlite::types::Value as Sql;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Filter {
    pub field: String,
    pub op: String,
    pub value: Value,
}

impl Filter {
    pub fn eq(field: &str, value: &str) -> Self {
        Self { field: field.into(), op: "eq".into(), value: Value::String(value.into()) }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Sort {
    pub field: String,
    pub dir: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Query {
    pub filters: Vec<Filter>,
    pub sort: Vec<Sort>,
    pub search: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    /// Показывать архивные записи.
    pub archived: bool,
    /// Показывать удалённые (корзина).
    pub deleted: bool,
}

pub const MAX_LIMIT: u32 = 5000;

impl Query {
    /// Запрос коллекции: `config` в формате `collections.config`.
    pub fn from_config(config: &Value) -> Self {
        let mut q = Query {
            filters: serde_json::from_value(config["filters"].clone()).unwrap_or_default(),
            sort: serde_json::from_value(config["sort"].clone()).unwrap_or_default(),
            ..Default::default()
        };
        q.filters.retain(|f| !f.field.is_empty());
        q
    }
}

fn bad(text: String) -> AppError {
    AppError::msg(text)
}

fn where_clause(e: &Entity, q: &Query, me: &str, now: DateTime<Utc>) -> AppResult<(String, Vec<Sql>)> {
    let mut parts: Vec<String> = Vec::new();
    let mut args: Vec<Sql> = Vec::new();
    parts.push(if q.deleted { "deleted_at IS NOT NULL".into() } else { "deleted_at IS NULL".into() });
    if !q.archived && e.has("archived_at") {
        parts.push("archived_at IS NULL".into());
    }
    for f in &q.filters {
        let kind = e.column_kind(&f.field).ok_or_else(|| bad(format!("Неизвестное поле фильтра: {}", f.field)))?;
        let col = f.field.as_str();
        let value = |v: &Value| -> Sql {
            match v {
                Value::String(s) if s == "$me" => Sql::Text(me.to_string()),
                Value::String(s) => Sql::Text(s.clone()),
                Value::Bool(b) => Sql::Integer(*b as i64),
                Value::Number(n) => n.as_f64().map(Sql::Real).unwrap_or(Sql::Null),
                Value::Null => Sql::Null,
                other => Sql::Text(other.to_string()),
            }
        };
        match f.op.as_str() {
            "eq" | "ne" | "gt" | "lt" | "gte" | "lte" => {
                let sym = match f.op.as_str() {
                    "eq" => "=",
                    "ne" => "IS NOT",
                    "gt" => ">",
                    "lt" => "<",
                    "gte" => ">=",
                    _ => "<=",
                };
                parts.push(format!("{col} {sym} ?"));
                args.push(value(&f.value));
            }
            "in" => {
                let items = f.value.as_array().cloned().unwrap_or_default();
                if items.is_empty() {
                    parts.push("0".into());
                } else {
                    parts.push(format!("{col} IN ({})", vec!["?"; items.len()].join(", ")));
                    args.extend(items.iter().map(value));
                }
            }
            "contains" => {
                parts.push(format!("lower({col}) LIKE ? ESCAPE '\\'"));
                args.push(Sql::Text(format!("%{}%", like_escape(&f.value.as_str().unwrap_or_default().to_lowercase()))));
            }
            "empty" => {
                parts.push(if kind == Kind::Json { format!("({col} IS NULL OR {col} IN ('[]', '{{}}'))") } else { format!("({col} IS NULL OR {col} = '')") })
            }
            "not_empty" => parts.push(if kind == Kind::Json {
                format!("({col} IS NOT NULL AND {col} NOT IN ('[]', '{{}}'))")
            } else {
                format!("({col} IS NOT NULL AND {col} <> '')")
            }),
            "this_week" | "today" | "overdue" => {
                let local = now.with_timezone(&Local);
                let (from, to) = if f.op == "today" {
                    (local.date_naive(), local.date_naive())
                } else {
                    let monday = local.date_naive() - Duration::days(local.weekday().num_days_from_monday() as i64);
                    (monday, monday + Duration::days(6))
                };
                match (f.op.as_str(), kind) {
                    ("overdue", _) => {
                        parts.push(format!("{col} IS NOT NULL AND {col} < ?"));
                        args.push(Sql::Text(super::store::stamp(now)));
                        if e.table == "tasks" {
                            parts.push("status NOT IN ('done', 'cancelled')".into());
                        }
                    }
                    (_, Kind::Date) => {
                        parts.push(format!("{col} BETWEEN ? AND ?"));
                        args.push(Sql::Text(from.to_string()));
                        args.push(Sql::Text(to.to_string()));
                    }
                    _ => {
                        let start = from.and_hms_opt(0, 0, 0).unwrap().and_local_timezone(Local).earliest().map(|d| d.with_timezone(&Utc)).unwrap_or(now);
                        let end = start + Duration::days((to - from).num_days() + 1);
                        parts.push(format!("{col} >= ? AND {col} < ?"));
                        args.push(Sql::Text(super::store::stamp(start)));
                        args.push(Sql::Text(super::store::stamp(end)));
                    }
                }
            }
            other => return Err(bad(format!("Неизвестное условие фильтра: {other}"))),
        }
    }
    if let Some(text) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let like = format!("%{}%", like_escape(&text.to_lowercase()));
        let cols: Vec<String> = e.search.iter().map(|c| format!("lower(coalesce({c}, '')) LIKE ? ESCAPE '\\'")).collect();
        parts.push(format!("({})", cols.join(" OR ")));
        args.extend(e.search.iter().map(|_| Sql::Text(like.clone())));
    }
    Ok((parts.join(" AND "), args))
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

pub fn build(e: &Entity, q: &Query, me: &str, now: DateTime<Utc>) -> AppResult<(String, Vec<Sql>)> {
    let (w, args) = where_clause(e, q, me, now)?;
    let mut order: Vec<String> = Vec::new();
    for s in &q.sort {
        e.column_kind(&s.field).ok_or_else(|| bad(format!("Неизвестное поле сортировки: {}", s.field)))?;
        let dir = if s.dir.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };
        // Пустые значения — в конце при любом направлении.
        order.push(format!("{f} IS NULL, {f} {dir}", f = s.field));
    }
    order.push(if e.has("position") { "position ASC".into() } else { "updated_at DESC".into() });
    order.push("id".into());
    let limit = q.limit.unwrap_or(500).clamp(1, MAX_LIMIT);
    let offset = q.offset.unwrap_or(0);
    Ok((format!("SELECT * FROM {} WHERE {w} ORDER BY {} LIMIT {limit} OFFSET {offset}", e.table, order.join(", ")), args))
}

pub fn build_count(e: &Entity, q: &Query, me: &str, now: DateTime<Utc>) -> AppResult<(String, Vec<Sql>)> {
    let (w, args) = where_clause(e, q, me, now)?;
    Ok((format!("SELECT count(*) FROM {} WHERE {w}", e.table), args))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::schema;

    #[test]
    fn unknown_fields_and_operators_are_rejected_not_interpolated() {
        let e = schema::entity("companies").unwrap();
        let mut q = Query::default();
        q.filters.push(Filter { field: "name; DROP TABLE companies".into(), op: "eq".into(), value: Value::Null });
        assert!(build(e, &q, "me", Utc::now()).is_err());
        q.filters = vec![Filter { field: "name".into(), op: "or 1=1".into(), value: Value::Null }];
        assert!(build(e, &q, "me", Utc::now()).is_err());
        q.filters = vec![];
        q.sort = vec![Sort { field: "name desc, (select 1)".into(), dir: "asc".into() }];
        assert!(build(e, &q, "me", Utc::now()).is_err());
    }

    #[test]
    fn me_and_search_are_parameters() {
        let e = schema::entity("companies").unwrap();
        let q = Query {
            filters: vec![Filter { field: "owner_id".into(), op: "eq".into(), value: Value::String("$me".into()) }],
            search: Some("50%_off'".into()),
            ..Default::default()
        };
        let (sql, args) = build(e, &q, "user-1", Utc::now()).unwrap();
        assert!(!sql.contains("user-1") && !sql.contains("50%"));
        assert_eq!(args[0], Sql::Text("user-1".into()));
        assert_eq!(args[1], Sql::Text("%50\\%\\_off'%".into()));
    }
}
