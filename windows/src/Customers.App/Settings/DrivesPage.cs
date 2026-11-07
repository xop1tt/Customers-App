using System.ComponentModel;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Customers.Ui;

/// <summary>
/// Облачные диски, к которым приложение подключается само: вход через браузер (Google Диск, Dropbox, OneDrive) или WebDAV
/// (Яндекс Диск, pCloud, MEGA через MEGAcmd, Nextcloud и другие). Копии базы выгружаются в папку «Customers» по кнопке.
/// </summary>
internal sealed class DrivesPage : SettingsPage
{
    private IntegrationsModel? _watched;

    public DrivesPage(AppModel model, SessionModel session, ShellView shell)
        : base(model, session, shell)
    {
        Loaded += (_, _) => Watch();
        Unloaded += (_, _) => Unwatch();
    }

    protected override SettingsSection Kind => SettingsSection.Drives;

    protected override string Lead => "Сюда выгружаются копии базы: в папку «Customers» выбранного диска, по кнопке. Приложение видит только свою папку (у Google — только свои файлы).";

    private IntegrationsModel Drives => Model.Drives;

    private void Watch()
    {
        if (!ReferenceEquals(_watched, Drives))
        {
            Unwatch();
            _watched = Drives;
            _watched.PropertyChanged += OnDrivesChanged;
        }
    }

    private void Unwatch()
    {
        if (_watched is not null)
        {
            _watched.PropertyChanged -= OnDrivesChanged;
            _watched = null;
        }
    }

    private void OnDrivesChanged(object? sender, PropertyChangedEventArgs e) => App.Instance.Ui.Post(Refresh);

    protected override void Fill()
    {
        if (Drives.Error is { } error)
        {
            Add(UiKit.Bar(InfoBarSeverity.Error, "Не получилось", error));
        }
        else if (Drives.Message is { } message)
        {
            Add(UiKit.Bar(InfoBarSeverity.Success, message, ""));
        }

        foreach (var service in Enum.GetValues<DriveService>())
        {
            Add(Row(service));
        }

        Add(UiKit.Muted("Токены и пароли хранятся только в защищённом хранилище Windows для вашей учётной записи (DPAPI), а не в базе и не в файлах настроек. "
            + "Копия базы зашифрована тем же ключом, что и рабочая база, поэтому на диске она недоступна без этого компьютера и вашей учётной записи Windows."));
    }

    private static Color Brand(DriveService s) => Appearance.ParseColor(s switch {
        DriveService.GoogleDrive => "#1A73E8",
        DriveService.Dropbox => "#0061FF",
        DriveService.OneDrive => "#0078D4",
        DriveService.YandexDisk => "#E5301B",
        DriveService.Mega => "#D9272E",
        DriveService.PCloud => "#17A2D8",
        _ => "#5C6B7A",
    })!.Value;

