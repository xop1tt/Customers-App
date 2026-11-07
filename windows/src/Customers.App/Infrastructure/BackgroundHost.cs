using System.ComponentModel;

namespace Customers.Ui;

/// <summary>
/// Работа в фоне: значок в области уведомлений, меню значка, подсказка с числом новых лидов, скрытие окна вместо выхода.
/// Пока приложение в фоне, продолжают работать автопоиск, ежедневные копии и синхронизация (они живут в модели, а не в окне).
/// Если Windows не дала создать значок, окно закрывается как обычно: спрятанное окно без значка нельзя было бы вернуть.
/// </summary>
internal sealed class BackgroundHost : IDisposable
{
    private const int CmdOpen = 1;
    private const int CmdSearch = 2;
    private const int CmdStop = 3;
    private const int CmdNew = 4;
    private const int CmdSettings = 5;
    private const int CmdExit = 6;

    private TrayIcon? _tray;
    private AppModel? _watched;

    /// <summary>Значок показан, значит окно можно прятать.</summary>
    public bool Available => _tray?.IsShown == true;

    /// <summary>Приложение закрывается по-настоящему (выход из меню, выход из Windows, обновление): прятать окно нельзя.</summary>
    public bool Quitting { get; private set; }

    public bool Start()
    {
        if (_tray is not null)
        {
            return Available;
        }

        try
        {
            var tray = new TrayIcon(Items, OnCommand);
            tray.Activated += () => App.Instance.MainWindow.BringToFront();
            tray.SessionEnding += Quit;
            if (!tray.Create(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"), Tip()))
            {
                App.Instance.Env.Log.Warn("Значок в области уведомлений не создан: Windows не приняла его");
                tray.Dispose();
                return false;
            }

            _tray = tray;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or DllNotFoundException or EntryPointNotFoundException or InvalidOperationException)
        {
            App.Instance.Env.Log.Warn("Значок в области уведомлений не создан: " + e.Message);
            return false;
        }

        App.Instance.Session.PropertyChanged += OnSessionChanged;
        Watch(App.Instance.Session.Current);
        return true;
    }

    private void OnSessionChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(SessionModel.Current))
        {
            Watch(App.Instance.Session.Current);
        }
    }

    private void Watch(AppModel? model)
    {
        if (_watched is not null)
        {
            _watched.PropertyChanged -= OnModelChanged;
            _watched.DataReloaded -= UpdateTip;
        }

        _watched = model;
        if (model is not null)
        {
            model.PropertyChanged += OnModelChanged;
            model.DataReloaded += UpdateTip;
        }

        UpdateTip();
    }

    private void OnModelChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(AppModel.Searching))
        {
            UpdateTip();
        }
    }

    public string Tip() => _watched switch {
        null => "Customers — войдите в учётную запись",
        { StartupError: not null } => "Customers — база не открыта",
        { } m => $"Customers — новых лидов: {m.NewLeads}" + (m.Searching ? "\nИдёт поиск…" : ""),
    };

    public void UpdateTip() => _tray?.SetTip(Tip());

    /// <summary>Пункты меню значка для текущего состояния.</summary>
    public IReadOnlyList<TrayItem> Items()
    {
        var items = new List<TrayItem> { new(CmdOpen, "Открыть Customers", Default: true) };
        if (_watched is { StartupError: null } m)
        {
            items.Add(TrayItem.Line);
            items.Add(m.Searching ? new TrayItem(CmdStop, "Остановить поиск") : new TrayItem(CmdSearch, "Найти сейчас"));
            items.Add(new TrayItem(CmdNew, $"Новые лиды: {m.NewLeads}", m.NewLeads > 0));
            items.Add(new TrayItem(CmdSettings, "Настройки"));
        }

        items.Add(TrayItem.Line);
        items.Add(new TrayItem(CmdExit, "Выйти из Customers"));
        return items;
    }

    public void OnCommand(int command)
    {
        var app = App.Instance;
        switch (command)
        {
            case CmdOpen:
                app.MainWindow.BringToFront();
                break;
            case CmdSearch:
                if (_watched is { } searcher)
                {
                    _ = searcher.RunSearchAsync(force: true);
                }

                break;
            case CmdStop:
                _watched?.StopSearch();
                break;
            case CmdNew:
                app.MainWindow.BringToFront();
                app.MainWindow.Shell?.Navigate(NavSection.New);
                break;
            case CmdSettings:
                app.MainWindow.BringToFront();
                app.MainWindow.Shell?.OpenSettings(SettingsSection.Background);
                break;
            case CmdExit:
                Quit();
                break;
        }
    }

    /// <summary>Выход по-настоящему: закрывает окно (база закрывается аккуратно в обработчике закрытия).</summary>
    public void Quit()
    {
        Quitting = true;
        App.Instance.MainWindow.Close();
    }

    public void Dispose()
    {
        if (_watched is not null)
        {
            _watched.PropertyChanged -= OnModelChanged;
            _watched.DataReloaded -= UpdateTip;
            _watched = null;
        }

        _tray?.Dispose();
        _tray = null;
    }
}
