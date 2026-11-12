//! Объединение дубликатов (пакет G4, docs/MERGE.md). Две компании или два контакта становятся одной записью:
//! выбранные значения полей записываются в оставшуюся запись, всё связанное (контакты, сделки, задачи, события,
//! заметки, комментарии, вложения, свои поля, участие в сделках) переходит к ней, вторая запись уходит в корзину.
//!
//! Всё делается обычными `save`, поэтому работают права, проверки, очередь синхронизации и история. Схема и
//! сервер не меняются: сервер разрешает менять `entity_id` и `company_id`, проверяя только ссылку.
//!
//! Отмена: снимок «как было» последнего объединения хранится в `local_meta`. Отменить можно, пока ни одна из
//! затронутых записей не изменилась после объединения (правка, синхронизация с сервером).

use super::schema;
use super::store::{deal_contact_id, new_id, stamp, WorkspaceStore};
use crate::error::{AppError, AppResult};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const UNDO_KEY: &str = "merge_undo";

/// Поля, которые нельзя перенести выбором значения: служебные и связь с источником.
const FIXED: [&str; 6] = ["deleted_at", "archived_at", "source_lead_id", "source_payload", "dedupe_keys", "source"];

/// Таблицы, привязанные к карточке через `entity_type` + `entity_id`.
const LINKED: [&str; 5] = ["tasks", "activities", "notes", "comments", "attachments"];