    private Border Row(DriveService service)
    {
        var provider = service.Auth().OAuth;
        var connected = Drives.IsConnected(service);
        var available = Drives.IsAvailable(service);
        var busyHere = Drives.Busy == service;

        var title = UiKit.HStack(8, new TextBlock { Text = service.Title(), VerticalAlignment = VerticalAlignment.Center });
        if (connected)
        {
            title.Children.Add(UiKit.Pill("подключён", UiKit.ThemeBrush("SystemFillColorSuccessBackgroundBrush"), UiKit.ThemeBrush("SystemFillColorSuccessBrush")));
        }

        var subtitle = busyHere && provider is not null
            ? "Ждём вход в браузере. Если вкладка не открылась, скопируйте ссылку и откройте её вручную."
            : available ? service.Subtitle() : "Нужен ключ приложения: нажмите «Добавить ключ»";
        var text = UiKit.VStack(2, title, UiKit.Muted(subtitle));

        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Center };
        if (busyHere)
        {
            actions.Children.Add(new ProgressRing { Width = 20, Height = 20, IsActive = true });
            if (provider is not null)
            {
                if (Drives.LoginUrl is { } url)
                {
                    actions.Children.Add(UiKit.TextButton("Копировать ссылку", () =>
                    {
                        Launcher.Copy(url);
                        Ok("Ссылка скопирована");
                    }));
                }

                actions.Children.Add(UiKit.TextButton("Отмена", Drives.CancelLogin));
            }
        }
        else if (connected)
        {
            var upload = UiKit.TextButton("Выгрузить копию", () => Upload(service), accent: true);
            upload.IsEnabled = Drives.Busy is null;
            actions.Children.Add(upload);
            actions.Children.Add(MoreMenu(service, provider, reconnect: true));
        }
        else if (provider is not null && !available)
        {
            actions.Children.Add(UiKit.TextButton("Добавить ключ", () => Run(() => KeyDialog.ShowAsync(Drives, provider.Value), "Ключ не сохранён")));
        }
        else
        {
            var connect = UiKit.TextButton("Подключиться", () => Connect(service), accent: true);
            connect.IsEnabled = Drives.Busy is null;
            actions.Children.Add(connect);
            if (provider is { } p && Drives.HasOwnKey(p))
            {
                actions.Children.Add(MoreMenu(service, provider, reconnect: false));
            }
        }

        var grid = new Grid { ColumnSpacing = 14 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var badge = Badge(service.Letter(), Brand(service));
        grid.Children.Add(badge);
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        Grid.SetColumn(actions, 2);
        grid.Children.Add(actions);
        text.VerticalAlignment = VerticalAlignment.Center;
        return UiKit.Card(grid, 14);
    }

    internal static Border Badge(string letter, Color color) => new() {
        Width = 36,
        Height = 36,
        CornerRadius = new CornerRadius(9),
        Background = new SolidColorBrush(color),
        VerticalAlignment = VerticalAlignment.Center,
        Child = new TextBlock {
            Text = letter,
            Foreground = new SolidColorBrush(Colors.White),
            FontWeight = Microsoft.UI.Text.FontWeights.SemiBold,
            FontSize = 17,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        },
    };

    private Button MoreMenu(DriveService service, OAuthProvider? provider, bool reconnect)
    {
        var menu = new MenuFlyout();
        if (reconnect)
        {
            var again = new MenuFlyoutItem { Text = "Переподключить" };
            again.Click += (_, _) => Connect(service);
            menu.Items.Add(again);
        }

        if (provider is { } p && Drives.HasOwnKey(p))
        {
            var edit = new MenuFlyoutItem { Text = "Изменить ключ…" };
            edit.Click += (_, _) => Run(() => KeyDialog.ShowAsync(Drives, p), "Ключ не сохранён");
            menu.Items.Add(edit);
            if (!reconnect)
            {
                var remove = new MenuFlyoutItem { Text = "Удалить ключ" };
                remove.Click += (_, _) => Drives.RemoveKey(p);
                menu.Items.Add(remove);
            }
        }

        if (reconnect)
        {
            var disconnect = new MenuFlyoutItem { Text = "Отключить" };
            disconnect.Click += (_, _) => Run(async () =>
            {
                if (await Dialogs.ConfirmAsync($"Отключить {service.Title()}?", "Токен доступа будет удалён с этого компьютера. Файлы на диске останутся на месте.", "Отключить"))
                {
                    Drives.Disconnect(service);
                }
            });
            menu.Items.Add(disconnect);
        }

        var button = new Button { Content = new FontIcon { Glyph = "", FontSize = 14 }, Flyout = menu };
        ToolTipService.SetToolTip(button, "Ещё");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, "Ещё");
        return button;
    }

    private void Connect(DriveService service)
    {
        if (service.Auth().IsOAuth)
        {
            Run(async () =>
            {
                if (await Drives.ConnectOAuthAsync(service))
                {
                    Ok($"{service.Title()} подключён");
                    App.Instance.MainWindow.BringToFront();
                }
            }, "Не удалось войти");
        }
        else
        {
            Run(() => WebDavDialog.ShowAsync(Drives, service), "Не удалось подключить");
        }
    }

    private void Upload(DriveService service) => Run(async () =>
    {
        if (await Model.UploadBackupAsync(service))
        {
            Ok("Копия выгружена", Drives.Message ?? "");
        }
    }, "Не удалось выгрузить копию");
}

