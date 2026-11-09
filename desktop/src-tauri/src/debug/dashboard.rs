//! Dashboard: что за сборка, на какой системе и в каком состоянии её части. Только настоящие значения;
//! если показатель на этой системе недоступен, поле пустое (интерфейс пишет «нет данных»), а не ноль.

use crate::app::session::Core;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;

static STARTED: Lazy<Instant> = Lazy::new(Instant::now);

/// Отметить время запуска (вызывается при старте Beta; до этого отсчёт идёт с первого обращения).
pub fn mark_start() {
    Lazy::force(&STARTED);
}

/// Окно, из которого открыт Debug Menu.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub scale_factor: Option<f64>,
    pub physical_width: Option<u32>,
    pub physical_height: Option<u32>,
    pub logical_width: Option<f64>,
    pub logical_height: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub name: &'static str,
    /// ok / off / busy / warning / error
    pub state: &'static str,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub version: String,
    pub channel: &'static str,
    pub identifier: String,
    pub git_commit: Option<&'static str>,
    pub git_branch: Option<&'static str>,
    pub build_profile: &'static str,
    pub os: Option<String>,
    pub os_version: Option<String>,
    pub kernel: Option<String>,
    pub arch: &'static str,
    pub tauri: &'static str,
    pub webview: Option<String>,
    pub window: WindowInfo,
    pub uptime_secs: u64,
    pub pid: Option<u32>,
    pub memory_bytes: Option<u64>,
    /// Доля одного ядра в процентах за время с прошлого обновления; при первом обращении — нет данных.
    pub cpu_percent: Option<f32>,
    pub data_dir: String,
    pub logs_dir: String,
    pub components: Vec<Component>,
}

struct ProcessProbe {
    sys: sysinfo::System,
    measured: bool,
}

static PROBE: Lazy<Mutex<ProcessProbe>> = Lazy::new(|| Mutex::new(ProcessProbe { sys: sysinfo::System::new(), measured: false }));

/// Память и загрузка процессора этим процессом.
pub fn process_usage() -> (Option<u32>, Option<u64>, Option<f32>) {
    let Ok(pid) = sysinfo::get_current_pid() else { return (None, None, None) };
    let mut probe = PROBE.lock().unwrap();
    probe.sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::Some(&[pid]), false, sysinfo::ProcessRefreshKind::nothing().with_memory().with_cpu());
    let first = !probe.measured;
    probe.measured = true;
    match probe.sys.process(pid) {
        Some(p) => (Some(pid.as_u32()), Some(p.memory()).filter(|m| *m > 0), (!first).then(|| p.cpu_usage())),
        None => (Some(pid.as_u32()), None, None),
    }
}

