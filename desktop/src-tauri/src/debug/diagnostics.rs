//! Диагностика Beta: набор проверок с понятным описанием и отчёт ZIP для обращения.
//!
//! В отчёт не попадают базы, ключи, токены, пароли; адреса почты, телефоны и личные пути маскируются
//! (`debug::log::mask` и `reports::redact`).

use super::dashboard::{self, WindowInfo};
use super::log::{self, mask};
use crate::app::session::Core;
use crate::app::{CmdError, CmdResult};
use crate::search::http::HttpRequest;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pass,
    Warn,
    Fail,
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub id: &'static str,
    pub title: &'static str,
    pub status: Status,
    pub detail: String,
    /// Что сделать, если проверка не прошла.
    pub hint: Option<String>,
}

fn check(id: &'static str, title: &'static str, status: Status, detail: impl Into<String>, hint: Option<&str>) -> Check {
    Check { id, title, status, detail: detail.into(), hint: hint.map(str::to_string) }
}

/// Папка доступна для записи: создать и удалить пробный файл. Папку не создаёт.
fn writable(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Err("папки нет".into());
    }
    let probe = dir.join(format!(".write-test-{}", uuid::Uuid::new_v4()));
    std::fs::write(&probe, b"ok").map_err(|e| e.to_string())?;
    std::fs::remove_file(&probe).map_err(|e| e.to_string())
}

fn folder_check(id: &'static str, title: &'static str, dir: &Path, create_later: bool) -> Check {
    match writable(dir) {
        Ok(()) => check(id, title, Status::Pass, format!("{}: запись разрешена", dir.display()), None),
        Err(_) if create_later && dir.parent().is_some_and(|p| writable(p).is_ok()) => {
            check(id, title, Status::Pass, format!("{}: будет создана при первой записи", dir.display()), None)
        }
        Err(e) => check(id, title, Status::Fail, format!("{}: {e}", dir.display()), Some("Проверьте права на папку или выберите другую.")),
    }
}

