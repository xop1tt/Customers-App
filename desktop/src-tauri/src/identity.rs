//! Идентичность установленного приложения: идентификатор, папки данных, имена секретов, схема ссылок.
//!
//! Эти значения уже записаны на компьютерах пользователей (папки, Связка ключей, DPAPI, ссылки из писем):
//! их изменение потеряло бы данные или ключи, поэтому тест ниже их закрепляет.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Identity {
    /// Идентификатор приложения (bundle id macOS, имя для single-instance, папка WebView, уведомления).
    pub identifier: &'static str,
    pub product_name: &'static str,
    /// Схема ссылок возврата из писем (подтверждение адреса, восстановление пароля, приглашения).
    pub url_scheme: &'static str,
    /// Сервис записей в Связке ключей macOS.
    pub keychain_service: &'static str,
    /// Дополнительная энтропия DPAPI на Windows.
    pub dpapi_entropy: &'static [u8],
    /// Папки данных и журналов.
    pub mac_data: &'static str,
    pub mac_logs: &'static str,
    pub windows_data: &'static str,
    pub linux_data: &'static str,
    /// Папка резервных копий в «Документах».
    pub backups: &'static str,
    /// Начало имени файлов релиза: Customers-v1.2.0-macOS.dmg.
    pub asset_prefix: &'static str,
    /// Имя исполняемого файла: по нему macOS называет отчёты о сбоях.
    pub binary: &'static str,
}

pub const APP: Identity = Identity {
    identifier: "local.leadgenerator.app",
    product_name: "Customers",
    url_scheme: "leadgenerator",
    keychain_service: "LeadGenerator",
    dpapi_entropy: b"Customers.Secrets.v1",
    mac_data: "Library/Application Support/Lead Generator",
    mac_logs: "Library/Logs/LeadGenerator",
    windows_data: "Customers",
    linux_data: ".local/share/customers",
    backups: "Customers Backups",
    asset_prefix: "Customers-v",
    binary: "customers",
};

/// Идентификатор из конфигурации Tauri совпадает с тем, под которым приложение хранит данные.
/// Иначе запуск останавливается до создания файлов: сборка с чужой конфигурацией не тронет данные.
pub fn check_identifier(actual: &str) -> Result<(), String> {
    if actual == APP.identifier {
        Ok(())
    } else {
        Err(format!("Приложение запущено с идентификатором «{actual}», нужен «{}». Запуск остановлен, чтобы не тронуть данные.", APP.identifier))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_matches_previous_versions() {
        // Эти значения уже записаны у пользователей: изменение потеряло бы данные или ключи.
        assert_eq!(APP.identifier, "local.leadgenerator.app");
        assert_eq!(APP.product_name, "Customers");
        assert_eq!(APP.url_scheme, "leadgenerator");
        assert_eq!(APP.keychain_service, "LeadGenerator");
        assert_eq!(APP.dpapi_entropy, b"Customers.Secrets.v1");
        assert_eq!(APP.mac_data, "Library/Application Support/Lead Generator");
        assert_eq!(APP.mac_logs, "Library/Logs/LeadGenerator");
        assert_eq!(APP.windows_data, "Customers");
        assert_eq!(APP.linux_data, ".local/share/customers");
        assert_eq!(APP.backups, "Customers Backups");
        assert_eq!(APP.asset_prefix, "Customers-v");
        assert_eq!(APP.binary, "customers");
    }

    #[test]
    fn identifier_matches_tauri_config() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], APP.identifier);
        assert_eq!(conf["productName"], APP.product_name);
        assert_eq!(conf["plugins"]["deep-link"]["desktop"]["schemes"][0], APP.url_scheme);
    }

    #[test]
    fn identifier_mismatch_stops_start() {
        assert!(check_identifier("local.leadgenerator.app").is_ok());
        let e = check_identifier("local.other.app").unwrap_err();
        assert!(e.contains("local.other.app") && e.contains("local.leadgenerator.app"), "{e}");
    }
}
