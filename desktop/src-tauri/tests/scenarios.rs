//! Scenario Runner без окна: `npm run debug:scenario` (= `cargo test --features beta --test scenarios`).
//! Все сценарии Debug Menu на настоящем ядре во временной папке; SKIPPED не считается успехом.
#![cfg(feature = "beta")]

use customers_lib::channel::{Channel, ChannelDirs};
use customers_lib::debug::scenarios::{self, Host, Status};
use customers_lib::util::AppVersion;

fn host(dir: &std::path::Path) -> Host {
    let other = dir.join("other-channel");
    std::fs::create_dir_all(other.join("data")).unwrap();
    Host {
        root: dir.join("beta/scenarios"),
        channel: Channel::Beta,
        version: AppVersion::parse(env!("CARGO_PKG_VERSION")).unwrap(),
        identifier: "local.customers.beta".into(),
        other: ChannelDirs { channel: Channel::Stable, root: other.join("data"), logs: other.join("logs"), backups: other.join("backups"), legacy: vec![] },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_scenario_passes_on_the_real_core() {
    let dir = tempfile::tempdir().unwrap();
    let h = host(dir.path());
    let report = tokio::task::spawn_blocking(move || scenarios::run(&h, &[])).await.unwrap().unwrap();
    for r in &report.results {
        println!("{:?} {} {} мс {}", r.status, r.id, r.duration_ms, r.error.clone().unwrap_or_default());
    }
    assert_eq!(report.results.len(), scenarios::all().len());
    let failed: Vec<_> = report.results.iter().filter(|r| r.status != Status::Pass).map(|r| (r.id, r.error.clone())).collect();
    assert!(failed.is_empty(), "не прошли: {failed:?}");
    assert_eq!((report.passed, report.failed, report.skipped), (report.results.len(), 0, 0));
    assert!(!dir.path().join("beta/scenarios").join(&report.run_id).exists(), "временная папка прогона удалена");
    let other = std::fs::read_dir(dir.path().join("other-channel/data")).unwrap().count();
    assert_eq!(other, 0, "в папке другого канала ничего не появилось");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_single_scenario_can_be_rerun_and_unknown_ids_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let h = host(dir.path());
    let h2 = h.clone();
    let report = tokio::task::spawn_blocking(move || scenarios::run(&h, &["leads.statuses".to_string()])).await.unwrap().unwrap();
    assert_eq!(report.results.len(), 1);
    assert_eq!(report.results[0].status, Status::Pass, "{:?}", report.results[0].error);
    let err = tokio::task::spawn_blocking(move || scenarios::run(&h2, &["no.such".to_string()])).await.unwrap().unwrap_err();
    assert!(err.contains("no.such"));
}
