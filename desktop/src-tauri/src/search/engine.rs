//! Поиск лидов по всем источникам. Не зависит от интерфейса и от того, где лежат результаты.

use crate::error::AppResult;
use crate::models::{LeadData, LeadKind, SaveOutcome};
use crate::search::http::{real_sleeper, HttpSettings, HttpTransport, SearchError, Sleeper, SourceHttp};
use crate::search::scoring::Scorer;
use crate::search::settings::{self as cfg, SearchSecrets, SearchSettings};
use crate::search::sources::{self, Candidate, FetchResult, SearchMemory};
use crate::search::text::{fingerprint, lead_id};
use crate::store::LeadStore;
use crate::util::{self, source_title};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

/// Куда поиск складывает результаты.
pub trait SearchRepository: SearchMemory {
    fn source_cursor(&self, source: &str) -> Option<String>;
    fn last_success(&self, source: &str) -> Option<DateTime<Utc>>;
    fn mark_attempt(&self, source: &str);
    fn finish_source(&self, source: &str, ok: bool, partial: bool, error: Option<&str>, cursor: Option<&str>);
    fn save(&self, lead: &LeadData, id: &str, fingerprint: &str) -> AppResult<SaveOutcome>;
    fn log_error(&self, module: &str, message: &str);
    fn log_run(&self, ok: bool, added: i64, updated: i64, message: &str);
    fn search_finished(&self) -> AppResult<()>;
}

/// Локальная база пользователя как хранилище результатов. Блокировка берётся на время одного вызова.
#[derive(Clone)]
pub struct StoreRepo(pub Arc<Mutex<LeadStore>>);

impl StoreRepo {
    fn with<T>(&self, f: impl FnOnce(&LeadStore) -> T) -> T {
        f(&self.0.lock().unwrap())
    }
}

impl SearchMemory for StoreRepo {
    fn query_last_run(&self, hash: &str) -> Option<DateTime<Utc>> {
        self.with(|s| s.query_last_run(hash))
    }
    fn record_query(&self, hash: &str, source: &str, label: &str, results: i64) {
        self.with(|s| s.record_query(hash, source, label, results))
    }
    fn forget_query(&self, hash: &str) {
        self.with(|s| s.forget_query(hash))
    }
    fn object_checked_at(&self, source: &str, object_id: &str) -> Option<DateTime<Utc>> {
        self.with(|s| s.object_checked_at(source, object_id))
    }
    fn mark_object_checked(&self, source: &str, object_id: &str) {
        self.with(|s| s.mark_object_checked(source, object_id))
    }
}

impl SearchRepository for StoreRepo {
    fn source_cursor(&self, source: &str) -> Option<String> {
        self.with(|s| s.source_cursor(source))
    }
    fn last_success(&self, source: &str) -> Option<DateTime<Utc>> {
        self.with(|s| s.last_success(source))
    }
    fn mark_attempt(&self, source: &str) {
        self.with(|s| s.mark_attempt(source))
    }
    fn finish_source(&self, source: &str, ok: bool, partial: bool, error: Option<&str>, cursor: Option<&str>) {
        self.with(|s| s.finish_source(source, ok, partial, error, cursor))
    }
    fn save(&self, lead: &LeadData, id: &str, fingerprint: &str) -> AppResult<SaveOutcome> {
        self.with(|s| s.save(lead, id, fingerprint))
    }
    fn log_error(&self, module: &str, message: &str) {
        self.with(|s| s.log_error(module, message))
    }
    fn log_run(&self, ok: bool, added: i64, updated: i64, message: &str) {
        self.with(|s| s.log_run(ok, added, updated, message))
    }
    fn search_finished(&self) -> AppResult<()> {
        self.with(|s| s.search_finished())
    }
}

