using System.ComponentModel;
using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;
using WinRT.Interop;

namespace Customers.Ui;

public sealed partial class MainWindow : Window
{
    private readonly SessionModel _session = App.Instance.Session;
    private readonly DevicePreferences _device = App.Instance.Env.Device;
    private CloudSyncController? _watchedSync;
    private bool _closing;

    public MainWindow()
    {
        InitializeComponent();
        Title = "Customers";
        AppWindow.Title = "Customers";
        try
        {
            AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"));
        }
        catch (Exception e) when (e is System.Runtime.InteropServices.COMException or ArgumentException or IOException)
        {
            App.Instance.Env.Log.Warn("Значок окна не установлен: " + e.Message);
        }

        if (AppWindowTitleBar.IsCustomizationSupported())
        {
            ExtendsContentIntoTitleBar = true;
            SetTitleBar(TitleBar);
            AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        }
        else
        {
            TitleBar.Visibility = Visibility.Collapsed; // старый стандартный заголовок
        }

        RestoreWindowPlacement();
        ApplyAppearance();
        Root.ActualThemeChanged += (_, _) => Appearance.StyleTitleBar(AppWindow, Root.ActualTheme == ElementTheme.Dark);
        Root.SizeChanged += (_, _) => UpdateInsets();
        _device.PropertyChanged += OnDeviceChanged;
        _session.PropertyChanged += OnSessionChanged;
        Activated += (_, e) =>
        {
            App.Instance.Notifier.WindowActive = e.WindowActivationState != WindowActivationState.Deactivated;
            if (e.WindowActivationState != WindowActivationState.Deactivated)
            {
                Shell?.TryPresentStartupScreens(); // запуск был в фоне: экраны первого запуска ждали показа окна
            }
        };
        AppWindow.Closing += OnAppWindowClosing;
        Closed += OnClosed;
        Root.KeyboardAccelerators.Add(Accelerator(Windows.System.VirtualKey.B, Windows.System.VirtualKeyModifiers.Control, TogglePane));
        ShowContent();
    }

    public FrameworkElement RootElement => Root;

    public ShellView? Shell => Host.Content as ShellView;

    private static Microsoft.UI.Xaml.Input.KeyboardAccelerator Accelerator(Windows.System.VirtualKey key, Windows.System.VirtualKeyModifiers modifiers, Action action)
    {
        var accelerator = new Microsoft.UI.Xaml.Input.KeyboardAccelerator { Key = key, Modifiers = modifiers };
        accelerator.Invoked += (_, e) =>
        {
            action();
            e.Handled = true;
        };
        return accelerator;
    }

    // MARK: Внешний вид

    private void ApplyAppearance()
    {
        Root.RequestedTheme = Appearance.ToElementTheme(_device.Theme);
        SystemBackdrop = Appearance.CreateBackdrop(_device.Backdrop);
        // Без прозрачного материала нужен обычный фон окна, иначе будет виден фон рабочего стола.
        Root.Background = SystemBackdrop is null ? (Brush)Application.Current.Resources["ApplicationPageBackgroundThemeBrush"] : null;
        Appearance.StyleTitleBar(AppWindow, Root.ActualTheme == ElementTheme.Dark);
    }