/// <summary>«Добавить ключ»: идентификатор OAuth-приложения (и секрет для Google), созданного в консоли сервиса. Хранится только в защищённом хранилище.</summary>
internal static class KeyDialog
{
    private static string Steps(OAuthProvider p) => p switch {
        OAuthProvider.Dropbox => "Консоль Dropbox → Create app → Scoped access → App folder. На вкладке Permissions включите files.content.write и нажмите Submit. На вкладке Settings добавьте адрес возврата в Redirect URIs. App key вставьте выше.",
        OAuthProvider.Google => "Google Cloud Console → новый проект → включите Google Drive API → экран согласия OAuth (External, область drive.file, ваш Gmail в «Test users») → Credentials → OAuth client ID, тип Desktop app. Client ID и Client secret вставьте выше.",
        _ => "Microsoft Entra → App registrations → New registration («любые организации и личные учётные записи»), платформа Public client (mobile & desktop) с адресом возврата. API permissions → Microsoft Graph → Delegated: Files.ReadWrite.AppFolder и offline_access. Application (client) ID вставьте выше.",
    };

    public static async Task ShowAsync(IntegrationsModel drives, OAuthProvider provider)
    {
        var existing = drives.Key(provider);
        var id = new TextBox { Header = provider.ClientIdLabel(), Text = existing?.ClientId ?? "" };
        var secret = new PasswordBox { Header = "Client secret", Password = existing?.ClientSecret ?? "", Visibility = Fmt.Vis(provider.NeedsClientSecret()) };
        var problem = new TextBlock { Foreground = UiKit.ThemeBrush("SystemFillColorCriticalBrush"), TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed };
        var redirect = OAuthRedirect.Uri();
        var redirectRow = UiKit.HStack(8,
            new TextBlock { Text = redirect, FontFamily = new FontFamily("Consolas"), IsTextSelectionEnabled = true, VerticalAlignment = VerticalAlignment.Center },
            UiKit.IconButton(Glyphs.Copy, "Копировать адрес возврата", () => Launcher.Copy(redirect)));
        var panel = new StackPanel { Spacing = 10, MaxWidth = 480 };
        panel.Children.Add(UiKit.Muted("Один раз создайте своё бесплатное приложение в консоли сервиса и вставьте его ключ сюда."));
        panel.Children.Add(id);
        panel.Children.Add(secret);
        panel.Children.Add(UiKit.Muted(Steps(provider)));
        panel.Children.Add(UiKit.Muted("Адрес возврата (Redirect URI):"));
        panel.Children.Add(redirectRow);
        panel.Children.Add(new HyperlinkButton { Content = "Открыть консоль сервиса", NavigateUri = provider.ConsolePage(), Padding = new Thickness(0) });
        panel.Children.Add(problem);

        var service = provider.Service();
        var dialog = new ContentDialog {
            Title = $"Ключ приложения для {service.Title()}",
            Content = new ScrollViewer { Content = panel, MaxHeight = 520 },
            PrimaryButtonText = "Сохранить",
            CloseButtonText = "Отмена",
            DefaultButton = ContentDialogButton.Primary,
        };
        if (drives.HasOwnKey(provider))
        {
            dialog.SecondaryButtonText = "Удалить ключ";
        }

        dialog.PrimaryButtonClick += (_, e) =>
        {
            if (drives.SaveKey(provider, new OAuthKey(id.Text, secret.Password)) is { } error)
            {
                problem.Text = error;
                problem.Visibility = Visibility.Visible;
                e.Cancel = true;
            }
        };
        var result = await Dialogs.ShowAsync(dialog);
        if (result == ContentDialogResult.Secondary)
        {
            drives.RemoveKey(provider);
        }
    }
}

