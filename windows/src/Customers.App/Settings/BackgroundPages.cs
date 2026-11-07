using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>«Работа в фоне»: значок в области уведомлений, закрытие окна в трей, запуск вместе с Windows.</summary>
internal sealed class BackgroundPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    protected override SettingsSection Kind => SettingsSection.Background;

    protected override string Lead => "Приложение может работать без окна: автопоиск, ежедневные копии и синхронизация продолжаются, а новые лиды приходят уведомлениями Windows.";

    protected override void Fill()
    {
        var host = App.Instance.Background;
        Add(host.Available
            ? UiKit.Bar(InfoBarSeverity.Success, "Значок в области уведомлений показан",
                "Щелчок по значку открывает окно, правая кнопка — меню: найти сейчас, новые лиды, настройки, выход. Если значка не видно, он спрятан под стрелкой «Скрытые значки» рядом с часами.")
            : UiKit.Bar(InfoBarSeverity.Warning, "Значок в области уведомлений недоступен",
                "Windows не позволила его создать, поэтому закрытие окна завершает приложение, а не прячет его."));

        Add(UiKit.SettingRow("Продолжать работу при закрытии окна", "Крестик в заголовке убирает окно в область уведомлений. Полностью выйти можно из меню значка.",
            UiKit.Toggle(Device.CloseToTray, v => Device.CloseToTray = v)));

        var startWithWindows = AutoStart.IsEnabled();
        var minimized = UiKit.Toggle(Device.StartMinimized, v =>
        {
            Device.StartMinimized = v;
            AutoStart.Refresh(v);
        });
        minimized.IsEnabled = startWithWindows;
        Add(UiKit.SettingRow("Запускать вместе с Windows", "Приложение стартует при входе в систему. Отключить можно и в «Параметры → Приложения → Автозагрузка».",
            UiKit.Toggle(startWithWindows, v =>
            {
                if (!AutoStart.Set(v, Device.StartMinimized))
                {
                    Fail("Не удалось изменить автозапуск", "Windows не дала записать настройку автозагрузки.");
                }

                Refresh();
            })));
        Add(UiKit.SettingRow("Не показывать окно при запуске вместе с Windows", "Приложение сразу уйдёт в область уведомлений. Если нужно войти в учётную запись, окно откроется само.", minimized));

        Heading("Что работает в фоне");
        var minutes = Model.AutoSearchMinutes;
        Add(UiKit.SettingRow("Автопоиск", minutes > 0 ? $"Каждые {minutes} мин: проверяются источники, у которых подошёл срок." : "Выключен. Включите его, чтобы новые лиды искались сами.",
            UiKit.TextButton("Настроить", () => Shell.OpenSettings(SettingsSection.Search))));
        Add(UiKit.SettingRow("Уведомления о новых лидах", Model.Prefs.NotifyNewLeads ? "Включены: если окно не на экране, приходит уведомление Windows." : "Выключены: о новых лидах вы узнаете, открыв окно.",
            UiKit.TextButton("Настроить", () => Shell.OpenSettings(SettingsSection.Notifications))));
        Add(UiKit.SettingRow("Ежедневная резервная копия", Model.Prefs.AutoBackup ? "Включена: копия создаётся раз в сутки, пока приложение работает." : "Выключена.",
            UiKit.TextButton("Настроить", () => Shell.OpenSettings(SettingsSection.Backup))));

        Heading("Значок в области уведомлений");
        Add(UiKit.SettingRow("Какие значки показывать", "В Windows 11 новые значки сначала прячутся. Откройте параметры панели задач и включите значок Customers.",
            UiKit.TextButton("Открыть параметры", () => _ = Windows.System.Launcher.LaunchUriAsync(new Uri("ms-settings:taskbar")))));
    }
}