fn err(text: impl Into<String>) -> AppError {
    AppError::msg(text.into())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MergeRequest {
    /// `companies` или `contacts`.
    pub entity: String,
    /// Запись, которая остаётся.
    pub keep: String,
    /// Запись, которая уходит в корзину.
    pub remove: String,
    /// Выбранные значения полей для оставшейся записи.
    pub values: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Merged {
    pub kept: Value,
    /// Сколько связанных записей перешло к оставшейся.
    pub moved: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct UndoRow {
    table: String,
    id: String,
    /// Значения полей до объединения; для созданной записи — `deleted_at`.
    before: Map<String, Value>,
    /// Состояние после объединения: отмена возможна, только если запись с тех пор не менялась.
    updated_at: Value,
    version: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoInfo {
    pub entity: String,
    pub keep: String,
    pub remove: String,
    pub removed_title: String,
    pub at: String,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    info: UndoInfo,
    rows: Vec<UndoRow>,
}

fn title(table: &str, row: &Value) -> String {
    let t = if table == "contacts" { row["full_name"].as_str() } else { row["name"].as_str() };
    t.filter(|s| !s.trim().is_empty()).unwrap_or("Без названия").to_string()
}

/// Изменить запись (или создать, если её нет) и запомнить, как было.
fn touch(store: &WorkspaceStore, log: &mut Vec<UndoRow>, table: &str, id: &str, fields: Map<String, Value>) -> AppResult<Value> {
    let current = store.get(table, id)?;
    let before: Map<String, Value> = match &current {
        Some(cur) => fields.keys().filter(|k| cur[k.as_str()] != fields[k.as_str()]).map(|k| (k.clone(), cur[k.as_str()].clone())).collect(),
        None => [("deleted_at".to_string(), json!(stamp(Utc::now())))].into_iter().collect(),
    };
    if current.is_some() && before.is_empty() {
        return Ok(current.unwrap_or(Value::Null));
    }
    let row = store.save(table, Some(id), &fields)?;
    log.push(UndoRow { table: table.into(), id: id.into(), before, updated_at: row["updated_at"].clone(), version: row["version"].clone() });
    Ok(row)
}

fn ids(store: &WorkspaceStore, sql: &str, args: &[&str]) -> AppResult<Vec<String>> {
    let mut st = store.conn().prepare(sql)?;
    let rows = st.query_map(rusqlite::params_from_iter(args.iter()), |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn one(k: &str, v: Value) -> Map<String, Value> {
    [(k.to_string(), v)].into_iter().collect()
}

pub fn merge(store: &WorkspaceStore, req: &MergeRequest) -> AppResult<Merged> {
    let table = req.entity.as_str();
    let (kind, e) = match table {
        "companies" => ("company", &schema::COMPANIES),
        "contacts" => ("contact", &schema::CONTACTS),
        _ => return Err(err("Объединять можно только компании и контакты.")),
    };
    if !(store.can("records.edit") && store.can("records.delete")) {
        return Err(err("Недостаточно прав для объединения записей: нужно право менять и удалять любые записи."));
    }
    if req.keep == req.remove {
        return Err(err("Выберите две разные записи."));
    }
    let keep = store.get(table, &req.keep)?.filter(|r| r["deleted_at"].is_null()).ok_or_else(|| err("Запись, которая остаётся, не найдена."))?;
    let remove = store.get(table, &req.remove)?.filter(|r| r["deleted_at"].is_null()).ok_or_else(|| err("Вторая запись не найдена или уже удалена."))?;
    let mut values = Map::new();
    for (k, v) in &req.values {
        if FIXED.contains(&k.as_str()) || e.field(k).map_or(true, |f| !f.writable) {
            return Err(err(format!("Поле «{k}» нельзя выбрать при объединении.")));
        }
        values.insert(k.clone(), v.clone());
    }
    if table == "contacts" && values.get("company_id").and_then(Value::as_str) == Some(req.remove.as_str()) {
        return Err(err("Контакт не может ссылаться на удаляемую запись."));
    }

    let mut log = Vec::new();
    let mut moved = 0;
    let result = (|| -> AppResult<()> {
        if values.is_empty() {
            // Оставшаяся запись не меняется, но её правка после объединения тоже должна запрещать отмену.
            log.push(UndoRow {
                table: table.into(),
                id: req.keep.clone(),
                before: Map::new(),
                updated_at: keep["updated_at"].clone(),
                version: keep["version"].clone(),
            });
        } else {
            touch(store, &mut log, table, &req.keep, values.clone())?;
        }
        // Записи, ссылающиеся на дубликат прямым полем.
        let direct: &[(&str, &str)] = if table == "companies" {
            &[("contacts", "company_id"), ("deals", "company_id"), ("crm_leads", "converted_company_id")]
        } else {
            &[("crm_leads", "converted_contact_id")]
        };
        for (t, col) in direct {
            for id in ids(store, &format!("SELECT id FROM {t} WHERE {col}=?1 AND deleted_at IS NULL"), &[&req.remove])? {
                touch(store, &mut log, t, &id, one(col, json!(req.keep)))?;
                moved += 1;
            }
        }
        // Участие контакта в сделках: пара (сделка, контакт) уникальна, поэтому строка пересоздаётся.
        if table == "contacts" {
            for (link, deal, role) in deal_links(store, &req.remove)? {
                let target = deal_contact_id(&deal, &req.keep);
                let existing = store.get("deal_contacts", &target)?;
                if existing.as_ref().map_or(true, |r| !r["deleted_at"].is_null()) {
                    let mut f = Map::new();
                    f.insert("deal_id".into(), json!(deal));
                    f.insert("contact_id".into(), json!(req.keep));
                    f.insert("role".into(), role);
                    if existing.is_some() {
                        f.insert("deleted_at".into(), Value::Null);
                    }
                    touch(store, &mut log, "deal_contacts", &target, f)?;
                    moved += 1;
                }
                touch(store, &mut log, "deal_contacts", &link, one("deleted_at", json!(stamp(Utc::now()))))?;
            }
        }
        // Задачи, события, заметки, комментарии, вложения.
        for t in LINKED {
            for id in ids(store, &format!("SELECT id FROM {t} WHERE entity_type=?1 AND entity_id=?2 AND deleted_at IS NULL"), &[kind, &req.remove])? {
                touch(store, &mut log, t, &id, one("entity_id", json!(req.keep)))?;
                moved += 1;
            }
        }
        // Свои поля: значение оставшейся записи важнее; пустое поле заполняется значением дубликата.
        let kept_fields: Vec<String> = ids(
            store,
            "SELECT field_id FROM custom_field_values WHERE entity_type=?1 AND entity_id=?2 AND deleted_at IS NULL AND value IS NOT NULL",
            &[kind, &req.keep],
        )?;
        for id in ids(store, "SELECT id FROM custom_field_values WHERE entity_type=?1 AND entity_id=?2 AND deleted_at IS NULL", &[kind, &req.remove])? {
            let row = store.get("custom_field_values", &id)?.unwrap_or(Value::Null);
            let field = row["field_id"].as_str().unwrap_or_default().to_string();
            if kept_fields.contains(&field) || row["value"].is_null() {
                touch(store, &mut log, "custom_field_values", &id, one("deleted_at", json!(stamp(Utc::now()))))?;
            } else {
                // Пустое значение оставшейся записи уходит, его место занимает значение дубликата.
                for empty in ids(
                    store,
                    "SELECT id FROM custom_field_values WHERE entity_type=?1 AND entity_id=?2 AND field_id=?3 AND deleted_at IS NULL",
                    &[kind, &req.keep, &field],
                )? {
                    touch(store, &mut log, "custom_field_values", &empty, one("deleted_at", json!(stamp(Utc::now()))))?;
                }
                touch(store, &mut log, "custom_field_values", &id, one("entity_id", json!(req.keep)))?;
                moved += 1;
            }
        }
        touch(store, &mut log, table, &req.remove, one("deleted_at", json!(stamp(Utc::now()))))?;
        // Отметка в ленте оставшейся записи.
        let mut a = Map::new();
        a.insert("type".into(), json!("system"));
        a.insert("occurred_at".into(), json!(stamp(Utc::now())));
        a.insert("summary".into(), json!(format!("Объединено с «{}»", title(table, &remove))));
        a.insert("payload".into(), json!({"event": "merged", "merged_id": req.remove}));
        a.insert("entity_type".into(), json!(kind));
        a.insert("entity_id".into(), json!(req.keep));
        touch(store, &mut log, "activities", &new_id(), a)?;
        Ok(())
    })();
    if let Err(e) = result {
        // Частично выполненное объединение откатывается.
        let _ = revert(store, &log);
        return Err(e);
    }
    let info =
        UndoInfo { entity: table.into(), keep: req.keep.clone(), remove: req.remove.clone(), removed_title: title(table, &remove), at: stamp(Utc::now()) };
    store.set_meta(UNDO_KEY, &serde_json::to_string(&Stored { info, rows: log })?)?;
    let kept = store.get(table, &req.keep)?.unwrap_or(keep);
    Ok(Merged { kept, moved })
}

fn deal_links(store: &WorkspaceStore, contact: &str) -> AppResult<Vec<(String, String, Value)>> {
    let mut st = store.conn().prepare("SELECT id, deal_id, role FROM deal_contacts WHERE contact_id=?1 AND deleted_at IS NULL")?;
    let rows = st.query_map([contact], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?.map(Value::String).unwrap_or(Value::Null)))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Вернуть поля в обратном порядке: удалённая запись восстанавливается раньше, чем на неё снова сошлются.
fn revert(store: &WorkspaceStore, log: &[UndoRow]) -> AppResult<()> {
    for row in log.iter().rev() {
        store.save(&row.table, Some(&row.id), &row.before)?;
    }
    Ok(())
}

/// Последнее объединение, которое ещё можно отменить.
pub fn last(store: &WorkspaceStore) -> AppResult<Option<UndoInfo>> {
    let Some(raw) = store.meta(UNDO_KEY) else { return Ok(None) };
    let Ok(stored) = serde_json::from_str::<Stored>(&raw) else { return Ok(None) };
    Ok(undoable(store, &stored.rows)?.then_some(stored.info))
}

fn undoable(store: &WorkspaceStore, rows: &[UndoRow]) -> AppResult<bool> {
    for r in rows {
        let cur = store.get(&r.table, &r.id)?;
        let same = cur.as_ref().is_some_and(|c| c["updated_at"] == r.updated_at && c["version"] == r.version);
        if !same {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Отменить последнее объединение. Возвращает, что было объединено.
pub fn undo(store: &WorkspaceStore) -> AppResult<UndoInfo> {
    let raw = store.meta(UNDO_KEY).ok_or_else(|| err("Нечего отменять."))?;
    let stored: Stored = serde_json::from_str(&raw).map_err(|_| err("Нечего отменять."))?;
    if !(store.can("records.edit") && store.can("records.delete")) {
        return Err(err("Недостаточно прав для отмены объединения."));
    }
    if !undoable(store, &stored.rows)? {
        return Err(err("Отменить нельзя: после объединения записи уже изменились или ушли на сервер."));
    }
    revert(store, &stored.rows)?;
    clear(store)?;
    Ok(stored.info)
}

fn clear(store: &WorkspaceStore) -> AppResult<()> {
    store.conn().execute("DELETE FROM local_meta WHERE key=?1", [UNDO_KEY])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::query::Query;

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

    fn save(s: &WorkspaceStore, t: &str, v: Value) -> String {
        s.save(t, None, &m(v)).unwrap()["id"].as_str().unwrap().to_string()
    }

    fn req(entity: &str, keep: &str, remove: &str, values: Value) -> MergeRequest {
        MergeRequest { entity: entity.into(), keep: keep.into(), remove: remove.into(), values: m(values) }
    }

    fn field(s: &WorkspaceStore, t: &str, id: &str, f: &str) -> Value {
        s.get(t, id).unwrap().unwrap()[f].clone()
    }

    #[test]
    fn companies_merge_moves_everything_and_undo_restores_it() {
        let (_d, s) = open();
        let keep = save(&s, "companies", json!({"name": "Ромашка", "phones": ["+7 999 111-22-33"]}));
        let dup = save(&s, "companies", json!({"name": "ООО «Ромашка»", "inn": "1655000000", "website": "https://romashka.ru"}));
        let contact = save(&s, "contacts", json!({"first_name": "Иван", "company_id": dup}));
        let (pipe, stage) = s.first_stage(None).unwrap();
        let deal = save(&s, "deals", json!({"title": "Сайт", "pipeline_id": pipe, "stage_id": stage, "company_id": dup}));
        let task = save(&s, "tasks", json!({"title": "Позвонить", "entity_type": "company", "entity_id": dup}));
        let note = save(&s, "notes", json!({"body": "Важный клиент", "entity_type": "company", "entity_id": dup}));
        let def = save(&s, "custom_fields", json!({"entity_type": "company", "label": "Сегмент", "kind": "text"}));
        let def2 = save(&s, "custom_fields", json!({"entity_type": "company", "label": "Регион", "kind": "text"}));
        save(&s, "custom_field_values", json!({"field_id": def, "entity_type": "company", "entity_id": keep, "value": "A"}));
        let v_dup = save(&s, "custom_field_values", json!({"field_id": def, "entity_type": "company", "entity_id": dup, "value": "B"}));
        let v_moved = save(&s, "custom_field_values", json!({"field_id": def2, "entity_type": "company", "entity_id": dup, "value": "Казань"}));

        let out = merge(&s, &req("companies", &keep, &dup, json!({"name": "ООО «Ромашка»", "inn": "1655000000", "phones": ["+7 999 111-22-33"]}))).unwrap();
        assert_eq!((out.kept["name"].as_str(), out.kept["inn"].as_str()), (Some("ООО «Ромашка»"), Some("1655000000")));
        assert_eq!(out.moved, 5);
        assert!(!field(&s, "companies", &dup, "deleted_at").is_null());
        for (t, id, f) in [
            ("contacts", &contact, "company_id"),
            ("deals", &deal, "company_id"),
            ("tasks", &task, "entity_id"),
            ("notes", &note, "entity_id"),
            ("custom_field_values", &v_moved, "entity_id"),
        ] {
            assert_eq!(field(&s, t, id, f), json!(keep), "{t}");
        }
        assert!(!field(&s, "custom_field_values", &v_dup, "deleted_at").is_null(), "значение оставшейся записи важнее");
        let feed = s.linked("activities", "company", &keep).unwrap();
        assert_eq!(feed[0]["summary"], "Объединено с «ООО «Ромашка»»");
        assert_eq!(last(&s).unwrap().unwrap().removed_title, "ООО «Ромашка»");

        let info = undo(&s).unwrap();
        assert_eq!(info.remove, dup);
        assert!(field(&s, "companies", &dup, "deleted_at").is_null());
        assert_eq!(field(&s, "companies", &keep, "name"), "Ромашка");
        assert!(field(&s, "companies", &keep, "inn").is_null());
        for (t, id, f) in [
            ("contacts", &contact, "company_id"),
            ("deals", &deal, "company_id"),
            ("tasks", &task, "entity_id"),
            ("custom_field_values", &v_moved, "entity_id"),
        ] {
            assert_eq!(field(&s, t, id, f), json!(dup), "{t}");
        }
        assert!(field(&s, "custom_field_values", &v_dup, "deleted_at").is_null());
        assert!(s.linked("activities", "company", &keep).unwrap().is_empty(), "отметка в ленте убрана");
        assert!(last(&s).unwrap().is_none());
        assert!(undo(&s).is_err(), "второй раз отменять нечего");
    }

    #[test]
    fn contacts_merge_relinks_deals_without_duplicate_pairs() {
        let (_d, s) = open();
        let keep = save(&s, "contacts", json!({"first_name": "Иван", "last_name": "Петров", "emails": ["ivan@a.ru"]}));
        let dup = save(&s, "contacts", json!({"first_name": "Иван", "last_name": "Петров", "phones": ["+79991112233"]}));
        let (pipe, stage) = s.first_stage(None).unwrap();
        let both = save(&s, "deals", json!({"title": "Обе", "pipeline_id": pipe, "stage_id": stage}));
        let only = save(&s, "deals", json!({"title": "Только дубль", "pipeline_id": pipe, "stage_id": stage}));
        for (deal, c) in [(&both, &keep), (&both, &dup), (&only, &dup)] {
            s.save("deal_contacts", Some(&deal_contact_id(deal, c)), &m(json!({"deal_id": deal, "contact_id": c, "role": "ЛПР"}))).unwrap();
        }
        merge(&s, &req("contacts", &keep, &dup, json!({"phones": ["+79991112233"]}))).unwrap();
        let live = |deal: &str| -> Vec<String> { ids(&s, "SELECT contact_id FROM deal_contacts WHERE deal_id=?1 AND deleted_at IS NULL", &[deal]).unwrap() };
        assert_eq!((live(&both), live(&only)), (vec![keep.clone()], vec![keep.clone()]));
        assert_eq!(field(&s, "deal_contacts", &deal_contact_id(&only, &keep), "role"), "ЛПР");
        undo(&s).unwrap();
        let mut b = live(&both);
        b.sort();
        let mut want = vec![keep.clone(), dup.clone()];
        want.sort();
        assert_eq!((b, live(&only)), (want, vec![dup.clone()]));
        assert!(!field(&s, "deal_contacts", &deal_contact_id(&only, &keep), "deleted_at").is_null(), "созданная связь снова удалена");
    }

    #[test]
    fn undo_is_refused_after_a_later_change() {
        let (_d, s) = open();
        let keep = save(&s, "companies", json!({"name": "Альфа"}));
        let dup = save(&s, "companies", json!({"name": "Альфа ООО"}));
        merge(&s, &req("companies", &keep, &dup, json!({}))).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        s.save("companies", Some(&keep), &m(json!({"industry": "Ритейл"}))).unwrap();
        assert!(last(&s).unwrap().is_none());
        assert!(undo(&s).unwrap_err().to_string().contains("уже изменились"));
    }

    #[test]
    fn checks_rights_entities_and_fields() {
        let (_d, s) = open();
        let a = save(&s, "companies", json!({"name": "А"}));
        let b = save(&s, "companies", json!({"name": "Б"}));
        let (pipe, stage) = s.first_stage(None).unwrap();
        let deal = save(&s, "deals", json!({"title": "Сделка", "pipeline_id": pipe, "stage_id": stage}));
        let msg = |r: MergeRequest| merge(&s, &r).unwrap_err().to_string();
        assert!(msg(req("deals", &deal, &deal, json!({}))).contains("только компании и контакты"));
        assert!(msg(req("companies", &a, &a, json!({}))).contains("разные"));
        assert!(msg(req("companies", &a, &b, json!({"source_lead_id": "x"}))).contains("нельзя выбрать"));
        assert!(msg(req("companies", &a, &b, json!({"нет": 1}))).contains("нельзя выбрать"));
        // Ошибка проверки значения откатывает уже сделанное.
        assert!(merge(&s, &req("companies", &a, &b, json!({"name": "ы".repeat(400)}))).is_err());
        assert!(field(&s, "companies", &b, "deleted_at").is_null());
        assert_eq!(s.count("companies", &Query::default()).unwrap(), 2);

        s.set_permissions(&["records.view".into(), "records.edit".into()]).unwrap();
        assert!(msg(req("companies", &a, &b, json!({}))).contains("Недостаточно прав"));
    }
}
