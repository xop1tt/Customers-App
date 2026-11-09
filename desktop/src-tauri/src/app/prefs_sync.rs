//! Настройки, которые следуют за облачной учётной записью на все компьютеры.
//!
//! Три группы. Параметры учётной записи (уведомления, звонки, копии) лежат под ключом `account.prefs`,
//! внешний вид и боковая панель — под `interface.prefs`, подпись писем — под `draft.signature`.
//! Всё, что привязано к компьютеру (пути, почтовый ящик с паролем, масштаб, окно, трей, обновления),
//! остаётся на месте. Конфликты решает время изменения всего ключа: побеждает последнее.
//! Значения, пришедшие из облака, применяются мимо журнала, поэтому «эхо» не возникает.

use super::session::{Core, Session};
use crate::store::LeadStore;
use serde_json::{json, Map, Value};
use std::sync::Arc;

pub const ACCOUNT_KEY: &str = "account.prefs";
pub const INTERFACE_KEY: &str = "interface.prefs";
pub const SIGNATURE_KEY: &str = "draft.signature";

/// Поля `AccountPrefs`, которые синхронизируются (автопоиск и подпись ходят под своими ключами).
pub const ACCOUNT_FIELDS: [&str; 8] = ["notifyNewLeads", "notifyErrors", "notifySync", "confirmCalls", "callApp", "autoBackup", "keepBackups", "welcomeDone"];

/// Поля `DevicePrefs`, которые синхронизируются: оформление и боковая панель.
pub const INTERFACE_FIELDS: [&str; 12] = [
    "accent",
    "compactRows",
    "animations",
    "sidebarHidden",
    "sidebarHiddenSources",
    "sidebarOrder",
    "sidebarSourceOrder",
    "sidebarCounts",
    "sidebarSources",
    "sidebarHover",
    "listSort",
    "listSortDescending",
];

/// Только перечисленные поля объекта.
pub fn pick(value: &Value, fields: &[&str]) -> Value {
    let mut out = Map::new();
    if let Some(o) = value.as_object() {
        for f in fields {
            if let Some(v) = o.get(*f) {
                out.insert((*f).to_string(), v.clone());
            }
        }
    }
    Value::Object(out)
}

fn touches(changes: &Value, fields: &[&str]) -> bool {
    changes.as_object().is_some_and(|o| fields.iter().any(|f| o.contains_key(*f)))
}

fn stored_object(store: &LeadStore, key: &str) -> Option<Value> {
    store.value(key).and_then(|t| serde_json::from_str::<Value>(&t).ok()).filter(Value::is_object)
}

impl Core {
    /// Вызывается после изменения настроек учётной записи: ушедшие в облако поля записываются в журнал.
    pub(crate) fn push_account_prefs(self: &Arc<Self>, s: &Arc<Session>, changes: &Value) {
        let prefs = s.prefs.lock().unwrap().to_json();
        let mut any = false;
        if touches(changes, &ACCOUNT_FIELDS) {
            let text = pick(&prefs, &ACCOUNT_FIELDS).to_string();
            any |= s.with_store(|st| st.set_synced_value(ACCOUNT_KEY, &text)).is_ok();
        }
        if touches(changes, &["signature"]) {
            let text = serde_json::to_string(prefs.get("signature").and_then(Value::as_str).unwrap_or("")).unwrap_or_default();
            any |= s.with_store(|st| st.set_synced_value(SIGNATURE_KEY, &text)).is_ok();
        }
        if any {
            self.sync_soon(s);
        }
    }

    /// Вызывается после изменения настроек этого компьютера: оформление и панель уходят в облако.
    pub fn push_interface_prefs(self: &Arc<Self>, changes: &Value) {
        let Some(s) = self.session().filter(|s| s.is_cloud) else { return };
        if !touches(changes, &INTERFACE_FIELDS) {
            return;
        }
        let device = self.env.device.lock().unwrap().to_json();
        let text = pick(&device, &INTERFACE_FIELDS).to_string();
        if s.with_store(|st| st.set_synced_value(INTERFACE_KEY, &text)).is_ok() {
            self.sync_soon(&s);
        }
    }

