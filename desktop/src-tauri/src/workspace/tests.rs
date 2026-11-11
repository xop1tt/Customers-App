//! Тесты базы Workspace на устройстве: запись и очередь операций, права роли, ссылки, вычисляемые поля,
//! загрузка с сервера поверх неотправленных правок, ответы `crm_push`, коллекции, преобразование лида.

use super::convert::{convert_lead, ConvertOptions};
use super::query::{Filter, Query};
use super::store::{deal_contact_id, Member, WorkspaceStore};
use crate::models::{LeadData, LeadItem, LeadKind};
use chrono::Utc;
use serde_json::{json, Map, Value};

const WS: &str = "11111111-1111-4111-8111-111111111111";
const ME: &str = "22222222-2222-4222-8222-222222222222";
const OTHER: &str = "33333333-3333-4333-8333-333333333333";

fn open() -> (tempfile::TempDir, WorkspaceStore) {
    let dir = tempfile::tempdir().unwrap();
    let s = WorkspaceStore::open(&dir.path().join("ws.db"), None, WS, ME).unwrap();
    (dir, s)
}

fn m(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

fn id(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

#[test]
fn save_writes_row_and_one_merged_operation() {
    let (_d, s) = open();
    let c = s.save("companies", None, &m(json!({"name": "  Ромашка ", "phones": ["8 999 123-45-67", "8 999 123-45-67"]}))).unwrap();
    assert_eq!(c["name"], "Ромашка");
    assert_eq!(c["phones"], json!(["8 999 123-45-67"]));
    assert_eq!(c["created_by"], ME);
    assert_eq!(c["sync_state"], "pending");
    assert!(c["dedupe_keys"].as_array().unwrap().contains(&json!("phone:+79991234567")));
    s.save("companies", Some(&id(&c)), &m(json!({"industry": "IT"}))).unwrap();
    let ops = s.pending_ops(10).unwrap();
    assert_eq!(ops.len(), 1, "правки до отправки сливаются");
    assert_eq!(ops[0].fields["industry"], "IT");
    assert_eq!(ops[0].fields["name"], "Ромашка");
    assert!(ops[0].ts.contains_key("industry"));
    // После начала отправки новая правка — отдельная операция.
    s.mark_sending(&ops).unwrap();
    s.save("companies", Some(&id(&c)), &m(json!({"industry": "Ритейл"}))).unwrap();
    assert_eq!(s.pending_ops(10).unwrap().len(), 2);
    // То же значение не создаёт операцию.
    s.save("companies", Some(&id(&c)), &m(json!({"industry": "Ритейл"}))).unwrap();
    assert_eq!(s.pending_ops(10).unwrap().len(), 2);
}

#[test]
fn validation_matches_server_checks() {
    let (_d, s) = open();
    for (table, fields) in [
        ("companies", json!({})),
        ("companies", json!({"name": "x", "inn": "77 01"})),
        ("companies", json!({"name": "x", "created_by": OTHER})),
        ("companies", json!({"name": "x", "version": 5})),
        ("contacts", json!({"first_name": " ", "last_name": ""})),
        ("crm_leads", json!({"title": "x", "status": "won"})),
        ("tasks", json!({"title": "x", "entity_type": "company"})),
        ("tasks", json!({"title": "x", "priority": "asap"})),
        ("collections", json!({"name": "x", "entity_type": "lead"})),
    ] {
        assert!(s.save(table, None, &m(fields.clone())).is_err(), "{table} {fields}");
    }
    let (p, st) = s.first_stage(None).map_err(|_| ()).unwrap_or_default();
    assert!(p.is_empty() && st.is_empty(), "без шаблона воронки нет");
}

#[test]
fn references_must_exist_in_this_workspace() {
    let (_d, s) = open();
    let missing = uuid::Uuid::new_v4().to_string();
    assert!(s.save("contacts", None, &m(json!({"first_name": "A", "company_id": missing}))).is_err());
    assert!(s.save("notes", None, &m(json!({"body": "x", "entity_type": "company", "entity_id": missing}))).is_err());
    s.replace_members(&[Member {
        user_id: ME.into(),
        display_name: "Я".into(),
        role: "owner".into(),
        role_name: String::new(),
        rank: 100,
        avatar_path: None,
        email: None,
    }])
    .unwrap();
    assert!(s.save("companies", None, &m(json!({"name": "x", "owner_id": OTHER}))).is_err());
    assert!(s.save("companies", None, &m(json!({"name": "x", "owner_id": ME}))).is_ok());
}

#[test]
fn role_permissions_are_checked_before_writing() {
    let (_d, s) = open();
    let theirs = s.save("companies", None, &m(json!({"name": "Чужая"}))).unwrap();
    s.conn().execute("UPDATE companies SET created_by=?1", [OTHER]).unwrap();
    s.set_permissions(&["records.view".into(), "records.create".into(), "records.edit_own".into()]).unwrap();
    let mine = s.save("companies", None, &m(json!({"name": "Моя"}))).unwrap();
    assert!(s.save("companies", Some(&id(&mine)), &m(json!({"name": "Моя 2"}))).is_ok());
    assert!(s.save("companies", Some(&id(&theirs)), &m(json!({"name": "Взлом"}))).unwrap_err().to_string().contains("прав"));
    assert!(s.delete("companies", &id(&mine)).is_err(), "удаление — отдельное право");
    assert!(s.save("pipelines", None, &m(json!({"name": "Своя"}))).is_err());
    assert!(s.save("collections", None, &m(json!({"name": "Общая", "entity_type": "company", "visibility": "workspace"}))).is_err());
    assert!(s.save("collections", None, &m(json!({"name": "Личная", "entity_type": "company"}))).is_ok());
    s.set_permissions(&["records.view".into()]).unwrap();
    assert!(s.save("companies", None, &m(json!({"name": "Наблюдатель"}))).is_err());
}

#[test]
fn deals_follow_stage_kind_and_keep_history() {
    let (_d, s) = open();
    s.seed_local().unwrap();
    let (pipeline, first) = s.first_stage(None).unwrap();
    let stages = s.list("pipeline_stages", &Query::default()).unwrap();
    assert_eq!(stages.len(), 7);
    let won = stages.iter().find(|x| x["kind"] == "won").unwrap();
    let lost = stages.iter().find(|x| x["kind"] == "lost").unwrap();
    let d = s
        .save("deals", None, &m(json!({"title": "Поставка", "pipeline_id": pipeline, "stage_id": first, "amount": 1500.555, "lost_reason": "дорого"})))
        .unwrap();
    assert_eq!((d["status"].as_str(), d["amount"].as_f64(), d["lost_reason"].is_null()), (Some("open"), Some(1500.56), true));
    let d = s.save("deals", Some(&id(&d)), &m(json!({"stage_id": lost["id"], "lost_reason": "дорого"}))).unwrap();
    assert_eq!(d["status"], "lost");
    assert!(d["closed_at"].is_string());
    let d = s.save("deals", Some(&id(&d)), &m(json!({"stage_id": won["id"]}))).unwrap();
    assert_eq!(d["status"], "won");
    assert!(d["lost_reason"].is_null());
    assert_eq!(s.stage_history(&id(&d)).unwrap().len(), 3);
    // Отчёты читают историю всех сделок; удалённая сделка из неё пропадает.
    let all = s.stage_history_all().unwrap();
    assert_eq!(all.iter().filter(|h| h["deal_id"] == d["id"]).count(), 3);
    assert_eq!(all.last().unwrap()["to_stage_id"], won["id"]);
    assert!(s.save("deals", Some(&id(&d)), &m(json!({"amount": -1}))).is_err());
    // Этап другой воронки не подходит.
    let other = s.save("pipelines", None, &m(json!({"name": "Вторая"}))).unwrap();
    assert!(s.save("deals", None, &m(json!({"title": "x", "pipeline_id": id(&other), "stage_id": first}))).is_err());
    s.delete("deals", &id(&d)).unwrap();
    assert!(s.stage_history_all().unwrap().iter().all(|h| h["deal_id"] != d["id"]));
}

#[test]
fn tasks_completed_at_and_overdue_collection() {
    let (_d, s) = open();
    s.seed_local().unwrap();
    let t = s.save("tasks", None, &m(json!({"title": "Позвонить", "due_at": "2020-01-01T10:00:00Z", "assignee_id": ME}))).unwrap();
    s.save("tasks", None, &m(json!({"title": "Потом", "due_at": "2999-01-01T10:00:00Z"}))).unwrap();
    let overdue = s.list("collections", &Query { filters: vec![Filter::eq("name", "Просроченные задачи")], ..Default::default() }).unwrap();
    let q = Query::from_config(&overdue[0]["config"]);
    assert_eq!(s.list("tasks", &q).unwrap().len(), 1);
    let done = s.save("tasks", Some(&id(&t)), &m(json!({"status": "done"}))).unwrap();
    assert!(done["completed_at"].is_string());
    assert_eq!(s.list("tasks", &q).unwrap().len(), 0, "выполненная задача не просрочена");
    let back = s.save("tasks", Some(&id(&t)), &m(json!({"status": "todo"}))).unwrap();
    assert!(back["completed_at"].is_null());
}

#[test]
fn soft_delete_restore_and_edit_of_deleted() {
    let (_d, s) = open();
    let c = s.save("companies", None, &m(json!({"name": "Удаляемая"}))).unwrap();
    s.delete("companies", &id(&c)).unwrap();
    assert!(s.list("companies", &Query::default()).unwrap().is_empty());
    assert_eq!(s.list("companies", &Query { deleted: true, ..Default::default() }).unwrap().len(), 1);
    assert!(s.save("companies", Some(&id(&c)), &m(json!({"name": "Воскрешение"}))).is_err());
    s.restore("companies", &id(&c)).unwrap();
    let kinds: Vec<String> = s.pending_ops(10).unwrap().into_iter().map(|o| o.kind).collect();
    assert_eq!(kinds, ["upsert", "delete", "restore"]);
}

#[test]
fn remote_rows_do_not_overwrite_pending_local_fields() {
    let (_d, s) = open();
    let c = s.save("companies", None, &m(json!({"name": "Локальное", "industry": "IT"}))).unwrap();
    let rid = id(&c);
    let server = json!({"id": rid, "workspace_id": WS, "created_by": OTHER, "created_at": "2026-11-01T10:00:00Z", "updated_by": OTHER,
                        "updated_at": "2026-11-01T10:00:00Z", "version": 4, "field_ts": {"name": "2026-11-01T10:00:00Z"}, "field_ver": {},
                        "server_seq": 77, "name": "С сервера", "industry": "Ритейл", "phones": [], "emails": [], "dedupe_keys": []});
    s.apply_remote("companies", &[server.clone()]).unwrap();
    let got = s.get("companies", &rid).unwrap().unwrap();
    assert_eq!((got["name"].as_str(), got["industry"].as_str(), got["version"].as_i64()), (Some("Локальное"), Some("IT"), Some(4)));
    assert_eq!(got["sync_state"], "pending");
    assert_eq!(s.cursor("companies"), 77);
    // Строка чужого Workspace не попадает в базу.
    let mut foreign = server.clone();
    foreign["id"] = json!(uuid::Uuid::new_v4().to_string());
    foreign["workspace_id"] = json!(OTHER);
    s.apply_remote("companies", &[foreign.clone()]).unwrap();
    assert!(s.get("companies", foreign["id"].as_str().unwrap()).unwrap().is_none());
    // После ответа сервера очередь пуста, а следующая загрузка применяет серверные значения.
    let op = s.pending_ops(1).unwrap().remove(0);
    s.apply_result(&json!({"op_id": op.op_id, "status": "applied", "version": 5})).unwrap();
    assert_eq!(s.pending_count(), 0);
    assert_eq!(s.get("companies", &rid).unwrap().unwrap()["sync_state"], "synced");
    s.apply_remote("companies", &[server]).unwrap();
    assert_eq!(s.get("companies", &rid).unwrap().unwrap()["name"], "С сервера");
}

#[test]
fn rejected_operations_are_kept_for_the_user_and_refetched() {
    let (_d, s) = open();
    let c = s.save("companies", None, &m(json!({"name": "Нельзя"}))).unwrap();
    let op = s.pending_ops(1).unwrap().remove(0);
    let refetch = s.apply_result(&json!({"op_id": op.op_id, "status": "rejected", "error": "permission denied"})).unwrap();
    assert_eq!(refetch, Some(("companies".into(), id(&c))));
    assert_eq!(s.pending_count(), 0);
    assert_eq!(s.rejected_ops().unwrap().len(), 1);
    assert_eq!(s.get("companies", &id(&c)).unwrap().unwrap()["sync_state"], "rejected");
    s.forget("companies", &id(&c)).unwrap();
    assert!(s.get("companies", &id(&c)).unwrap().is_none());
    assert!(s.rejected_ops().unwrap().is_empty());
}

#[test]
fn postponed_operations_wait_and_retry_now_releases_them() {
    let (_d, s) = open();
    s.save("companies", None, &m(json!({"name": "Офлайн"}))).unwrap();
    let ops = s.pending_ops(10).unwrap();
    s.mark_sending(&ops).unwrap();
    s.postpone(&ops, "нет связи").unwrap();
    assert!(s.pending_ops(10).unwrap().is_empty());
    assert_eq!(s.pending_count(), 1);
    s.retry_now().unwrap();
    assert_eq!(s.pending_ops(10).unwrap()[0].op_id, ops[0].op_id, "повтор — с тем же op_id");
}

#[test]
fn search_filters_and_collections_run_locally() {
    let (_d, s) = open();
    s.seed_local().unwrap();
    let mine = s.save("companies", None, &m(json!({"name": "Альфа", "owner_id": ME, "emails": ["a@alfa.ru"]}))).unwrap();
    s.save("companies", None, &m(json!({"name": "Бета"}))).unwrap();
    let q = Query { search: Some("ALFA.ru".into()), ..Default::default() };
    assert_eq!(s.list("companies", &q).unwrap().len(), 1);
    let my = s.list("collections", &Query { filters: vec![Filter::eq("name", "Мои клиенты")], ..Default::default() }).unwrap();
    let got = s.list("companies", &Query::from_config(&my[0]["config"])).unwrap();
    assert_eq!(got.iter().map(id).collect::<Vec<_>>(), [id(&mine)]);
    assert_eq!(s.count("companies", &Query::default()).unwrap(), 2);
    assert_eq!(s.list("collections", &Query::default()).unwrap().len(), 7);
}

#[test]
fn duplicates_are_found_before_saving() {
    let (_d, s) = open();
    let a = s.save("companies", None, &m(json!({"name": "ООО «Ромашка»", "website": "https://romashka.ru"}))).unwrap();
    let keys = super::dedupe::keys("companies", &m(json!({"name": "Ромашка", "website": "www.romashka.ru/about"})));
    let found = s.duplicates("companies", &keys, None).unwrap();
    assert_eq!(found.iter().map(id).collect::<Vec<_>>(), [id(&a)]);
    assert!(s.duplicates("companies", &keys, Some(&id(&a))).unwrap().is_empty());
}

fn lead(kind: LeadKind) -> LeadItem {
    let mut d = LeadData::new(kind, "fl_ru", "ext-1", "Сайт для пекарни");
    d.customer_name = Some("Иван Петров".into());
    d.website = Some("https://bakery.ru".into());
    d.budget = Some(50000.0);
    d.contacts.insert("email".into(), "ivan@bakery.ru".into());
    d.contacts.insert("telegram".into(), "@ivan".into());
    d.phone = Some("+7 999 000 11 22".into());
    LeadItem {
        id: "lead-1".into(),
        data: d,
        discovered_at: Utc::now(),
        favorite: false,
        archived: false,
        excluded: false,
        seen: false,
        note: "Перезвонить в среду".into(),
    }
}

#[test]
fn convert_lead_is_idempotent_and_reuses_records() {
    let (_d, s) = open();
    s.seed_local().unwrap();
    let l = lead(LeadKind::Order);
    let first = convert_lead(&s, &l, &ConvertOptions { create_deal: true, ..Default::default() }).unwrap();
    assert!(!first.reused_company && first.contact_id.is_some() && first.deal_id.is_some());
    let company = s.get("companies", &first.company_id).unwrap().unwrap();
    assert_eq!(
        (company["name"].as_str(), company["source"].as_str(), company["source_lead_id"].as_str()),
        (Some("Иван Петров"), Some("leadgen:fl_ru"), Some("lead-1"))
    );
    let contact = s.get("contacts", first.contact_id.as_deref().unwrap()).unwrap().unwrap();
    assert_eq!(contact["full_name"], "Иван Петров");
    assert_eq!(contact["messengers"]["telegram"], "@ivan");
    let deal = s.get("deals", first.deal_id.as_deref().unwrap()).unwrap().unwrap();
    assert_eq!(deal["amount"], 50000.0);
    assert!(s.get("deal_contacts", &deal_contact_id(&id(&deal), first.contact_id.as_deref().unwrap())).unwrap().is_some());
    assert_eq!(s.linked("notes", "company", &first.company_id).unwrap().len(), 1);
    let again = convert_lead(&s, &l, &ConvertOptions { create_deal: true, ..Default::default() }).unwrap();
    assert_eq!(
        (again.company_id.clone(), again.contact_id.clone(), again.deal_id.clone()),
        (first.company_id.clone(), first.contact_id.clone(), first.deal_id.clone())
    );
    assert!(again.reused_company && again.reused_contact);
    assert_eq!(s.count("companies", &Query::default()).unwrap(), 1);
    assert_eq!(s.linked("activities", "company", &first.company_id).unwrap().len(), 1);
    // Другой лид той же компании (тот же сайт) находит её по ключам дедупликации.
    let mut other = lead(LeadKind::Organization);
    other.id = "lead-2".into();
    other.data.title = "Пекарня «Хлеб»".into();
    let third = convert_lead(&s, &other, &ConvertOptions::default()).unwrap();
    assert_eq!(third.company_id, first.company_id);
    assert!(third.reused_company && third.contact_id.is_none());
}

#[test]
fn encrypted_database_needs_the_key_and_belongs_to_one_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("enc.db");
    let key = crate::db::DbKey::Raw("07".repeat(32));
    {
        let s = WorkspaceStore::open(&path, Some(&key), WS, ME).unwrap();
        s.save("companies", None, &m(json!({"name": "Секрет"}))).unwrap();
    }
    assert!(!std::fs::read(&path).unwrap().windows(12).any(|w| w == "Секрет".as_bytes()));
    assert!(WorkspaceStore::open(&path, Some(&crate::db::DbKey::Raw("08".repeat(32))), WS, ME).is_err());
    assert!(WorkspaceStore::open(&path, Some(&key), OTHER, ME).is_err());
    let s = WorkspaceStore::open(&path, Some(&key), WS, ME).unwrap();
    assert_eq!(s.count("companies", &Query::default()).unwrap(), 1);
}

#[test]
fn custom_fields_need_fields_manage_and_values_link_to_a_card() {
    let (_d, s) = open();
    let c = s.save("companies", None, &m(json!({"name": "Ромашка"}))).unwrap();
    s.set_permissions(&["records.view".into(), "records.create".into(), "records.edit".into(), "pipelines.manage".into()]).unwrap();
    assert!(s.save("custom_fields", None, &m(json!({"entity_type": "company", "label": "Сегмент"}))).unwrap_err().to_string().contains("прав"));
    s.set_permissions(&["records.view".into(), "records.create".into(), "records.edit".into(), "fields.manage".into()]).unwrap();
    let f = s.save("custom_fields", None, &m(json!({"entity_type": "company", "label": "Сегмент", "kind": "select", "options": ["A", "B"]}))).unwrap();
    assert!(s.save("custom_fields", None, &m(json!({"entity_type": "task", "label": "x"}))).is_err(), "тип записи — из списка");
    assert!(s.save("custom_fields", None, &m(json!({"entity_type": "company", "label": "x", "kind": "color"}))).is_err());
    let v = s.save("custom_field_values", None, &m(json!({"field_id": id(&f), "entity_type": "company", "entity_id": id(&c), "value": "A"}))).unwrap();
    assert_eq!(s.linked("custom_field_values", "company", &id(&c)).unwrap().len(), 1);
    s.save("custom_field_values", Some(&id(&v)), &m(json!({"value": null}))).unwrap();
    assert!(
        s.save(
            "custom_field_values",
            None,
            &m(json!({"field_id": "99999999-9999-4999-8999-999999999999", "entity_type": "company", "entity_id": id(&c), "value": "A"}))
        )
        .is_err(),
        "поле должно существовать"
    );
}

#[test]
fn attachments_keep_metadata_in_the_card_and_files_in_the_database() {
    let (_d, s) = open();
    let c = s.save("companies", None, &m(json!({"name": "Ромашка"}))).unwrap();
    let a = s
        .save("attachments", None, &m(json!({"entity_type": "company", "entity_id": id(&c), "name": "договор.pdf", "mime": "application/pdf", "size": 4})))
        .unwrap();
    s.put_blob(&id(&a), b"%PDF", false).unwrap();
    assert_eq!(s.blob(&id(&a)).unwrap(), b"%PDF");
    assert_eq!(s.linked("attachments", "company", &id(&c)).unwrap().len(), 1);
    assert!(s.blobs_to_upload().is_empty(), "пока сервер не принял метаданные, файл не уходит");
    s.conn().execute("UPDATE attachments SET sync_state='synced'", []).unwrap();
    s.conn().execute("DELETE FROM sync_outbox", []).unwrap();
    assert_eq!(s.blobs_to_upload().len(), 1);
    s.mark_blob_uploaded(&id(&a)).unwrap();
    assert!(s.blobs_to_upload().is_empty());
}
