//! Поиск лидов в открытой учётной записи: запуск, остановка, автопоиск по расписанию, настройки источников.

use super::session::{Core, Session};
use super::system::KeepAwake;
use super::CmdResult;
use crate::search::engine::{SearchEngine, SearchOptions, SearchReport, StoreRepo};
use crate::search::settings::{source_problem, SearchSecrets, SearchSettings};
use crate::secrets;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct SearchState {
    pub running: bool,
    pub progress: Option<String>,
    pub cancel: Option<CancellationToken>,
    pub last_report: Option<SearchReport>,
    /// Будит цикл автопоиска, когда меняется интервал.
    pub reschedule: Arc<tokio::sync::Notify>,
}

impl SearchState {
    pub fn cancel(&mut self) {
        if let Some(c) = &self.cancel {
            c.cancel();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchStatus {
    pub running: bool,
    pub progress: Option<String>,
    pub last_report: Option<SearchReport>,
}

impl Session {
    pub fn vk_secret_name(&self) -> String {
        format!("vk.token.{}", self.key())
    }
    pub fn search_status(&self) -> SearchStatus {
        let st = self.search.lock().unwrap();
        SearchStatus { running: st.running, progress: st.progress.clone(), last_report: st.last_report.clone() }
    }
}

impl Core {
    pub fn vk_token(&self, s: &Session) -> String {
        secrets::get_or_empty(self.env.secrets.as_ref(), &s.vk_secret_name())
    }

    /// Сервисный ключ VK — в защищённом хранилище, отдельно для каждого пользователя.
    pub fn set_vk_token(&self, token: &str) -> CmdResult<()> {
        let s = self.require()?;
        secrets::put(self.env.secrets.as_ref(), &s.vk_secret_name(), token.trim())?;
        self.env.emit("search-settings", Value::Null);
        Ok(())
    }

    /// Текущие настройки поиска, ключ VK (есть или нет) и причины, по которым источники не работают.
    pub fn search_overview(&self) -> CmdResult<Value> {
        let s = self.require()?;
        let settings = s.settings.lock().unwrap().clone();
        let problems: serde_json::Map<String, Value> = crate::search::settings::ALL_SOURCES.iter().map(|k| (k.to_string(), self.source_problem(&s, k).map(Value::from).unwrap_or(Value::Null))).collect();
        Ok(json!({"settings": settings, "hasVkToken": !self.vk_token(&s).is_empty(), "problems": problems, "autoSearchMinutes": s.account_prefs().auto_search_minutes}))
    }

    /// Почему источник не может работать, или None.
    pub fn source_problem(&self, s: &Session, source: &str) -> Option<String> {
        let vk = self.vk_token(s);
        let settings = s.settings.lock().unwrap();
        source_problem(source, &settings, &SearchSecrets { vk_token: Some(vk).filter(|v| !v.is_empty()) })
    }

    /// Сохранить настройки источников (хранятся в базе пользователя и синхронизируются).
    pub fn set_search_settings(self: &Arc<Self>, json: &Value) -> CmdResult<()> {
        let s = self.require()?;
        let new = SearchSettings::decode(&json.to_string());
        let changed = {
            let mut cur = s.settings.lock().unwrap();
            if *cur == new {
                false
            } else {
                *cur = new.clone();
                true
            }
        };
        if changed {
            s.with_store(|st| st.set_synced_value("search.settings", &new.encoded()))?;
            self.env.emit("search-settings", Value::Null);
            self.sync_soon(&s);
        }
        Ok(())
    }

    /// Настройки, пришедшие из облака (или сохранённые в базе), — в модель, без повторной выгрузки.
    pub fn reload_synced_settings(&self, s: &Session) {
        let (settings, auto) = s.with_store(|st| (SearchSettings::stored(st.value("search.settings").as_deref()), st.value("search.auto").and_then(|v| v.parse::<u32>().ok())));
        let mut changed = false;
        {
            let mut cur = s.settings.lock().unwrap();
            if *cur != settings {
                *cur = settings;
                changed = true;
            }
        }
        if let Some(v) = auto {
            if s.prefs.lock().unwrap().patch(&json!({"autoSearchMinutes": v})) {
                s.search.lock().unwrap().reschedule.notify_one();
                changed = true;
            }
        }
        if changed {
            self.env.emit("search-settings", Value::Null);
            self.env.emit("account-prefs", s.prefs.lock().unwrap().to_json());
        }
    }

    pub fn reset_source_memory(&self, source: &str) -> CmdResult<()> {
        let s = self.require()?;
        s.with_store(|st| st.reset_source_memory(source))?;
        self.env.emit("data-changed", Value::Null);
        Ok(())
    }

    /// Запуск поиска. `force` — без учёта интервалов источников; `only` — только эти источники.
    pub fn run_search(self: &Arc<Self>, force: bool, only: Option<HashSet<String>>, quiet: bool) -> CmdResult<()> {
        let s = self.require()?;
        self.run_search_for(&s, force, only, quiet);
        Ok(())
    }

    pub(crate) fn run_search_for(self: &Arc<Self>, s: &Arc<Session>, force: bool, only: Option<HashSet<String>>, quiet: bool) {
        let cancel = CancellationToken::new();
        {
            let mut st = s.search.lock().unwrap();
            if st.running {
                return;
            }
            st.running = true;
            st.progress = Some("Подготовка…".into());
            st.cancel = Some(cancel.clone());
        }
        self.env.emit("search-state", serde_json::to_value(s.search_status()).unwrap_or(Value::Null));
        let core = self.clone();
        let session = s.clone();
        tokio::spawn(async move {
            let vk = core.vk_token(&session);
            let settings = session.settings.lock().unwrap().clone();
            let mut engine = SearchEngine::new(settings, SearchSecrets { vk_token: Some(vk).filter(|v| !v.is_empty()) }, core.env.transport.clone(), Arc::new(StoreRepo(session.store.clone())), cancel);
            engine.sleeper = core.env.sleeper.clone();
            let guard = KeepAwake::new();
            let progress = {
                let (core, session) = (core.clone(), session.clone());
                move |text: &str| {
                    let mut st = session.search.lock().unwrap();
                    if st.running {
                        st.progress = Some(text.to_string());
                        drop(st);
                        core.env.emit("search-state", serde_json::to_value(session.search_status()).unwrap_or(Value::Null));
                    }
                }
            };
            let report = engine.run(&SearchOptions { force, only }, &progress).await;
            drop(guard);
            core.finish_search(&session, report, quiet);
        });
    }

    fn finish_search(self: &Arc<Self>, s: &Arc<Session>, report: SearchReport, quiet: bool) {
        {
            let mut st = s.search.lock().unwrap();
            st.running = false;
            st.progress = None;
            st.cancel = None;
            st.last_report = Some(report.clone());
        }
        self.env.emit("search-state", serde_json::to_value(s.search_status()).unwrap_or(Value::Null));
        self.env.emit("data-changed", Value::Null);
        if report.added() > 0 || report.updated() > 0 {
            self.sync_soon(s);
        }
        // При работе в фоне приложение может не перезапускаться днями: копия раз в сутки и после поиска.
        self.daily_backup_if_needed(s);
        let failed = !report.failed().is_empty();
        let prefs = s.account_prefs();
        if !quiet || report.added() > 0 || failed {
            self.env.emit("search-finished", json!({"summary": report.summary(), "failed": failed, "added": report.added(), "updated": report.updated()}));
        }
        if failed {
            self.env.log_error(&report.summary());
        }
        if report.added() > 0 && prefs.notify_new_leads {
            self.env.emit("notify", json!({"kind": "newLeads", "title": "Найдены новые лиды", "body": format!("Новых лидов: {}", report.added())}));
        }
        if failed && prefs.notify_errors {
            self.env.emit("notify", json!({"kind": "error", "title": "Поиск завершился с ошибками", "body": report.summary()}));
        }
    }

    pub fn stop_search(&self) -> CmdResult<()> {
        let s = self.require()?;
        let mut st = s.search.lock().unwrap();
        if st.running {
            st.cancel();
            st.progress = Some("Останавливаю…".into());
        }
        drop(st);
        self.env.emit("search-state", serde_json::to_value(s.search_status()).unwrap_or(Value::Null));
        Ok(())
    }

    pub fn search_status(&self) -> CmdResult<SearchStatus> {
        Ok(self.require()?.search_status())
    }

    /// Фоновые задачи открытой записи: автопоиск, суточная копия, синхронизация.
    pub(crate) fn start_background(self: &Arc<Self>, s: &Arc<Session>) {
        let mut tasks = s.tasks.lock().unwrap();
        // Автопоиск, пока приложение открыто: только источники, у которых подошёл интервал.
        let (core, session) = (self.clone(), s.clone());
        tasks.push(tokio::spawn(async move {
            loop {
                let minutes = session.account_prefs().auto_search_minutes;
                let wake = session.search.lock().unwrap().reschedule.clone();
                if minutes == 0 {
                    wake.notified().await;
                    continue;
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(u64::from(minutes) * 60)) => core.run_search_for(&session, false, None, true),
                    _ = wake.notified() => {}
                }
            }
        }));
        // Приложение может работать в фоне днями: проверяем суточную копию каждый час.
        let (core, session) = (self.clone(), s.clone());
        tasks.push(tokio::spawn(async move {
            loop {
                core.daily_backup_if_needed(&session);
                tokio::time::sleep(Duration::from_secs(3600)).await;
            }
        }));
        drop(tasks);
        if s.is_cloud {
            self.start_sync(s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::fixture;
    use super::*;
    use crate::search::http::HttpResponse;

    const RSS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>FL</title>
<item><title>Нужен сайт и бот</title><link>https://fl.ru/p/1</link><guid>https://fl.ru/p/1</guid>
<description><![CDATA[<p>Ищем разработчика сайта, тел. +7 999 123-45-67</p>]]></description><pubDate>Wed, 04 Nov 2026 10:00:00 +0300</pubDate><category>Сайты</category></item>
</channel></rss>"#;

    async fn wait_finished(core: &Arc<Core>) {
        for _ in 0..200 {
            if !core.search_status().unwrap().running {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("поиск не завершился");
    }

    fn rss_settings() -> Value {
        let mut s = SearchSettings::blank_start();
        s.rss.enabled = true;
        s.rss.feeds = vec!["https://fl.ru/rss".into()];
        s.rss.keywords = vec!["сайт".into()];
        serde_json::from_str(&s.encoded()).unwrap()
    }

    #[tokio::test]
    async fn search_adds_leads_reports_and_notifies() {
        let f = fixture(false, vec![Ok(HttpResponse::new(200, RSS_XML))]);
        let core = Core::new(f.env.clone());
        core.register("anna", "password-1", "password-1", false).unwrap();
        core.set_search_settings(&rss_settings()).unwrap();
        core.run_search(true, None, false).unwrap();
        wait_finished(&core).await;
        let s = core.session().unwrap();
        assert_eq!(s.with_store(|st| st.lead_count()), 1);
        let report = core.search_status().unwrap().last_report.unwrap();
        assert_eq!(report.added(), 1, "{report:?}");
        assert_eq!(f.events.count("search-finished"), 1);
        assert_eq!(f.events.count("notify"), 1);
        assert!(f.events.count("data-changed") >= 1);
        assert!(s.with_store(|st| st.value("last_search_at")).is_some() || report.added() == 1);
        // повторный запуск не плодит дубликаты
        f.transport.responses.lock().unwrap().push_back(Ok(HttpResponse::new(200, RSS_XML)));
        core.run_search(true, None, true).unwrap();
        wait_finished(&core).await;
        assert_eq!(s.with_store(|st| st.lead_count()), 1);
    }

    #[tokio::test]
    async fn disabled_sources_give_a_clear_message_and_vk_needs_a_token() {
        let f = fixture(false, vec![]);
        let core = Core::new(f.env.clone());
        core.register("anna", "password-1", "password-1", false).unwrap();
        let s = core.session().unwrap();
        let mut settings = SearchSettings::blank_start();
        settings.rss.enabled = false;
        settings.telegram.enabled = false;
        settings.osm.enabled = false;
        core.set_search_settings(&serde_json::from_str(&settings.encoded()).unwrap()).unwrap();
        core.run_search(true, None, false).unwrap();
        wait_finished(&core).await;
        let sum = core.search_status().unwrap().last_report.unwrap().summary();
        assert!(sum.contains("Нет включённых источников"), "{sum}");
        settings.vk.enabled = true;
        settings.vk.communities = vec!["club1".into()];
        core.set_search_settings(&serde_json::from_str(&settings.encoded()).unwrap()).unwrap();
        assert!(core.source_problem(&s, "vk_communities").is_some());
        core.set_vk_token("  abc  ").unwrap();
        assert_eq!(core.vk_token(&s), "abc");
        assert!(core.source_problem(&s, "vk_communities").is_none());
        core.set_vk_token("").unwrap();
        assert_eq!(core.vk_token(&s), "");
    }

    #[tokio::test]
    async fn settings_are_stored_in_the_database_and_survive_reopen() {
        let f = fixture(false, vec![]);
        let core = Core::new(f.env.clone());
        core.register("anna", "password-1", "password-1", true).unwrap();
        core.set_search_settings(&rss_settings()).unwrap();
        core.logout();
        core.login("anna", "password-1", false).unwrap();
        assert!(core.session().unwrap().settings.lock().unwrap().rss.enabled);
    }

    #[tokio::test]
    async fn only_one_search_runs_at_a_time_and_stop_cancels() {
        let f = fixture(false, vec![Ok(HttpResponse::new(200, RSS_XML))]);
        let core = Core::new(f.env.clone());
        core.register("anna", "password-1", "password-1", false).unwrap();
        core.set_search_settings(&rss_settings()).unwrap();
        let s = core.session().unwrap();
        s.search.lock().unwrap().running = true; // имитируем идущий поиск
        core.run_search(true, None, false).unwrap();
        assert!(f.transport.requests.lock().unwrap().is_empty(), "второй поиск не запускается");
        core.stop_search().unwrap();
        assert_eq!(core.search_status().unwrap().progress.as_deref(), Some("Останавливаю…"));
        let _ = CmdError::msg("");
    }
}