    /// Применяет сохранённые в базе значения (после входа и после загрузки из облака). Возвращает true, если что-то изменилось.
    pub(crate) fn apply_synced_prefs(&self, s: &Session) -> bool {
        let (account, interface, signature) = s.with_store(|st| {
            (stored_object(st, ACCOUNT_KEY), stored_object(st, INTERFACE_KEY), st.value(SIGNATURE_KEY).and_then(|t| serde_json::from_str::<String>(&t).ok()))
        });
        let mut changed = false;
        if account.is_some() || signature.is_some() {
            let mut patch = account.map(|a| pick(&a, &ACCOUNT_FIELDS)).unwrap_or_else(|| json!({}));
            if let (Some(sig), Some(o)) = (signature, patch.as_object_mut()) {
                o.insert("signature".into(), json!(sig));
            }
            if s.prefs.lock().unwrap().patch(&patch) {
                self.env.emit("account-prefs", s.prefs.lock().unwrap().to_json());
                changed = true;
            }
        }
        if let Some(i) = interface {
            if s.is_cloud && self.env.patch_device(&pick(&i, &INTERFACE_FIELDS)) {
                changed = true;
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::fixture;
    use super::*;
    use crate::cloud::types::RemoteSetting;
    use crate::search::http::HttpResponse;

    fn password() -> String {
        ["Pass", "word", "-1"].concat()
    }

    async fn cloud_core(id: &str) -> (super::super::testing::Fixture, Arc<Core>) {
        let session = format!(
            r#"{{"access_token":"AT","refresh_token":"RT","expires_in":3600,"user":{{"id":"{id}","email":"me@example.com","email_confirmed_at":"2026-11-05T00:00:00Z"}}}}"#
        );
        let f = fixture(true, vec![Ok(HttpResponse::new(200, session))]);
        let core = Core::new(f.env.clone());
        core.cloud_sign_in("me@example.com", &password()).await.unwrap();
        (f, core)
    }

    fn pushed(core: &Core) -> Vec<(String, Value)> {
        core.session().unwrap().with_store(|st| st.pending_changes(100).unwrap()).settings.into_iter().map(|c| (c.key, c.value)).collect()
    }

    /// Всё, что помечено как синхронизируемое, доходит до второго компьютера без потерь.
    #[tokio::test]
    async fn every_synced_key_travels_between_two_computers() {
        let (_f1, a) = cloud_core("U-1").await;
        let (_f2, b) = cloud_core("U-1").await;
        let values = [
            ("search.settings", r#"{"regions":["Ереван"]}"#.to_string()),
            ("draft.signature", r#""С уважением""#.to_string()),
            ("search.auto", "45".to_string()),
            ("profile.name", r#""Анна К.""#.to_string()),
            ("profile.avatar", format!(r#""data:image/jpeg;base64,{}""#, "A".repeat(50_000))),
            (ACCOUNT_KEY, r#"{"callApp":"telegram"}"#.to_string()),
            (INTERFACE_KEY, r#"{"compactRows":true}"#.to_string()),
        ];
        for k in crate::store::SYNCED_KEYS.iter().chain([ACCOUNT_KEY, INTERFACE_KEY].iter()) {
            assert!(crate::store::SYNCED_KEYS.contains(k), "ключ {k} должен быть в списке синхронизируемых");
        }
        for (k, v) in &values {
            a.session().unwrap().with_store(|st| st.set_synced_value(k, v)).unwrap();
        }
        let out = pushed(&a);
        assert_eq!(out.len(), values.len(), "в журнал попали все ключи");
        let remote: Vec<RemoteSetting> = out
            .into_iter()
            .enumerate()
            .map(|(i, (key, value))| RemoteSetting { key, value, changed_at: "2999-01-01T00:00:00.000Z".into(), server_seq: i as i64 + 1 })
            .collect();
        b.session().unwrap().with_store(|st| st.apply_remote(&[], &[], &remote)).unwrap();
        for (k, v) in &values {
            let got = b.session().unwrap().with_store(|st| st.value(k)).unwrap_or_default();
            assert_eq!(serde_json::from_str::<Value>(&got).unwrap(), serde_json::from_str::<Value>(v).unwrap(), "ключ {k}");
        }
        assert!(pushed(&b).is_empty(), "полученное из облака не уходит обратно");
        b.apply_synced_prefs(&b.session().unwrap());
        assert_eq!(b.info().unwrap().display_name, "Анна К.");
        assert!(b.info().unwrap().avatar.unwrap().starts_with("data:image/jpeg"));
    }

    #[tokio::test]
    async fn account_prefs_and_signature_go_to_the_cloud_and_come_back() {
        let (_f1, a) = cloud_core("U-1").await;
        a.patch_account_prefs(&json!({"callApp": "viber", "notifyErrors": false, "signature": "С уважением, Анна", "backupDirectory": "/private/path"}))
            .unwrap();
        let out = pushed(&a);
        let account = out.iter().find(|(k, _)| k == ACCOUNT_KEY).expect("параметры учётной записи в журнале").1.clone();
        assert_eq!((account["callApp"].clone(), account["notifyErrors"].clone()), (json!("viber"), json!(false)));
        assert!(account.get("backupDirectory").is_none(), "путь к папке относится к компьютеру и не уходит");
        assert!(account.get("mailAccount").is_none(), "почтовый ящик остаётся на компьютере");
        assert_eq!(out.iter().find(|(k, _)| k == SIGNATURE_KEY).unwrap().1, json!("С уважением, Анна"));

        // Второй компьютер получает значения и применяет их к своим настройкам.
        let (_f2, b) = cloud_core("U-1").await;
        let s = b.session().unwrap();
        s.with_store(|st| {
            st.apply_remote(
                &[],
                &[],
                &[
                    RemoteSetting { key: ACCOUNT_KEY.into(), value: account.clone(), changed_at: "2999-01-01T00:00:00.000Z".into(), server_seq: 1 },
                    RemoteSetting {
                        key: SIGNATURE_KEY.into(),
                        value: json!("С уважением, Анна"),
                        changed_at: "2999-01-01T00:00:00.000Z".into(),
                        server_seq: 2,
                    },
                ],
            )
        })
        .unwrap();
        assert!(b.apply_synced_prefs(&s));
        let p = s.account_prefs();
        assert_eq!((p.call_app.as_str(), p.notify_errors, p.signature.as_str()), ("viber", false, "С уважением, Анна"));
        assert!(!b.apply_synced_prefs(&s), "повторное применение ничего не меняет");
        assert!(pushed(&b).is_empty());
    }

    #[tokio::test]
    async fn interface_prefs_sync_only_for_cloud_accounts_and_skip_device_fields() {
        let (_f1, a) = cloud_core("U-1").await;
        let changes = json!({"compactRows": true, "sidebarOrder": ["new", "all"], "uiScale": 1.5, "closeToTray": false});
        a.env.patch_device(&changes);
        a.push_interface_prefs(&changes);
        let out = pushed(&a);
        let ui = out.iter().find(|(k, _)| k == INTERFACE_KEY).expect("оформление в журнале").1.clone();
        assert_eq!(ui["compactRows"], json!(true));
        assert!(ui.get("uiScale").is_none() && ui.get("closeToTray").is_none(), "масштаб и трей — настройки компьютера");

        let f = fixture(false, vec![]);
        let local = Core::new(f.env.clone());
        local.register("anna", &password(), &password(), false).unwrap();
        local.push_interface_prefs(&changes);
        assert!(pushed(&local).is_empty(), "локальная учётная запись ничего не отправляет");
    }
}