#[derive(Debug, Clone)]
pub struct SearchOptions {
    /// Не смотреть на интервалы источников (кнопка «Найти лиды»).
    pub force: bool,
    /// Только эти источники (кнопка «Проверить сейчас» у источника).
    pub only: Option<HashSet<String>>,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self { force: true, only: None }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReport {
    pub source: String,
    pub found: usize,
    pub added: usize,
    pub updated: usize,
    pub duplicates: usize,
    pub skipped: Option<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub failed: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchReport {
    pub sources: Vec<SourceReport>,
    pub cancelled: bool,
}

impl SearchReport {
    pub fn added(&self) -> usize {
        self.sources.iter().map(|s| s.added).sum()
    }
    pub fn updated(&self) -> usize {
        self.sources.iter().map(|s| s.updated).sum()
    }
    pub fn failed(&self) -> Vec<&SourceReport> {
        self.sources.iter().filter(|s| s.failed).collect()
    }
    pub fn summary(&self) -> String {
        if self.cancelled {
            return format!("Поиск остановлен. Новых лидов: {}", self.added());
        }
        let ran: Vec<_> = self.sources.iter().filter(|s| s.skipped.is_none()).collect();
        if ran.is_empty() {
            return self
                .sources
                .first()
                .and_then(|s| s.skipped.as_ref())
                .map(|m| format!("Поиск не выполнен: {m}"))
                .unwrap_or_else(|| "Нет включённых источников".into());
        }
        let mut s = format!("Поиск завершён: новых {}, обновлено {}", self.added(), self.updated());
        let failed = self.failed();
        if !failed.is_empty() {
            s += &format!(". С ошибками: {}", failed.iter().map(|f| source_title(&f.source)).collect::<Vec<_>>().join(", "));
        }
        s
    }
}

pub struct SearchEngine {
    pub settings: SearchSettings,
    pub secrets: SearchSecrets,
    pub transport: Arc<dyn HttpTransport>,
    pub repo: Arc<dyn SearchRepository>,
    pub scorer: Scorer,
    pub sleeper: Sleeper,
    pub now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    pub cancel: CancellationToken,
}

impl SearchEngine {
    pub fn new(
        settings: SearchSettings,
        secrets: SearchSecrets,
        transport: Arc<dyn HttpTransport>,
        repo: Arc<dyn SearchRepository>,
        cancel: CancellationToken,
    ) -> Self {
        Self { settings, secrets, transport, repo, scorer: Scorer::default(), sleeper: real_sleeper(), now: Arc::new(Utc::now), cancel }
    }

    fn http(&self, name: &str, min_interval: f64, max_requests: usize, max_attempts: usize, timeout: f64) -> SourceHttp {
        SourceHttp::new(
            name,
            self.transport.clone(),
            HttpSettings { min_interval, max_requests, max_attempts, base_delay: 2.0, timeout },
            self.sleeper.clone(),
            self.cancel.clone(),
        )
    }

    pub async fn run(&self, options: &SearchOptions, progress: &(dyn Fn(&str) + Send + Sync)) -> SearchReport {
        let mut report = SearchReport::default();
        for key in cfg::ALL_SOURCES {
            if let Some(only) = &options.only {
                if !only.contains(key) {
                    continue;
                }
            }
            let mut r = SourceReport { source: key.into(), ..Default::default() };
            if !self.settings.is_enabled(key) {
                if options.only.is_some() {
                    r.skipped = Some("источник выключен".into());
                    report.sources.push(r);
                }
                continue;
            }
            if let Some(p) = cfg::source_problem(key, &self.settings, &self.secrets) {
                r.skipped = Some(p);
                report.sources.push(r);
                continue;
            }
            if !options.force {
                if let Some(last) = self.repo.last_success(key) {
                    if ((self.now)() - last).num_milliseconds() as f64 / 1000.0 < self.settings.interval_hours(key) * 3600.0 {
                        continue; // ещё рано
                    }
                }
            }
            if self.cancel.is_cancelled() {
                report.cancelled = true;
                break;
            }
            progress(&format!("{}: поиск…", source_title(key)));
            self.repo.mark_attempt(key);
            match self.fetch(key).await {
                Ok(fetched) => {
                    r.warnings = fetched.warnings.clone();
                    r.errors = fetched.partial_errors.clone();
                    r.found = fetched.candidates.len();
                    progress(&format!("{}: оценка {}", source_title(key), fetched.candidates.len()));
                    for c in &fetched.candidates {
                        if let Err(e) = self.store(c, &mut r) {
                            self.repo.log_error(key, &e.to_string());
                            r.errors.push(e.to_string());
                        }
                    }
                    let all_failed = !fetched.partial_errors.is_empty() && fetched.partial_errors.len() >= fetched.items;
                    r.failed = all_failed;
                    for e in &fetched.partial_errors {
                        self.repo.log_error(key, e);
                    }
                    for w in &fetched.warnings {
                        self.repo.log_error(key, &format!("Предупреждение: {w}"));
                    }
                    self.repo.finish_source(
                        key,
                        !all_failed,
                        !fetched.partial_errors.is_empty(),
                        fetched.partial_errors.first().map(String::as_str),
                        fetched.cursor.as_deref(),
                    );
                }
                Err(SearchError::Cancelled) => {
                    report.cancelled = true;
                    report.sources.push(r);
                    break;
                }
                Err(e) => {
                    let msg = e.message();
                    r.failed = true;
                    r.errors.push(msg.clone());
                    self.repo.log_error(key, &msg);
                    self.repo.finish_source(key, false, false, Some(&msg), None);
                }
            }
            report.sources.push(r);
        }
        let _ = self.repo.search_finished();
        let ok = report.failed().is_empty() && !report.cancelled;
        if report.sources.iter().any(|s| s.skipped.is_none()) {
            self.repo.log_run(ok, report.added() as i64, report.updated() as i64, &report.summary());
        }
        report
    }

    async fn fetch(&self, key: &str) -> Result<FetchResult, SearchError> {
        let cursor = self.repo.source_cursor(key);
        let s = &self.settings;
        match key {
            cfg::RSS => {
                let http = self.http("RSS-ленты", 2.0, 5.max(s.rss.feeds.len() * 2), 4, 20.0);
                sources::fetch_rss(&s.rss, cursor.as_deref(), &http).await
            }
            cfg::TELEGRAM => {
                let http = self.http("Telegram", 3.0, 40.max(s.telegram.channels.len() * s.telegram.max_pages as usize + 5), 4, 20.0);
                sources::fetch_telegram(&s.telegram, cursor.as_deref(), &http).await
            }
            cfg::VK => {
                let http = self.http("VK", 0.4, 40.max(s.vk.communities.len() * s.vk.max_pages as usize + 5), 4, 20.0);
                sources::fetch_vk(&s.vk, self.secrets.vk_token.as_deref().unwrap_or(""), cursor.as_deref(), &http).await
            }
            cfg::OSM => {
                let http = self.http("OpenStreetMap", 5.0, 10, 4, 120.0);
                let site = self.http("Проверка сайтов", 1.0, 40, 2, 12.0);
                sources::fetch_osm(&s.osm, self.repo.as_ref(), &http, s.osm.check_websites.then_some(&site), (self.now)()).await
            }
            _ => Ok(FetchResult::default()),
        }
    }

    fn store(&self, c: &Candidate, r: &mut SourceReport) -> AppResult<()> {
        let mut data = c.data.clone();
        data.discovered_at = Some((self.now)());
        if data.kind == LeadKind::Organization {
            self.scorer.score_organization(&mut data, c.category_weight, &c.signals);
        } else {
            self.scorer.score_order(&mut data, (self.now)());
        }
        let id = lead_id(&data.source, &data.external_id);
        match self.repo.save(&data, &id, &fingerprint(&data))? {
            SaveOutcome::Added => r.added += 1,
            SaveOutcome::Updated => r.updated += 1,
            SaveOutcome::Duplicate => r.duplicates += 1,
            SaveOutcome::Unchanged => {}
        }
        Ok(())
    }
}

#[allow(unused)]
fn _assert_util(_: &str) -> String {
    util::now_string()
}
