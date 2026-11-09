//! Debug Menu: только канал Beta (признак Cargo `beta`). В Stable этого модуля нет: строка подключения в `lib.rs`
//! стоит под `#[cfg(feature = "beta")]`, а `scripts/release-check.cjs` отклоняет сборку, если это не так.
//!
//! Разделы (docs/DEBUG_MENU.md): журнал событий, Dashboard, диагностика с отчётом ZIP, тестовые данные,
//! Scenario Runner. Все значения — настоящие; если показатель недоступен на этой системе, он так и называется.

pub mod commands;
pub mod dashboard;
pub mod diagnostics;
pub mod log;
pub mod scenarios;
pub mod testdata;
pub mod zip;

/// Имена команд Debug Menu начинаются с этого префикса: по нему вызов уходит в обработчик Debug Menu.
pub const COMMAND_PREFIX: &str = "debug_";
