//! Сведения о системе: питание (для облегчённого режима) и запрет засыпания на время поиска.

use serde::Serialize;

/// Состояние питания устройства.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerState {
    /// Включён системный режим энергосбережения.
    pub system_saver: bool,
    /// Заряд батареи в процентах; None, если батареи нет или система не сообщает.
    pub battery_percent: Option<u8>,
    /// Подключено ли зарядное устройство; None — неизвестно.
    pub charging: Option<bool>,
}

/// Вывод `pmset -g batt`: «Now drawing from 'Battery Power' … 62%; discharging; 3:10 remaining».
pub fn parse_pmset_batt(text: &str) -> (Option<u8>, Option<bool>) {
    let percent = text.split_whitespace().find_map(|w| w.trim_end_matches(';').strip_suffix('%').and_then(|n| n.parse::<u8>().ok()));
    let low = text.to_lowercase();
    let charging = if low.contains("ac power") {
        Some(true)
    } else if low.contains("battery power") {
        Some(false)
    } else {
        None
    };
    (percent, charging)
}

/// Вывод `pmset -g`: строка «lowpowermode 1».
pub fn parse_pmset_low_power(text: &str) -> bool {
    text.lines().any(|l| {
        let mut w = l.split_whitespace();
        w.next() == Some("lowpowermode") && w.next() == Some("1")
    })
}

#[cfg(target_os = "macos")]
pub fn power_state() -> PowerState {
    let run = |args: &[&str]| std::process::Command::new("/usr/bin/pmset").args(args).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
    let (battery_percent, charging) = run(&["-g", "batt"]).map(|t| parse_pmset_batt(&t)).unwrap_or((None, None));
    PowerState { system_saver: run(&["-g"]).map(|t| parse_pmset_low_power(&t)).unwrap_or(false), battery_percent, charging }
}

#[cfg(windows)]
pub fn power_state() -> PowerState {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut st = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut st) }.is_err() {
        return PowerState::default();
    }
    PowerState {
        // Бит 0 SystemStatusFlag — включена экономия заряда.
        system_saver: st.SystemStatusFlag & 1 == 1,
        // 255 — неизвестно; BatteryFlag 128 — батареи нет.
        battery_percent: (st.BatteryLifePercent <= 100 && st.BatteryFlag & 128 == 0).then_some(st.BatteryLifePercent),
        charging: match st.ACLineStatus {
            1 => Some(true),
            0 => Some(false),
            _ => None,
        },
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn power_state() -> PowerState {
    PowerState::default()
}

/// Не даёт системе усыпить поиск, когда окно закрыто или свёрнуто (App Nap на macOS, сон на Windows).
/// Действует, пока объект жив.
pub struct KeepAwake {
    #[cfg(target_os = "macos")]
    child: Option<std::process::Child>,
    #[cfg(windows)]
    stop: Option<std::sync::mpsc::Sender<()>>,
}

impl KeepAwake {
    #[cfg(target_os = "macos")]
    pub fn new() -> Self {
        // caffeinate держит утверждение «пользователь работает», пока жив процесс-родитель.
        let child = std::process::Command::new("/usr/bin/caffeinate").args(["-i", "-w", &std::process::id().to_string()]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().ok();
        Self { child }
    }

    #[cfg(windows)]
    pub fn new() -> Self {
        use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        // Состояние действует для потока, который его задал, поэтому держим его в своём потоке.
        std::thread::spawn(move || {
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            let _ = rx.recv();
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        });
        Self { stop: Some(tx) }
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    pub fn new() -> Self {
        Self {}
    }
}

impl Default for KeepAwake {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(c) = self.child.as_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
        #[cfg(windows)]
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pmset_battery_output() {
        let on_battery = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t62%; discharging; 3:10 remaining present: true";
        assert_eq!(parse_pmset_batt(on_battery), (Some(62), Some(false)));
        let on_ac = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t100%; charged; 0:00 remaining present: true";
        assert_eq!(parse_pmset_batt(on_ac), (Some(100), Some(true)));
        assert_eq!(parse_pmset_batt("Now drawing from 'AC Power'"), (None, Some(true)), "стационарный Mac без батареи");
        assert_eq!(parse_pmset_batt(""), (None, None));
    }

    #[test]
    fn pmset_low_power_mode() {
        assert!(parse_pmset_low_power("System-wide power settings:\n sleep 1\n lowpowermode         1\n"));
        assert!(!parse_pmset_low_power(" lowpowermode         0\n"));
        assert!(!parse_pmset_low_power(""));
    }

    #[test]
    fn keep_awake_can_be_created_and_dropped() {
        let _guard = KeepAwake::new();
        let _ = power_state();
    }
}