/// <summary>«Звонки»: как работает кнопка «Позвонить» в карточке лида и какое приложение Windows принимает звонки.</summary>
internal sealed class CallsPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    protected override SettingsSection Kind => SettingsSection.Calls;

    protected override string Lead => "Кнопка «Позвонить» открывает номер в приложении Windows для звонков и записывает звонок в историю лида.";

    protected override void Fill()
    {
        var status = UiKit.Muted("Проверяю…");
        var apps = new TextBlock { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
        var check = UiKit.TextButton("Проверить", () => Run(() => ShowHandlersAsync(status, apps)));
        Add(UiKit.Card(UiKit.VStack(8, UiKit.Strong("Приложение для звонков"), status, apps, check)));
        Run(() => ShowHandlersAsync(status, apps));

        Add(UiKit.SettingRow("Подтверждать звонок", "Перед набором показывать номер и спрашивать, звонить ли. Защищает от случайного нажатия.",
            UiKit.Toggle(Model.Prefs.ConfirmCalls, v => Model.Prefs.ConfirmCalls = v)));

        Heading("Настройка Windows");
        // «Связь с телефоном» нужна только если звонки идут через неё: при стороннем приложении (например, WhatsApp) строка лишняя.
        if (!CallHandlers.DefaultIsThirdParty())
        {
            Add(UiKit.SettingRow("Связь с телефоном", "Подключите Android-телефон или iPhone, чтобы звонить с компьютера по обычной мобильной связи.",
                UiKit.TextButton("Открыть", () => _ = Windows.System.Launcher.LaunchUriAsync(new Uri("ms-settings:mobile-devices")))));
        }

        Add(UiKit.SettingRow("Приложение по умолчанию", "Выберите, какое приложение принимает звонки по ссылкам tel: (WhatsApp, Связь с телефоном, Teams, Zoom и другие).",
            UiKit.TextButton("Открыть", () => Run(CallHandlers.OpenDefaultAppSettingsAsync))));

        Heading("Проверка");
        var number = new TextBox { PlaceholderText = "+7 900 000-00-00", Width = 220, Header = "Номер" };
        var result = new TextBlock { TextWrapping = TextWrapping.Wrap };
        var dial = UiKit.TextButton("Набрать", () => Run(async () =>
        {
            if (ContactLinks.TelUri(number.Text) is not { } uri)
            {
                result.Text = "Не похоже на номер телефона.";
                return;
            }

            result.Text = await Launcher.OpenAsync(uri)
                ? $"Номер {uri.AbsoluteUri[4..]} передан приложению для звонков."
                : "Не найдено приложение для звонков. Установите «Связь с телефоном» или выберите программу по умолчанию выше.";
        }));
        Add(UiKit.Card(UiKit.VStack(8, UiKit.Muted("Проверьте, что Windows знает, чем звонить: введите свой номер."), UiKit.HStack(8, number, new StackPanel { VerticalAlignment = VerticalAlignment.Bottom, Children = { dial } }), result)));
    }

    private static async Task ShowHandlersAsync(TextBlock status, TextBlock apps)
    {
        var names = await CallHandlers.FindAsync();
        if (names.Count > 0)
        {
            status.Text = "Найдено: звонки откроются в приложении по умолчанию.";
            apps.Text = string.Join(", ", names);
            apps.Visibility = Visibility.Visible;
        }
        else
        {
            status.Text = "Приложение для звонков не найдено. Без него кнопка «Позвонить» не сработает.";
            apps.Visibility = Visibility.Collapsed;
        }
    }
}

/// <summary>Приложения, зарегистрированные в Windows для ссылок tel:.</summary>
internal static class CallHandlers
{
    private const string TelAssociation = @"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\tel\UserChoice";

    /// <summary>
    /// Открывает «Приложения по умолчанию» сразу на ссылках tel: (параметр registrypath понимает Windows 11; на старых сборках он
    /// игнорируется и открывается общий список — тогда выбрать «Выбор значений по умолчанию по типам ссылок → TEL»).
    /// </summary>
    public static async Task OpenDefaultAppSettingsAsync()
    {
        var direct = new Uri("ms-settings:defaultapps?registrypath=" + Uri.EscapeDataString(@"Computer\HKEY_CURRENT_USER\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\tel"));
        if (!await Windows.System.Launcher.LaunchUriAsync(direct))
        {
            await Windows.System.Launcher.LaunchUriAsync(new Uri("ms-settings:defaultapps"));
        }
    }

    /// <summary>Назначено ли для tel: стороннее приложение (не «Связь с телефоном»). Нет выбора — считаем, что нет.</summary>
    public static bool DefaultIsThirdParty()
    {
        try
        {
            using var choice = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(TelAssociation);
            if (choice?.GetValue("ProgId") as string is not { Length: > 0 } progId)
            {
                return false;
            }

            using var app = Microsoft.Win32.Registry.ClassesRoot.OpenSubKey(progId + @"\Application");
            var id = (app?.GetValue("AppUserModelID") as string ?? app?.GetValue("ApplicationName") as string ?? progId);
            return IsThirdParty(id);
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException or ArgumentException)
        {
            return false;
        }
    }

    internal static bool IsThirdParty(string appId) =>
        appId.Length > 0 && !appId.Contains("YourPhone", StringComparison.OrdinalIgnoreCase) && !appId.Contains("PhoneExperience", StringComparison.OrdinalIgnoreCase)
        && !appId.Contains("PhoneLink", StringComparison.OrdinalIgnoreCase);

    public static async Task<IReadOnlyList<string>> FindAsync()
    {
        try
        {
            var handlers = await Windows.System.Launcher.FindUriSchemeHandlersAsync("tel");
            return [.. handlers.Select(h => h.DisplayInfo.DisplayName).Where(n => n.Length > 0).Distinct()];
        }
        catch (Exception e) when (e is System.Runtime.InteropServices.COMException or InvalidOperationException or ArgumentException or NotSupportedException)
        {
            // Старые сборки Windows 10 не умеют перечислять обработчики: тогда достаточно узнать, есть ли хоть один.
            try
            {
                var support = await Windows.System.Launcher.QueryUriSupportAsync(new Uri("tel:+10000000000"), Windows.System.LaunchQuerySupportType.Uri);
                return support == Windows.System.LaunchQuerySupportStatus.Available ? ["Приложение по умолчанию"] : [];
            }
            catch (Exception inner) when (inner is System.Runtime.InteropServices.COMException or InvalidOperationException or ArgumentException)
            {
                return [];
            }
        }
    }
}