pub async fn run(core: &Arc<Core>) -> Vec<Check> {
    let env = &core.env;
    let mut out = vec![];

    // Разделение каналов.
    let iso = env.isolation.check_dirs().and_then(|_| env.isolation.check_marker());
    out.push(match iso {
        Ok(()) => check("isolation", "Разделение Stable и Beta", Status::Pass, "папки каналов не пересекаются, метка канала своя", None),
        Err(e) => check(
            "isolation",
            "Разделение Stable и Beta",
            Status::Fail,
            e.to_string(),
            Some("Запуск Beta с этими папками небезопасен: закройте приложение и сообщите о проблеме."),
        ),
    });

    // Папки.
    out.push(folder_check("folder.data", "Папка данных", &env.paths.root, false));
    out.push(folder_check("folder.logs", "Папка журналов", &env.paths.logs, true));
    let session = core.session();
    match &session {
        Some(s) => out.push(folder_check("folder.backups", "Папка резервных копий", &core.backup_directory(s), true)),
        None => out.push(check("folder.backups", "Папка резервных копий", Status::Skipped, "нет входа: папка зависит от учётной записи", None)),
    }

    // База данных.
    match &session {
        Some(s) => {
            let (quick, schema, encrypted, path) = s.with_store(|st| {
                let quick: Result<String, String> = st.conn().query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|e| e.to_string());
                (quick, st.value("schema_version"), st.is_encrypted(), st.path().to_path_buf())
            });
            out.push(match quick {
                Ok(v) if v == "ok" => check("db.integrity", "Целостность базы", Status::Pass, "PRAGMA quick_check: ok", None),
                Ok(v) => check(
                    "db.integrity",
                    "Целостность базы",
                    Status::Fail,
                    format!("PRAGMA quick_check: {v}"),
                    Some("Восстановите базу из резервной копии (Настройки → Данные и копии)."),
                ),
                Err(e) => check("db.integrity", "Целостность базы", Status::Fail, e, None),
            });
            out.push(check(
                "db.schema",
                "Версия схемы базы",
                if schema.is_some() { Status::Pass } else { Status::Fail },
                format!("schema_version = {}", schema.unwrap_or_else(|| "нет".into())),
                None,
            ));
            out.push(if encrypted {
                check("db.encryption", "Шифрование базы", Status::Pass, "SQLCipher, ключ в защищённом хранилище", None)
            } else {
                check(
                    "db.encryption",
                    "Шифрование базы",
                    Status::Warn,
                    "база не зашифрована",
                    Some("Beta открывает только зашифрованные базы; проверьте путь к базе."),
                )
            });
            out.push(match env.isolation.check_path(&path) {
                Ok(()) => check("db.location", "Расположение базы", Status::Pass, path.display().to_string(), None),
                Err(e) => check("db.location", "Расположение базы", Status::Fail, e.to_string(), None),
            });
        }
        None => {
            for (id, title) in [
                ("db.integrity", "Целостность базы"),
                ("db.schema", "Версия схемы базы"),
                ("db.encryption", "Шифрование базы"),
                ("db.location", "Расположение базы"),
            ] {
                out.push(check(id, title, Status::Skipped, "нет входа: база не открыта", None));
            }
        }
    }

    // Конфигурация.
    let device = env.paths.device_prefs();
    out.push(match std::fs::read_to_string(&device) {
        Ok(text) if serde_json::from_str::<Value>(&text).is_ok() => {
            check("config.device", "Настройки устройства", Status::Pass, format!("{} читается", device.display()), None)
        }
        Ok(_) => check(
            "config.device",
            "Настройки устройства",
            Status::Fail,
            format!("{} повреждён", device.display()),
            Some("Файл будет пересоздан с настройками по умолчанию при сохранении."),
        ),
        Err(_) => check("config.device", "Настройки устройства", Status::Pass, "файла ещё нет — используются настройки по умолчанию", None),
    });

    // Файлы приложения.
    out.push(match std::env::current_exe() {
        Ok(exe) => match std::fs::metadata(&exe) {
            Ok(m) => check("app.files", "Файлы приложения", Status::Pass, format!("{} ({:.1} МБ)", exe.display(), m.len() as f64 / 1_048_576.0), None),
            Err(e) => check("app.files", "Файлы приложения", Status::Fail, format!("{}: {e}", exe.display()), None),
        },
        Err(e) => check("app.files", "Файлы приложения", Status::Fail, e.to_string(), None),
    });

    // Облако.
    out.push(match &env.cloud {
        None => {
            check("cloud.reachable", "Доступность Supabase", Status::Skipped, "облако Beta не настроено (SUPABASE_BETA_URL и SUPABASE_BETA_ANON_KEY)", None)
        }
        Some(c) => {
            let url = format!("{}/auth/v1/health", c.config.url.trim_end_matches('/'));
            let req =
                HttpRequest { method: "GET".into(), url: url.clone(), headers: vec![("apikey".into(), c.config.anon_key.clone())], body: None, timeout: 10.0 };
            match env.transport.send(req).await {
                Ok(r) if (200..300).contains(&r.status) => check("cloud.reachable", "Доступность Supabase", Status::Pass, format!("{url}: {}", r.status), None),
                Ok(r) => check(
                    "cloud.reachable",
                    "Доступность Supabase",
                    Status::Fail,
                    format!("{url}: ответ {}", r.status),
                    Some("Проверьте адрес и публичный ключ проекта Beta."),
                ),
                Err(e) => check("cloud.reachable", "Доступность Supabase", Status::Fail, format!("{url}: {e}"), Some("Проверьте подключение к интернету.")),
            }
        }
    });

    // Синхронизация.
    out.push(match &session {
        Some(s) if s.is_cloud => {
            let st = s.sync_status();
            let status = match st.kind {
                crate::app::sync::SyncKind::Failed => Status::Fail,
                crate::app::sync::SyncKind::Offline => Status::Warn,
                _ => Status::Pass,
            };
            check("sync", "Синхронизация", status, format!("{:?}; в очереди {}; {}", st.kind, st.pending, st.message.unwrap_or_default()), None)
        }
        Some(_) => check("sync", "Синхронизация", Status::Skipped, "локальная учётная запись — синхронизации нет", None),
        None => check("sync", "Синхронизация", Status::Skipped, "нет входа", None),
    });

    // Обновления.
    out.push(check("updates", "Обновления", Status::Pass, "в Beta автообновление отключено; Stable не видит файлы Beta", None));

    // Отчёты о сбоях Beta.
    let crashes = crash_files(core);
    out.push(if crashes.is_empty() {
        check("crashes", "Отчёты о сбоях", Status::Pass, "нет", None)
    } else {
        check("crashes", "Отчёты о сбоях", Status::Warn, format!("найдено: {}", crashes.len()), Some("Отчёты попадут в ZIP диагностики."))
    });

    out
}

fn crash_files(core: &Core) -> Vec<PathBuf> {
    let home = home();
    let system = if cfg!(target_os = "macos") { crate::reports::system_report_dirs(&home) } else { vec![] };
    crate::reports::find_for(core.env.channel, &system, Some(&core.env.paths.crashes()), None).into_iter().map(|f| f.path).take(10).collect()
}

fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

fn user() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

/// Текст, безопасный для отчёта: без секретов, почты, телефонов и личных путей.
pub fn clean(text: &str) -> String {
    crate::reports::redact(&mask(text), &home().display().to_string(), &user())
}