    private void OnDeviceChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(DevicePreferences.Theme) or nameof(DevicePreferences.Backdrop))
        {
            ApplyAppearance();
        }
        else if (e.PropertyName is nameof(DevicePreferences.Accent))
        {
            // Цвет меняется на лету: подменяем ресурсы и просим уже показанные элементы прочитать их заново.
            Appearance.ApplyAccent(_device.Accent);
            Appearance.Refresh(Root);
            Appearance.StyleTitleBar(AppWindow, Root.ActualTheme == ElementTheme.Dark);
        }
    }

    private void UpdateInsets()
    {
        if (!AppWindowTitleBar.IsCustomizationSupported() || Root.XamlRoot is not { } xamlRoot)
        {
            return;
        }

        var scale = xamlRoot.RasterizationScale;
        LeftInset.Width = new GridLength(AppWindow.TitleBar.LeftInset / scale);
        RightInset.Width = new GridLength(AppWindow.TitleBar.RightInset / scale);
    }

    // MARK: Размер и положение окна

    private IntPtr Handle => WindowNative.GetWindowHandle(this);

    private double Scale => SingleInstance.GetDpiForWindow(Handle) / 96.0;

    private void RestoreWindowPlacement()
    {
        try
        {
            var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
            var scale = Scale;
            var width = Math.Min((int)(_device.WindowWidth * scale), area.Width);
            var height = Math.Min((int)(_device.WindowHeight * scale), area.Height);
            AppWindow.Resize(new SizeInt32(width, height));
            AppWindow.Move(new PointInt32(area.X + ((area.Width - width) / 2), area.Y + ((area.Height - height) / 2)));
            if (_device.Maximized && AppWindow.Presenter is OverlappedPresenter presenter)
            {
                presenter.Maximize();
            }
        }
        catch (Exception e) when (e is System.Runtime.InteropServices.COMException or ArgumentException or InvalidOperationException)
        {
            App.Instance.Env.Log.Warn("Размер окна не восстановлен: " + e.Message);
        }
    }

    private void SaveWindowPlacement()
    {
        try
        {
            if (AppWindow.Presenter is OverlappedPresenter presenter)
            {
                _device.Maximized = presenter.State == OverlappedPresenterState.Maximized;
                if (presenter.State == OverlappedPresenterState.Minimized)
                {
                    return;
                }

                if (presenter.State == OverlappedPresenterState.Restored)
                {
                    var scale = Scale;
                    _device.WindowWidth = AppWindow.Size.Width / scale;
                    _device.WindowHeight = AppWindow.Size.Height / scale;
                }
            }
        }
        catch (Exception e) when (e is System.Runtime.InteropServices.COMException or InvalidOperationException)
        {
            App.Instance.Env.Log.Warn("Размер окна не сохранён: " + e.Message);
        }
    }

    /// <summary>Окно спрятано в область уведомлений (приложение продолжает работать).</summary>
    public bool IsHiddenToTray { get; private set; }

    /// <summary>Окно не показывалось при запуске (запуск в фоне): первый показ сделает <see cref="BringToFront"/>.</summary>
    public void MarkHiddenAtStart() => IsHiddenToTray = true;

    private void OnAppWindowClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        var background = App.Instance.Background;
        if (_device.CloseToTray && background.Available && !background.Quitting)
        {
            args.Cancel = true;
            HideToTray();
        }
    }

    /// <summary>Прячет окно. Сообщает о фоновой работе при первом разе, чтобы закрытие окна не выглядело как пропажа приложения.</summary>
    public void HideToTray()
    {
        SaveWindowPlacement();
        AppWindow.Hide();
        IsHiddenToTray = true;
        if (!_device.TrayHintShown)
        {
            _device.TrayHintShown = true;
            App.Instance.Notifier.Toast("Customers продолжает работать в фоне",
                "Автопоиск и копии идут как обычно. Значок в области уведомлений откроет окно, а меню значка — выйдет из приложения.", force: true);
        }
    }

    public void BringToFront()
    {
        if (IsHiddenToTray)
        {
            IsHiddenToTray = false;
            AppWindow.Show();
        }

        if (SingleInstance.IsIconic(Handle))
        {
            SingleInstance.ShowWindow(Handle, 9 /* SW_RESTORE */);
        }

        Activate();
        SingleInstance.SetForegroundWindow(Handle);
    }

    private void OnClosed(object sender, WindowEventArgs args)
    {
        if (_closing)
        {
            return;
        }

        _closing = true;
        SaveWindowPlacement();
        _device.PropertyChanged -= OnDeviceChanged;
        _session.PropertyChanged -= OnSessionChanged;
        if (_watchedSync is not null)
        {
            _watchedSync.PropertyChanged -= OnSyncChanged;
        }

        App.Instance.Background.Dispose();
        App.Instance.Notifier.ShutdownSystem();
        // Закрыть базу аккуратно: ожидающая запись в журнале WAL попадает в основной файл.
        _session.Sync?.Dispose();
        _session.Current?.Shutdown();
        App.Instance.Env.Log.Info("Выход");
    }

    // MARK: Содержимое

    private void OnSessionChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(SessionModel.Current) or nameof(SessionModel.IsSignedIn))
        {
            ShowContent();
        }
        else if (e.PropertyName is nameof(SessionModel.Sync))
        {
            WatchSync();
        }
    }

    private void ShowContent()
    {
        if (_session.Current is { StartupError: not null } broken)
        {
            if (Host.Content is not DatabaseErrorView view || !ReferenceEquals(view.Model, broken))
            {
                (Host.Content as ShellView)?.Detach();
                Host.Content = new DatabaseErrorView(broken, _session);
            }
        }
        else if (_session.Current is { } model)
        {
            if (Host.Content is not ShellView shell || !ReferenceEquals(shell.Model, model))
            {
                (Host.Content as ShellView)?.Detach();
                Host.Content = new ShellView(model, _session);
            }
        }
        else if (Host.Content is not AuthView)
        {
            (Host.Content as ShellView)?.Detach();
            Host.Content = new AuthView(_session);
        }

        UpdateAccountButton();
        WatchSync();
    }

    // MARK: Кнопки заголовка

    private void OnPaneButtonClick(object sender, RoutedEventArgs e) => TogglePane();

    private void TogglePane()
    {
        if (_session.Current is not null)
        {
            _device.NavHidden = !_device.NavHidden;
        }
    }

    private void UpdateAccountButton()
    {
        var signedIn = _session.Current is not null;
        PaneButton.Visibility = signedIn ? Visibility.Visible : Visibility.Collapsed;
        AccountButton.Visibility = signedIn ? Visibility.Visible : Visibility.Collapsed;
        AccountText.Text = _session.Current?.DisplayName ?? "";
    }

    private void OnAccountMenuOpening(object? sender, object e)
    {
        AccountMenu.Items.Clear();
        if (_session.Current is not { } model)
        {
            return;
        }

        AccountMenu.Items.Add(new MenuFlyoutItem { Text = model.DisplayName, IsEnabled = false });
        AccountMenu.Items.Add(new MenuFlyoutItem { Text = model.IsCloud ? "Облачная учётная запись" : "Локальная учётная запись", IsEnabled = false });
        AccountMenu.Items.Add(new MenuFlyoutSeparator());
        var settings = new MenuFlyoutItem { Text = "Настройки учётной записи", Icon = new FontIcon { Glyph = "" } };
        settings.Click += (_, _) => Shell?.OpenSettings(SettingsSection.Account);
        AccountMenu.Items.Add(settings);
        var signOut = new MenuFlyoutItem { Text = "Выйти", Icon = new FontIcon { Glyph = "" } };
        signOut.Click += (_, _) => _session.Logout();
        AccountMenu.Items.Add(signOut);
    }

    // MARK: Синхронизация в заголовке

    private void WatchSync()
    {
        if (!ReferenceEquals(_watchedSync, _session.Sync))
        {
            if (_watchedSync is not null)
            {
                _watchedSync.PropertyChanged -= OnSyncChanged;
            }

            _watchedSync = _session.Sync;
            if (_watchedSync is not null)
            {
                _watchedSync.PropertyChanged += OnSyncChanged;
            }
        }

        UpdateSyncButton();
    }

    private void OnSyncChanged(object? sender, PropertyChangedEventArgs e) => UpdateSyncButton();

    private void UpdateSyncButton()
    {
        if (_watchedSync is not { } sync)
        {
            SyncButton.Visibility = Visibility.Collapsed;
            return;
        }

        SyncButton.Visibility = Visibility.Visible;
        SyncText.Text = sync.Summary;
        SyncGlyph.Glyph = sync.Glyph;
        ToolTipService.SetToolTip(SyncButton, sync.ErrorText is { Length: > 0 } err ? err : "Синхронизировать сейчас");
    }

    private void OnSyncClick(object sender, RoutedEventArgs e) => _ = _watchedSync?.SyncNow();
}