pub fn components(core: &Core) -> Vec<Component> {
    let mut out = vec![];
    let session = core.session();
    match &session {
        Some(s) => {
            let (count, size, encrypted) = s.with_store(|st| (st.lead_count(), st.file_size(), st.is_encrypted()));
            out.push(Component {
                name: "База данных",
                state: if encrypted { "ok" } else { "warning" },
                detail: format!("{count} лидов, {:.1} МБ{}", size as f64 / 1_048_576.0, if encrypted { ", зашифрована" } else { ", не зашифрована" }),
            });
        }
        None => out.push(Component { name: "База данных", state: "off", detail: "не открыта: нет входа".into() }),
    }
    out.push(match (&core.env.cloud, &session) {
        (None, _) => Component { name: "Облако", state: "off", detail: "не настроено для Beta (SUPABASE_BETA_URL)".into() },
        (Some(c), Some(s)) if s.is_cloud => {
            Component { name: "Облако", state: "ok", detail: format!("вход выполнен, {}", host(&c.config.url)) }
        }
        (Some(c), _) => {
            Component { name: "Облако", state: "off", detail: format!("настроено ({}), вход не выполнен", host(&c.config.url)) }
        }
    });
    out.push(match &session {
        Some(s) if s.is_cloud => {
            let st = s.sync_status();
            let state = match st.kind {
                crate::app::sync::SyncKind::Idle => "ok",
                crate::app::sync::SyncKind::Syncing => "busy",
                crate::app::sync::SyncKind::Offline => "warning",
                crate::app::sync::SyncKind::Failed => "error",
            };
            let last = st.last_sync.unwrap_or_else(|| "ещё не было".into());
            Component {
                name: "Синхронизация",
                state,
                detail: format!("последняя: {last}; в очереди: {}{}", st.pending, st.message.map(|m| format!("; {m}")).unwrap_or_default()),
            }
        }
        Some(_) => Component { name: "Синхронизация", state: "off", detail: "локальная учётная запись".into() },
        None => Component { name: "Синхронизация", state: "off", detail: "нет входа".into() },
    });
    out.push(match &session {
        Some(s) => {
            let st = s.search_status();
            if st.running {
                Component { name: "Поиск", state: "busy", detail: st.progress.unwrap_or_else(|| "идёт".into()) }
            } else {
                let last = s.with_store(|st| st.value("last_search_at")).unwrap_or_else(|| "ещё не было".into());
                Component { name: "Поиск", state: "ok", detail: format!("не идёт; последний: {last}") }
            }
        }
        None => Component { name: "Поиск", state: "off", detail: "нет входа".into() },
    });
    out.push(Component {
        name: "Обновления", state: "off", detail: "в Beta отключены: новая версия ставится вручную из Pre-release".into()
    });
    out
}

fn host(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| url.to_string())
}

pub fn collect(core: &Core, identifier: &str, window: WindowInfo, webview: Option<String>) -> Dashboard {
    let (pid, memory_bytes, cpu_percent) = process_usage();
    Dashboard {
        version: core.env.version.to_string(),
        channel: core.env.channel.name(),
        identifier: identifier.to_string(),
        git_commit: option_env!("CUSTOMERS_GIT_COMMIT").filter(|s| !s.is_empty()),
        git_branch: option_env!("CUSTOMERS_GIT_BRANCH").filter(|s| !s.is_empty()),
        build_profile: if cfg!(debug_assertions) { "debug" } else { "release" },
        os: sysinfo::System::name(),
        os_version: sysinfo::System::long_os_version().or_else(sysinfo::System::os_version),
        kernel: sysinfo::System::kernel_version(),
        arch: std::env::consts::ARCH,
        tauri: tauri::VERSION,
        webview,
        window,
        uptime_secs: STARTED.elapsed().as_secs(),
        pid,
        memory_bytes,
        cpu_percent,
        data_dir: core.env.paths.root.display().to_string(),
        logs_dir: core.env.paths.logs.display().to_string(),
        components: components(core),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::testing::fixture_channel;
    use crate::channel::Channel;

    #[tokio::test]
    async fn dashboard_reports_real_values_and_component_states() {
        let f = fixture_channel(Channel::Beta, false, vec![]);
        let core = Core::new(f.env.clone());
        let d = collect(&core, "local.customers.beta", WindowInfo::default(), None);
        assert_eq!(d.channel, "beta");
        assert_eq!(d.version, "1.1.0");
        assert_eq!(d.tauri, tauri::VERSION);
        assert!(d.pid.is_some());
        assert!(d.memory_bytes.unwrap_or(0) > 1_000_000, "память процесса измерена: {:?}", d.memory_bytes);
        assert!(d.os.is_some());
        let db = &d.components[0];
        assert_eq!((db.name, db.state), ("База данных", "off"));
        assert_eq!(d.components[1].state, "off", "облако без настроек — выключено, а не «ок»");

        let pw = ["pass", "word-1"].concat();
        core.register("anna", &pw, &pw, false).unwrap();
        let d = collect(&core, "local.customers.beta", WindowInfo::default(), None);
        assert_eq!(d.components[0].state, "ok");
        assert!(d.components[0].detail.starts_with("0 лидов"), "{}", d.components[0].detail);
        assert!(d.cpu_percent.is_some(), "со второго обращения загрузка процессора известна");
    }
}