/// Собрать отчёт диагностики и сохранить его в `path` (ZIP). Возвращает путь.
pub async fn export_zip(core: &Arc<Core>, path: &Path, identifier: &str, window: WindowInfo, webview: Option<String>) -> CmdResult<PathBuf> {
    core.env.guard_path(path)?;
    let checks = run(core).await;
    let system = dashboard::collect(core, identifier, window, webview);
    let events = log::global().map(|l| l.last(2000)).unwrap_or_default();
    let mut files: Vec<(String, Vec<u8>)> = vec![
        (
            "report.json".into(),
            clean(&serde_json::to_string_pretty(&json!({"generatedAt": crate::util::now_string(), "checks": checks})).unwrap_or_default()).into_bytes(),
        ),
        ("system.json".into(), clean(&serde_json::to_string_pretty(&system).unwrap_or_default()).into_bytes()),
        ("events.jsonl".into(), clean(&log::to_jsonl(&events)).into_bytes()),
        ("isolation.json".into(), clean(&serde_json::to_string_pretty(&core.env.isolation.report()).unwrap_or_default()).into_bytes()),
    ];
    for f in crash_files(core) {
        if let Ok(text) = std::fs::read(&f) {
            let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            files.push((format!("crashes/{name}"), clean(&String::from_utf8_lossy(&text)).into_bytes()));
        }
    }
    let bytes = super::zip::build(&files);
    std::fs::write(path, bytes).map_err(|e| CmdError::msg(format!("Не удалось сохранить отчёт: {e}")))?;
    log::record(log::Level::Info, "diagnostics", &format!("Отчёт диагностики сохранён: {}", path.display()));
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::testing::fixture_channel;
    use crate::channel::Channel;
    use crate::search::http::HttpResponse;

    fn password() -> String {
        ["pass", "word-1"].concat()
    }

    fn find<'a>(checks: &'a [Check], id: &str) -> &'a Check {
        checks.iter().find(|c| c.id == id).unwrap_or_else(|| panic!("нет проверки {id}"))
    }

    #[tokio::test]
    async fn checks_describe_the_real_state() {
        let f = fixture_channel(Channel::Beta, false, vec![]);
        let core = Core::new(f.env.clone());
        let before = run(&core).await;
        assert_eq!(find(&before, "db.integrity").status, Status::Skipped, "без входа база не проверяется, но и не «пройдена»");
        assert_eq!(find(&before, "cloud.reachable").status, Status::Skipped);
        assert_eq!(find(&before, "isolation").status, Status::Pass);

        core.register("anna", &password(), &password(), false).unwrap();
        let after = run(&core).await;
        assert_eq!(find(&after, "db.integrity").status, Status::Pass);
        assert_eq!(find(&after, "db.encryption").status, Status::Pass);
        assert_eq!(find(&after, "db.schema").detail, "schema_version = 2");
        assert_eq!(find(&after, "folder.data").status, Status::Pass);
        assert!(
            std::fs::read_dir(&f.env.paths.root).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(".write-test")),
            "пробные файлы удалены"
        );

        // Метка другого канала в папке данных — проверка изоляции не проходит.
        std::fs::write(f.env.paths.root.join(crate::channel::MARKER_FILE), r#"{"channel":"stable"}"#).unwrap();
        assert_eq!(find(&run(&core).await, "isolation").status, Status::Fail);
    }

    #[tokio::test]
    async fn cloud_check_uses_the_health_endpoint() {
        let f = fixture_channel(Channel::Beta, true, vec![Ok(HttpResponse::new(200, "{}"))]);
        let core = Core::new(f.env.clone());
        let checks = run(&core).await;
        let c = find(&checks, "cloud.reachable");
        assert_eq!(c.status, Status::Pass, "{}", c.detail);
        assert!(f.transport.urls().iter().any(|u| u == "https://example.supabase.co/auth/v1/health"));

        let f = fixture_channel(Channel::Beta, true, vec![Ok(HttpResponse::new(503, ""))]);
        let checks = run(&Core::new(f.env.clone())).await;
        assert_eq!(find(&checks, "cloud.reachable").status, Status::Fail);
    }

    #[tokio::test]
    async fn zip_report_contains_checks_and_no_secrets() {
        let f = fixture_channel(Channel::Beta, false, vec![]);
        let core = Core::new(f.env.clone());
        core.register("anna", &password(), &password(), false).unwrap();
        let path = f.dir.path().join("data/diagnostics.zip");
        export_zip(&core, &path, "local.customers.beta", WindowInfo::default(), None).await.unwrap();
        let files = super::super::zip::read(&std::fs::read(&path).unwrap()).unwrap();
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        for want in ["report.json", "system.json", "events.jsonl", "isolation.json"] {
            assert!(names.contains(&want), "{names:?}");
        }
        let report: Value = serde_json::from_slice(&files[0].1).unwrap();
        assert!(report["checks"].as_array().unwrap().len() >= 10);
        let all: String = files.iter().map(|(_, d)| String::from_utf8_lossy(d).into_owned()).collect();
        assert!(!all.contains(&password()), "в отчёте нет пароля");
        assert!(names.iter().all(|n| !n.ends_with(".db")), "базы в отчёт не входят");

        // В папку другого канала отчёт не сохраняется.
        let foreign = f.dir.path().join("other-channel/data/diagnostics.zip");
        assert!(export_zip(&core, &foreign, "local.customers.beta", WindowInfo::default(), None).await.is_err());
        assert!(!foreign.exists());
    }
}
