//! Сквозной тест клиента на локальном стенде Supabase (supabase/tests/stack/up.sh): настоящий Supabase Auth,
//! PostgREST, RLS и функции писем. Без переменных LG_STACK_URL, LG_STACK_ANON и LG_STACK_MAIL тесты пропускаются.

use customers_lib::cloud::auth::{CloudAuth, MemorySessionStore};
use customers_lib::cloud::config::CloudConfig;
use customers_lib::cloud::error::CloudError;
use customers_lib::cloud::sync::SyncEngine;
use customers_lib::models::{ExclusionKind, LeadData, LeadKind};
use customers_lib::search::http::ReqwestTransport;
use customers_lib::store::LeadStore;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct Stack {
    config: CloudConfig,
    mail: PathBuf,
    dir: tempfile::TempDir,
}

fn stack() -> Option<Stack> {
    let url = std::env::var("LG_STACK_URL").ok()?;
    let anon = std::env::var("LG_STACK_ANON").ok()?;
    let mail = std::env::var("LG_STACK_MAIL").ok()?;
    Some(Stack { config: CloudConfig::new(&url, &anon)?, mail: PathBuf::from(mail), dir: tempfile::tempdir().unwrap() })
}

fn unique(prefix: &str) -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    format!("{prefix}-{:x}@example.com", n & 0xffff_ffff_ffff)
}

