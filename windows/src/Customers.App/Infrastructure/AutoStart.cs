using System.Runtime.Versioning;
using Microsoft.Win32;

namespace Customers.Ui;

/// <summary>
/// Запуск вместе с Windows: значение в разделе Run текущего пользователя (права администратора не нужны, в «Параметры → Приложения →
/// Автозагрузка» оно отображается и отключается как обычное). Если выбран запуск в фоне, добавляется ключ --background.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class AutoStart
{
    private const string KeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "Customers";

    public static string Command(bool background) => $"\"{Environment.ProcessPath}\"" + (background ? " --background" : "");

    public static bool IsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(KeyPath);
            return key?.GetValue(ValueName) is string { Length: > 0 };
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }

    /// <summary>Включает или выключает автозапуск. Возвращает false, если Windows не дала записать значение.</summary>
    public static bool Set(bool enabled, bool background)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(KeyPath, writable: true);
            if (enabled)
            {
                key.SetValue(ValueName, Command(background), RegistryValueKind.String);
            }
            else
            {
                key.DeleteValue(ValueName, throwOnMissingValue: false);
            }

            return true;
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            App.Instance.Env.Log.Warn("Автозапуск не изменён: " + e.Message);
            return false;
        }
    }

    /// <summary>Если автозапуск включён, обновляет команду (например, после переноса программы в другую папку).</summary>
    public static void Refresh(bool background)
    {
        if (IsEnabled() && Environment.ProcessPath is not null)
        {
            Set(true, background);
        }
    }
}
