//! Тестовые данные Beta: детерминированный генератор лидов (одинаковый `seed` — одинаковые данные), очистка
//! и сброс к исходному состоянию.
//!
//! Защита: всё это работает только в локальной учётной записи Beta, которую пользователь сам пометил тестовой.
//! В учётной записи с облаком генератор отказывает — данные ушли бы в Supabase. Перед записью проверяется,
//! что база лежит в папке своего канала. В Stable этого кода нет.

use crate::app::session::{Core, Session};
use crate::app::{CmdError, CmdResult};
use crate::models::{LeadData, LeadKind, Relevance};
use crate::store::LeadStore;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::Instant;

/// Источник сгенерированных лидов: по нему очистка удаляет только их.
pub const SOURCE: &str = "test-data";
const MARK: &str = "debug.test_account";
pub const MAX_COUNT: usize = 50_000;
/// Слово, которое нужно ввести для сброса учётной записи.
pub const RESET_WORD: &str = "сброс";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub has_session: bool,
    pub is_test: bool,
    /// Можно ли пометить эту учётную запись тестовой; если нет — почему.
    pub can_mark: bool,
    pub reason: Option<String>,
    pub test_leads: i64,
    pub total_leads: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Generated {
    pub added: usize,
    pub skipped: usize,
    pub duration_ms: u128,
    pub total_leads: i64,
}

fn refusal(s: &Session) -> Option<String> {
    if s.is_cloud {
        return Some("Учётная запись связана с облаком: тестовые данные ушли бы в Supabase. Войдите в локальную учётную запись Beta.".into());
    }
    if s.with_store(|st| st.sync_tracking()) {
        return Some("В этой базе включена синхронизация: тестовые данные нельзя создавать.".into());
    }
    None
}

fn test_count(st: &LeadStore) -> i64 {
    st.conn().query_row("SELECT COUNT(*) FROM leads WHERE source=?1", [SOURCE], |r| r.get(0)).unwrap_or(0)
}

pub fn state(core: &Core) -> State {
    let Some(s) = core.session() else {
        return State {
            has_session: false, is_test: false, can_mark: false, reason: Some("Войдите в учётную запись.".into()), test_leads: 0, total_leads: 0
        };
    };
    let reason = refusal(&s);
    let (is_test, test_leads, total_leads) = s.with_store(|st| (st.value(MARK).as_deref() == Some("1"), test_count(st), st.lead_count()));
    State { has_session: true, is_test: is_test && reason.is_none(), can_mark: reason.is_none(), reason, test_leads, total_leads }
}

/// Сессия, в которой можно работать с тестовыми данными, или понятный отказ.
fn test_session(core: &Core) -> CmdResult<Arc<Session>> {
    let s = core.require()?;
    if let Some(r) = refusal(&s) {
        return Err(CmdError::msg(r));
    }
    s.with_store(|st| core.env.guard_path(st.path()))?;
    if s.with_store(|st| st.value(MARK)).as_deref() != Some("1") {
        return Err(CmdError::msg("Сначала пометьте учётную запись как тестовую (раздел «Тестовые данные»)."));
    }
    Ok(s)
}

pub fn mark(core: &Core, on: bool) -> CmdResult<State> {
    let s = core.require()?;
    if let Some(r) = refusal(&s) {
        return Err(CmdError::msg(r));
    }
    s.with_store(|st| if on { st.set_value(MARK, "1") } else { st.delete_value(MARK) })?;
    crate::debug::log::record(
        crate::debug::log::Level::Info,
        "test-data",
        if on { "Учётная запись помечена тестовой" } else { "Метка тестовой учётной записи снята" },
    );
    Ok(state(core))
}

/// Детерминированный генератор (SplitMix64): данные зависят только от `seed`.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next_u64() % n.max(1)
    }
    pub fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len() as u64) as usize]
    }
}

const WORKS: &[&str] = &["Сайт", "Интернет-магазин", "Мобильное приложение", "CRM-система", "Telegram-бот", "Лендинг", "Личный кабинет", "Интеграция с 1С"];
const FOR: &[&str] = &["для автосервиса", "для клиники", "для школы", "для ресторана", "для склада", "для салона красоты", "для юристов", "для стройки"];
const ORGS: &[&str] = &["Альфа", "Вектор", "Гранит", "Дельта", "Заря", "Импульс", "Квант", "Меридиан", "Орбита", "Стандарт"];
const FORMS: &[&str] = &["ООО", "АО", "ИП"];
const REGIONS: &[&str] = &["Москва", "Санкт-Петербург", "Казань", "Новосибирск", "Екатеринбург", "Краснодар", "Самара"];
const CATEGORIES: &[&str] = &["Веб-разработка", "Мобильная разработка", "Автоматизация", "Интеграции"];