/// <summary>Подключение по WebDAV: адрес, логин и пароль приложения. Данные проверяются запросом к серверу, пока диалог открыт.</summary>
internal static class WebDavDialog
{
    private static string Hint(DriveService s) => s switch {
        DriveService.YandexDisk => "Логин — адрес Яндекса. Пароль — пароль приложения с доступом к «Файлам» (id.yandex.ru → Безопасность → Пароли приложений), не основной пароль.",
        DriveService.Mega => "MEGA не даёт входить сторонним приложениям. Установите бесплатный MEGAcmd, войдите в нём и выполните в командной строке «mega-webdav /Customers» — он покажет адрес вида http://127.0.0.1:4443/…/Customers/. Вставьте его сюда.",
        DriveService.PCloud => "Европейские аккаунты: ewebdav.pcloud.com, американские: webdav.pcloud.com. Логин и пароль — от pCloud.",
        _ => "Адрес WebDAV даёт ваш сервер, например https://cloud.example.ru/remote.php/dav/files/имя/ для Nextcloud. Лучше создать отдельный пароль приложения.",
    };

    public static async Task ShowAsync(IntegrationsModel drives, DriveService service)
    {
        var current = drives.Connections.GetValueOrDefault(service);
        var url = new TextBox { Header = "Адрес WebDAV", PlaceholderText = "https://…", Text = current?.WebDavUrl ?? service.Auth().DefaultUrl };
        var login = new TextBox { Header = "Логин", PlaceholderText = service.PasswordOptional() ? "не нужен для MEGAcmd" : "логин или email", Text = current?.Login ?? "" };
        var password = new PasswordBox { Header = "Пароль приложения", PlaceholderText = service.PasswordOptional() ? "не нужен для MEGAcmd" : "" };
        var error = new TextBlock { Foreground = UiKit.ThemeBrush("SystemFillColorCriticalBrush"), TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed };
        var panel = new StackPanel { Spacing = 10, MaxWidth = 460 };
        panel.Children.Add(UiKit.Muted(service.Subtitle()));
        panel.Children.Add(url);
        panel.Children.Add(login);
        panel.Children.Add(password);
        panel.Children.Add(UiKit.Muted(Hint(service)));
        if (service.Auth().PasswordPage is { } page)
        {
            panel.Children.Add(new HyperlinkButton { Content = service == DriveService.Mega ? "Скачать MEGAcmd" : "Создать пароль приложения", NavigateUri = page, Padding = new Thickness(0) });
        }

        panel.Children.Add(error);
        var dialog = new ContentDialog {
            Title = $"Подключить {service.Title()}",
            Content = new ScrollViewer { Content = panel, MaxHeight = 520 },
            PrimaryButtonText = "Подключиться",
            CloseButtonText = "Отмена",
            DefaultButton = ContentDialogButton.Primary,
        };
        dialog.PrimaryButtonClick += async (_, e) =>
        {
            var deferral = e.GetDeferral();
            try
            {
                var missing = url.Text.Trim().Length == 0 || (!service.PasswordOptional() && (login.Text.Trim().Length == 0 || password.Password.Length == 0));
                if (missing)
                {
                    error.Text = "Заполните адрес, логин и пароль приложения.";
                    error.Visibility = Visibility.Visible;
                    e.Cancel = true;
                }
                else if (!await drives.ConnectWebDavAsync(service, url.Text, login.Text, password.Password))
                {
                    error.Text = drives.Error ?? "Не удалось подключиться.";
                    error.Visibility = Visibility.Visible;
                    e.Cancel = true;
                }
            }
            finally
            {
                deferral.Complete();
            }
        };
        if (await Dialogs.ShowAsync(dialog) == ContentDialogResult.Primary)
        {
            Notify(NoticeKind.Success, $"{service.Title()} подключён");
        }
    }

    private static void Notify(NoticeKind kind, string title) => App.Instance.Notifier.Post(new Notice(kind, title, ""));
}