impl Stack {
    /// Шестизначный код из последнего письма на адрес.
    async fn code(&self, email: &str) -> String {
        for _ in 0..100 {
            let mut files: Vec<_> = std::fs::read_dir(&self.mail).map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default();
            files.sort();
            files.reverse();
            for f in files.into_iter().filter(|f| f.extension().is_some_and(|e| e == "json")) {
                let Ok(text) = std::fs::read_to_string(&f) else { continue };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                let to_me = v["to"].as_array().is_some_and(|a| a.iter().any(|x| x == email));
                let body = v["text"].as_str().unwrap_or("");
                if let (true, Some(i)) = (to_me, body.find("Код: ")) {
                    return body[i + "Код: ".len()..].chars().take(6).collect();
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("письмо для {email} не найдено");
    }

    fn device(&self, name: &str) -> (Arc<CloudAuth>, Arc<Mutex<LeadStore>>, SyncEngine) {
        let mut store = LeadStore::open(&self.dir.path().join(format!("{name}.db")), None).unwrap();
        store.enable_sync_tracking().unwrap();
        let store = Arc::new(Mutex::new(store));
        let auth = Arc::new(CloudAuth::new(
            self.config.clone(),
            Arc::new(ReqwestTransport::new()),
            Arc::new(MemorySessionStore::default()),
            format!("device-{name}-{}", unique("d")),
        ));
        let engine = SyncEngine::new(auth.clone(), store.clone(), name.to_string()).with_sizes(50, 100);
        (auth, store, engine)
    }
}

fn lead(title: &str) -> LeadData {
    LeadData::new(LeadKind::Order, "fl_ru", title, title)
}

#[tokio::test]
async fn two_devices_sync_through_real_server() {
    let Some(stack) = stack() else {
        eprintln!("локальный стенд не задан, тест пропущен");
        return;
    };
    let email = unique("rust");
    let password = "Str0ngPassw0rd";
    let (auth_a, store_a, sync_a) = stack.device("a");
    auth_a.sign_up(&email, password).await.unwrap();
    assert_eq!(auth_a.sign_in(&email, password).await.unwrap_err(), CloudError::EmailNotConfirmed, "вход до подтверждения");
    auth_a.verify(&email, &stack.code(&email).await, "signup").await.unwrap();
    assert_eq!(auth_a.user().unwrap().email, email);

    // Устройство A: 120 лидов (несколько пачек), исключение, настройка.
    {
        let s = store_a.lock().unwrap();
        for i in 0..120 {
            s.save(&lead(&format!("Заказ {i}")), &format!("L{i}"), &format!("fp{i}")).unwrap();
        }
        s.add_exclusion(ExclusionKind::Domain, "competitor.ru").unwrap();
        s.set_synced_value("draft.signature", "\"Максим\"").unwrap();
    }
    let r1 = sync_a.sync().await.unwrap();
    assert_eq!(r1.pushed, 122);
    assert!(store_a.lock().unwrap().pending_changes(10).unwrap().is_empty());

    // Устройство B: вход на новом компьютере, всё загружается.
    let (auth_b, store_b, sync_b) = stack.device("b");
    auth_b.sign_in(&email, password).await.unwrap();
    let r2 = sync_b.sync().await.unwrap();
    assert!(r2.pulled >= 122);
    {
        let s = store_b.lock().unwrap();
        assert_eq!(s.all_leads(false).unwrap().len(), 120);
        assert_eq!(s.exclusions().unwrap().iter().map(|e| e.value.clone()).collect::<Vec<_>>(), vec!["competitor.ru"]);
        assert_eq!(s.value("draft.signature").as_deref(), Some("\"Максим\""));
        assert!(s.pending_changes(10).unwrap().is_empty(), "загруженное не уходит обратно");
    }

    // Одновременные изменения разных полей на двух устройствах сохраняются оба.
    store_a.lock().unwrap().set_favorite(&["L1".to_string()], true).unwrap();
    {
        let s = store_b.lock().unwrap();
        s.set_note("L1", "позвонить в понедельник").unwrap();
        s.delete(&["L2".to_string()]).unwrap();
    }
    sync_a.sync().await.unwrap();
    sync_b.sync().await.unwrap();
    sync_a.sync().await.unwrap();
    for store in [&store_a, &store_b] {
        let s = store.lock().unwrap();
        let all = s.all_leads(true).unwrap();
        let l1 = all.iter().find(|l| l.id == "L1").unwrap();
        assert!(l1.favorite);
        assert_eq!(l1.note, "позвонить в понедельник");
        assert!(!s.all_leads(false).unwrap().iter().any(|l| l.id == "L2"));
    }
    // Повторная синхронизация без изменений ничего не гоняет.
    let idle = sync_a.sync().await.unwrap();
    assert_eq!((idle.pushed, idle.pulled), (0, 0));

    let stats = sync_b.remote_stats().await.unwrap();
    assert_eq!(stats["leads"], 120);
    assert_eq!(stats["leads_active"], 119);

    // Выход: сессия удалена, запросы к данным больше не проходят.
    auth_b.sign_out().await;
    assert_eq!(sync_b.sync().await.unwrap_err(), CloudError::SessionExpired);

    // Чужой пользователь не видит этих данных.
    let other = unique("rust-other");
    let (auth_c, store_c, sync_c) = stack.device("c");
    auth_c.sign_up(&other, password).await.unwrap();
    auth_c.verify(&other, &stack.code(&other).await, "signup").await.unwrap();
    sync_c.sync().await.unwrap();
    assert!(store_c.lock().unwrap().all_leads(true).unwrap().is_empty());
}

#[tokio::test]
async fn mail_limit_message_reaches_user() {
    let Some(stack) = stack() else {
        eprintln!("локальный стенд не задан, тест пропущен");
        return;
    };
    let (auth, _, _) = stack.device("limit");
    let email = unique("rust-limit");
    auth.sign_up(&email, "Str0ngPassw0rd").await.unwrap();
    match auth.resend_confirmation(&email).await {
        Err(CloudError::RateLimited(m)) => assert!(m.contains("Повторите через"), "{m}"),
        other => panic!("повтор раньше 15 минут должен быть отклонён, получено {other:?}"),
    }
}

// ---------------------------------------------------------------- Customers 2.0: Workspace и CRM

use customers_lib::workspace::query::{Filter, Query};
use customers_lib::workspace::store::WorkspaceStore;
use customers_lib::workspace::sync::{self as crm_sync, CrmSync};
use serde_json::{json, Map, Value};

fn fields(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

impl Stack {
    async fn user(&self, name: &str) -> (Arc<CloudAuth>, String) {
        let email = unique(name);
        let (auth, _, _) = self.device(name);
        auth.sign_up(&email, "Str0ngPassw0rd").await.unwrap();
        auth.verify(&email, &self.code(&email).await, "signup").await.unwrap();
        (auth, email)
    }

    /// Локальная база Workspace пользователя, как её открывает приложение: права и участники с сервера.
    async fn crm(&self, auth: &Arc<CloudAuth>, workspace: &str, perms: Option<Vec<String>>) -> (Arc<Mutex<WorkspaceStore>>, CrmSync) {
        let me = auth.user().unwrap().id;
        let info = crm_sync::workspaces(auth).await.unwrap().into_iter().find(|w| w.id == workspace).expect("Workspace в списке");
        let members = crm_sync::members(auth, workspace).await.unwrap();
        let path = self.dir.path().join(format!("{me}-{workspace}.db"));
        let store = WorkspaceStore::open(&path, None, workspace, &me).unwrap();
        store.set_permissions(&perms.unwrap_or(info.permissions)).unwrap();
        store.replace_members(&members).unwrap();
        let store = Arc::new(Mutex::new(store));
        let sync = CrmSync::new(auth.clone(), store.clone(), format!("dev-{me}"));
        (store, sync)
    }
}

#[tokio::test]
async fn workspace_crm_sync_rights_and_conflicts() {
    let Some(stack) = stack() else {
        eprintln!("локальный стенд не задан, тест пропущен");
        return;
    };
    // Владелец: личный Workspace создаётся при первом входе, шаблон воронки и коллекций приходит с сервера.
    let (owner, _) = stack.user("crm-owner").await;
    let ws = crm_sync::workspaces(&owner).await.unwrap();
    assert_eq!(ws.len(), 1);
    let wid = ws[0].id.clone();
    assert!(ws[0].personal && ws[0].role == "owner");
    let (store_a, sync_a) = stack.crm(&owner, &wid, None).await;
    sync_a.sync().await.unwrap();
    let stages = store_a.lock().unwrap().list("pipeline_stages", &Query::default()).unwrap();
    assert_eq!(stages.len(), 7);
    assert_eq!(store_a.lock().unwrap().list("collections", &Query::default()).unwrap().len(), 7);

    // Компания и сделка с устройства владельца уходят на сервер одной синхронизацией.
    let company = store_a.lock().unwrap().save("companies", None, &fields(json!({"name": "ООО «Альфа»", "phones": ["+7 900 000-00-01"]}))).unwrap();
    let cid = company["id"].as_str().unwrap().to_string();
    let open = stages.iter().find(|s| s["kind"] == "open").unwrap();
    let won = stages.iter().find(|s| s["kind"] == "won").unwrap();
    let deal = store_a
        .lock()
        .unwrap()
        .save("deals", None, &fields(json!({"title": "Сайт", "pipeline_id": open["pipeline_id"], "stage_id": open["id"], "company_id": cid, "amount": 100000})))
        .unwrap();
    let did = deal["id"].as_str().unwrap().to_string();
    let r = sync_a.sync().await.unwrap();
    assert_eq!((r.pushed, r.rejected, r.conflicts), (2, 0, 0));
    assert_eq!(store_a.lock().unwrap().pending_count(), 0);

    // Приглашение сотрудника: токен один раз, принятие добавляет в участники.
    let (worker, worker_email) = stack.user("crm-worker").await;
    let invite = crm_sync::rpc(&owner, "invite_member", json!({"p_workspace": wid, "p_email": worker_email, "p_role": "employee"})).await.unwrap();
    assert!(crm_sync::rpc(&owner, "accept_invitation", json!({"p_token": invite["token"]})).await.is_err(), "приглашение на чужую почту");
    let joined = crm_sync::rpc(&worker, "accept_invitation", json!({"p_token": invite["token"]})).await.unwrap();
    assert_eq!(joined.as_str(), Some(wid.as_str()));
    assert!(crm_sync::rpc(&worker, "accept_invitation", json!({"p_token": invite["token"]})).await.is_err(), "токен одноразовый");

    // Сотрудник видит данные Workspace. Его устройство ещё думает, что может править всё (права устарели) —
    // сервер отклоняет правку чужой компании, локальная копия перечитывается.
    let all: Vec<String> = ws[0].permissions.clone();
    let (store_b, sync_b) = stack.crm(&worker, &wid, Some(all)).await;
    sync_b.sync().await.unwrap();
    assert_eq!(store_b.lock().unwrap().get("companies", &cid).unwrap().unwrap()["name"], "ООО «Альфа»");
    store_b.lock().unwrap().save("companies", Some(&cid), &fields(json!({"name": "Взлом"}))).unwrap();
    let r = sync_b.sync().await.unwrap();
    assert_eq!(r.rejected, 1);
    assert_eq!(store_b.lock().unwrap().get("companies", &cid).unwrap().unwrap()["name"], "ООО «Альфа»");
    assert_eq!(store_b.lock().unwrap().rejected_ops().unwrap().len(), 1);

    // Своя запись сотрудника; правка одного поля на двух устройствах: позднее по времени правки побеждает,
    // проигравшая сохраняется в конфликтах у того, чью правку не применили.
    let own = store_b.lock().unwrap().save("contacts", None, &fields(json!({"first_name": "Ольга", "company_id": cid}))).unwrap();
    let oid = own["id"].as_str().unwrap().to_string();
    sync_b.sync().await.unwrap();
    sync_a.sync().await.unwrap();
    store_b.lock().unwrap().save("contacts", Some(&oid), &fields(json!({"position": "Директор"}))).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    store_a.lock().unwrap().save("contacts", Some(&oid), &fields(json!({"position": "Закупки"}))).unwrap();
    sync_a.sync().await.unwrap();
    let r = sync_b.sync().await.unwrap();
    assert_eq!(r.conflicts, 1);
    assert_eq!(store_b.lock().unwrap().get("contacts", &oid).unwrap().unwrap()["position"], "Закупки");
    let conflicts = store_b.lock().unwrap().conflicts().unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!((conflicts[0]["field"].as_str(), conflicts[0]["lost"].as_str()), (Some("position"), Some("Директор")));

    // Этап сделки: статус и история этапов считает сервер, другое устройство получает их при загрузке.
    store_a.lock().unwrap().save("deals", Some(&did), &fields(json!({"stage_id": won["id"]}))).unwrap();
    sync_a.sync().await.unwrap();
    sync_b.sync().await.unwrap();
    let d = store_b.lock().unwrap().get("deals", &did).unwrap().unwrap();
    assert_eq!(d["status"], "won");
    assert!(d["closed_at"].is_string());
    // История: создание на первом этапе и переход на «Успех».
    let history = store_b.lock().unwrap().stage_history(&did).unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!((history[0]["from_stage_id"].is_null(), &history[1]["to_stage_id"]), (true, &won["id"]));

    // Удаление владельцем: у сотрудника запись уходит в корзину, а не пропадает молча.
    store_a.lock().unwrap().delete("deals", &did).unwrap();
    sync_a.sync().await.unwrap();
    sync_b.sync().await.unwrap();
    let q = Query { filters: vec![Filter::eq("title", "Сайт")], ..Default::default() };
    assert!(store_b.lock().unwrap().list("deals", &q).unwrap().is_empty());
    assert!(store_b.lock().unwrap().get("deals", &did).unwrap().unwrap()["deleted_at"].is_string());

    // Исключённый участник теряет доступ: чтение ничего не отдаёт, отправка отвечает «не участник»,
    // а Workspace пропадает из его списка (по этому приложение удаляет локальную копию).
    let worker_id = worker.user().unwrap().id;
    crm_sync::rpc(&owner, "remove_member", json!({"p_workspace": wid, "p_user": worker_id})).await.unwrap();
    store_b.lock().unwrap().save("contacts", Some(&oid), &fields(json!({"last_name": "Иванова"}))).unwrap();
    let err = sync_b.sync().await.unwrap_err();
    assert!(crm_sync::is_not_member(&err), "{err:?}");
    assert!(crm_sync::workspaces(&worker).await.unwrap().iter().all(|w| w.id != wid));

    // Повторная синхронизация владельца без изменений ничего не гоняет.
    let idle = sync_a.sync().await.unwrap();
    assert_eq!((idle.pushed, idle.pulled), (0, 0));
}