/// Лид номер `i` для данного `seed`.
pub fn lead(seed: u64, i: usize) -> LeadData {
    let mut r = Rng::new(seed ^ (i as u64).wrapping_mul(0xA24B_AED4_963E_E407));
    let org = r.below(3) == 0;
    let external = format!("{seed}-{i}");
    let mut d = if org {
        let name = format!("{} «{}-{}»", r.pick(FORMS), r.pick(ORGS), i);
        let mut d = LeadData::new(LeadKind::Organization, SOURCE, &external, &name);
        d.customer_name = Some(name);
        d.website = Some(format!("https://org-{seed}-{i}.example.com"));
        d.phone = Some(format!("+7 900 {:03}-{:02}-{:02}", i % 1000, (i / 1000) % 100, r.below(100)));
        d.address = Some(format!("{}, ул. Тестовая, {}", r.pick(REGIONS), 1 + r.below(120)));
        d
    } else {
        let title = format!("{} {} №{i}", r.pick(WORKS), r.pick(FOR));
        let mut d = LeadData::new(LeadKind::Order, SOURCE, &external, &title);
        d.description = format!("Тестовая заявка {i} (seed {seed}): нужен исполнитель, срок {} недель.", 1 + r.below(12));
        d.budget = Some((5 + r.below(400)) as f64 * 1000.0);
        d.currency = Some("RUB".into());
        d
    };
    d.url = format!("https://example.com/test-data/{seed}/{i}");
    d.region = Some(r.pick(REGIONS).to_string());
    d.category = Some(r.pick(CATEGORIES).to_string());
    d.contacts.insert("email".into(), format!("lead{i}@example.com"));
    d.score = r.below(101) as f64;
    d.relevance = match d.score as u32 {
        70.. => Relevance::High,
        45..=69 => Relevance::Medium,
        20..=44 => Relevance::Low,
        _ => Relevance::Rejected,
    };
    d.discovered_at = Some(chrono::Utc::now() - chrono::Duration::minutes(r.below(90 * 24 * 60) as i64));
    d.facts = vec!["Сгенерировано Debug Menu".into()];
    d
}

pub fn generate(core: &Core, count: usize, seed: u64) -> CmdResult<Generated> {
    if count == 0 || count > MAX_COUNT {
        return Err(CmdError::msg(format!("Количество — от 1 до {MAX_COUNT}.")));
    }
    let s = test_session(core)?;
    let started = Instant::now();
    let (added, skipped, total) = s.with_store(|st| -> CmdResult<(usize, usize, i64)> {
        // Номера продолжаются после уже созданных, чтобы повторная генерация добавляла новые лиды.
        let offset = test_count(st) as usize;
        let mut added = 0;
        st.transaction(|| {
            for i in offset..offset + count {
                let d = lead(seed, i);
                let id = crate::search::text::lead_id(SOURCE, &d.external_id);
                if st.save(&d, &id, &crate::search::text::fingerprint(&d))? == crate::models::SaveOutcome::Added {
                    added += 1;
                }
            }
            Ok(())
        })?;
        Ok((added, count - added, st.lead_count()))
    })?;
    let ms = started.elapsed().as_millis();
    crate::debug::log::record(crate::debug::log::Level::Info, "test-data", &format!("Создано тестовых лидов: {added} (seed {seed}) за {ms} мс"));
    core.env.emit("data-changed", Value::Null);
    Ok(Generated { added, skipped, duration_ms: ms, total_leads: total })
}

/// Удалить только сгенерированные лиды (источник `test-data`) и их историю.
pub fn clear(core: &Core) -> CmdResult<usize> {
    let s = test_session(core)?;
    let n = s.with_store(|st| -> CmdResult<usize> {
        let c = st.conn();
        let mut n = 0;
        st.transaction(|| {
            c.execute("DELETE FROM lead_events WHERE lead_id IN (SELECT lead_id FROM leads WHERE source=?1)", [SOURCE])?;
            n = c.execute("DELETE FROM leads WHERE source=?1", [SOURCE])?;
            Ok(())
        })?;
        Ok(n)
    })?;
    crate::debug::log::record(crate::debug::log::Level::Info, "test-data", &format!("Удалено тестовых лидов: {n}"));
    core.env.emit("data-changed", Value::Null);
    Ok(n)
}

