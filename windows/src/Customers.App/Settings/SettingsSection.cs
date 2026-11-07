namespace Customers.Ui;

/// <summary>Разделы настроек (в таком порядке они показаны в списке слева).</summary>
public enum SettingsSection
{
    Appearance,
    Background,
    Account,
    Search,
    Sources,
    Filters,
    Exclusions,
    Integrations,
    Drives,
    Mail,
    Calls,
    Cloud,
    Backup,
    ExportImport,
    Notifications,
    Data,
    About,
}

public static class SettingsSections
{
    public static string Title(this SettingsSection s) => s switch {
        SettingsSection.Appearance => "Внешний вид",
        SettingsSection.Background => "Работа в фоне",
        SettingsSection.Account => "Учётная запись",
        SettingsSection.Search => "Поиск",
        SettingsSection.Sources => "Источники",
        SettingsSection.Filters => "Фильтры",
        SettingsSection.Exclusions => "Исключения",
        SettingsSection.Integrations => "Интеграции",
        SettingsSection.Drives => "Облачные диски",
        SettingsSection.Mail => "Почта",
        SettingsSection.Calls => "Звонки",
        SettingsSection.Cloud => "Облачная синхронизация",
        SettingsSection.Backup => "Резервные копии",
        SettingsSection.ExportImport => "Экспорт и импорт",
        SettingsSection.Notifications => "Уведомления",
        SettingsSection.Data => "Данные",
        _ => "О программе",
    };

    public static string Glyph(this SettingsSection s) => s switch {
        SettingsSection.Appearance => "",
        SettingsSection.Background => "",
        SettingsSection.Account => "",
        SettingsSection.Search => "",
        SettingsSection.Sources => "",
        SettingsSection.Filters => "",
        SettingsSection.Exclusions => "",
        SettingsSection.Integrations => "",
        SettingsSection.Drives => "",
        SettingsSection.Mail => "",
        SettingsSection.Calls => "",
        SettingsSection.Cloud => "",
        SettingsSection.Backup => "",
        SettingsSection.ExportImport => "",
        SettingsSection.Notifications => "",
        SettingsSection.Data => "",
        _ => "",
    };
}