/// Сброс тестовой учётной записи к исходному состоянию: все лиды, история, исключения, журнал поиска.
/// Метка тестовой записи и настройки остаются. Нужно ввести слово «сброс».
pub fn reset(core: &Core, confirm: &str) -> CmdResult<()> {
    if confirm.trim().to_lowercase() != RESET_WORD {
        return Err(CmdError::msg(format!("Для сброса введите слово «{RESET_WORD}».")));
    }
    let s = test_session(core)?;
    s.with_store(|st| {
        let c = st.conn();
        st.transaction(|| {
            for table in ["lead_events", "leads", "exclusions", "pipeline_errors", "sync_log", "search_queries", "seen_objects", "source_state"] {
                c.execute(&format!("DELETE FROM {table}"), [])?;
            }
            c.execute("DELETE FROM kv WHERE key=?1", ["last_search_at"])?;
            Ok(())
        })
    })?;
    crate::debug::log::record(crate::debug::log::Level::Warning, "test-data", "Тестовая учётная запись сброшена к исходному состоянию");
    core.env.emit("data-changed", Value::Null);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::testing::fixture_channel;
    use crate::channel::Channel;

    fn password() -> String {
        ["pass", "word-1"].concat()
    }

    fn beta_core() -> (crate::app::testing::Fixture, Arc<Core>) {
        let f = fixture_channel(Channel::Beta, false, vec![]);
        let core = Core::new(f.env.clone());
        core.register("tester", &password(), &password(), false).unwrap();
        (f, core)
    }

    #[test]
    fn generator_is_deterministic() {
        // Дата обнаружения отсчитывается от текущего момента, остальное зависит только от seed и номера.
        let strip = |mut d: LeadData| {
            d.discovered_at = None;
            d.to_value()
        };
        assert_eq!(strip(lead(7, 3)), strip(lead(7, 3)));
        assert_ne!(strip(lead(7, 3)), strip(lead(8, 3)));
        assert_ne!(strip(lead(7, 3)), strip(lead(7, 4)));
    }

    #[tokio::test]
    async fn generation_requires_a_marked_test_account() {
        let (_f, core) = beta_core();
        let err = generate(&core, 10, 1).unwrap_err();
        assert!(err.message.contains("пометьте"), "{}", err.message);
        assert_eq!(core.snapshot().unwrap().leads.len(), 0);
        assert!(reset(&core, RESET_WORD).is_err());
        assert!(clear(&core).is_err());
    }

    #[tokio::test]
    async fn generate_clear_and_reset_change_only_what_they_say() {
        let (f, core) = beta_core();
        // Лид «из поиска» — не тестовый.
        let real = LeadData::new(LeadKind::Order, "fl_ru", "real-1", "Настоящая заявка");
        core.session().unwrap().with_store(|st| st.save(&real, "real-1", "fp-real")).unwrap();
        mark(&core, true).unwrap();

        let g = generate(&core, 250, 42).unwrap();
        assert_eq!((g.added, g.total_leads), (250, 251));
        assert_eq!(state(&core).test_leads, 250);
        let again = generate(&core, 50, 42).unwrap();
        assert_eq!(again.added, 50, "повторная генерация добавляет новые лиды");
        assert!(f.events.count("data-changed") >= 2);

        assert_eq!(clear(&core).unwrap(), 300);
        let left = core.snapshot().unwrap().leads;
        assert_eq!(left.len(), 1);
        assert_eq!(left[0]["id"], "real-1", "очистка не трогает другие лиды");

        assert!(reset(&core, "нет").unwrap_err().message.contains(RESET_WORD));
        assert_eq!(core.snapshot().unwrap().leads.len(), 1);
        core.exclude("example.org", None).unwrap();
        reset(&core, "Сброс").unwrap();
        let snap = core.snapshot().unwrap();
        assert_eq!(snap.leads.len(), 0);
        assert_eq!(snap.exclusions, serde_json::json!([]));
        assert!(state(&core).is_test, "метка тестовой записи сохраняется после сброса");
    }

    #[tokio::test]
    async fn ten_thousand_leads_are_generated_in_one_transaction() {
        let (_f, core) = beta_core();
        mark(&core, true).unwrap();
        let g = generate(&core, 10_000, 1).unwrap();
        assert_eq!(g.added, 10_000);
        assert_eq!(core.snapshot().unwrap().leads.len(), 10_000);
        assert!(generate(&core, MAX_COUNT + 1, 1).is_err());
    }
}
