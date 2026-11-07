using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>Источники: включение, интервал, состояние последнего запуска, проверка прямо сейчас и сброс памяти источника.</summary>
public sealed class SourcesView : UserControl, ISectionAware, IDetachable
{
    private readonly ShellView _shell;
    private readonly StackPanel _root = new() { Spacing = 12 };
    private bool _rebuilding;

    public SourcesView(AppModel model, ShellView shell)
    {
        Model = model;
        _shell = shell;
        Content = UiKit.Page(_root);
        Model.PropertyChanged += OnModelChanged;
        Model.DataReloaded += Build;
        Build();
    }

    public AppModel Model { get; }

    public void OnShown(NavSection section) => Build();

    public void Detach()
    {
        Model.PropertyChanged -= OnModelChanged;
        Model.DataReloaded -= Build;
    }

    private void OnModelChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(AppModel.Searching) or nameof(AppModel.SearchSettings) or nameof(AppModel.HasVkToken))
        {
            Build();
        }
    }

    private void Build()
    {
        if (_rebuilding)
        {
            return;
        }

        _rebuilding = true;
        _root.Children.Clear();
        _root.Children.Add(UiKit.PageTitle("Источники"));
        _root.Children.Add(UiKit.Muted("Откуда приложение берёт заказы и организации. Только публичные данные, без обхода ограничений и без платных сервисов."));
        foreach (var key in SourceKey.All)
        {
            _root.Children.Add(BuildCard(key));
        }

        _root.Children.Add(new TextBlock { Text = "Недоступные источники", Style = UiKit.Style("SectionTitleStyle"), Margin = new Thickness(0, 12, 0, 0) });
        _root.Children.Add(UiKit.Muted("Эти площадки не подключены: у них нет разрешённого публичного доступа."));
        foreach (var (name, reason) in SourceCatalog.Unavailable)
        {
            _root.Children.Add(UiKit.SettingRow(name, reason, null, ""));
        }

        _rebuilding = false;
    }

    private UIElement BuildCard(string key)
    {
        var info = SourceCatalog.Known.GetValueOrDefault(key);
        var settings = Model.SearchSettings;
        var state = Model.Sources.FirstOrDefault(s => s.Source == key);
        var enabled = settings.IsEnabled(key);
        var panel = new StackPanel { Spacing = 10 };

        var header = new Grid { ColumnSpacing = 12 };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var titles = UiKit.VStack(2, UiKit.SubTitle(SourceCatalog.Title(key)), UiKit.Muted(info is null ? "" : $"{info.Access}. {info.Note}"));
        var toggle = UiKit.Toggle(enabled, on => Model.UpdateSearchSettings(s => SetEnabled(s, key, on)), "Включён", "Выключен");
        Grid.SetColumn(toggle, 1);
        header.Children.Add(titles);
        header.Children.Add(toggle);
        panel.Children.Add(header);

        if (Model.Problem(key) is { } problem)
        {
            panel.Children.Add(UiKit.Bar(InfoBarSeverity.Warning, "Источник не готов к работе", problem));
        }

        panel.Children.Add(UiKit.Body(StatusText(state, enabled)));
        if (state is { LastError.Length: > 0, ConsecutiveFailures: > 0 })
        {
            panel.Children.Add(UiKit.Bar(InfoBarSeverity.Error, $"Ошибок подряд: {state.ConsecutiveFailures}", state.LastError));
        }

        var interval = UiKit.Number(settings.IntervalHours(key), 0.25, 24 * 30, h => Model.UpdateSearchSettings(s => SetInterval(s, key, h)), 0.5, "Интервал, часов", 160);
        var actions = UiKit.HStack(8,
            UiKit.TextButton(Model.Searching ? "Идёт поиск…" : "Проверить сейчас", () => _ = Model.RunSearchAsync(true, new HashSet<string> { key }), accent: true),
            UiKit.TextButton("Сбросить память источника", () => Model.ResetSourceMemory(key), tip: "Забыть, что уже просмотрено, чтобы источник был просмотрен заново"),
            UiKit.TextButton("Настроить…", () => _shell.OpenSettings(SettingsSection.Sources)));
        ((Button)actions.Children[0]).IsEnabled = !Model.Searching && enabled;
        var bottom = new Grid { ColumnSpacing = 16 };
        bottom.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        bottom.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        bottom.Children.Add(interval);
        Grid.SetColumn(actions, 1);
        actions.VerticalAlignment = VerticalAlignment.Bottom;
        bottom.Children.Add(actions);
        panel.Children.Add(bottom);
        return UiKit.Card(panel);
    }

    private static string StatusText(SourceState? state, bool enabled)
    {
        if (!enabled)
        {
            return "Источник выключен: поиск его не обходит.";
        }

        if (state is null || state.LastAttemptAt is null)
        {
            return "Ещё не запускался.";
        }

        var ok = state.LastSuccessAt is { } t ? $"Последний успешный запуск: {Fmt.Date(t)} ({Fmt.Ago(t)})." : "Успешных запусков ещё не было.";
        return $"{ok} Последняя попытка: {Fmt.Date(state.LastAttemptAt)}.";
    }

    private static void SetEnabled(SearchSettings s, string key, bool on)
    {
        switch (key)
        {
            case SourceKey.Rss:
                s.Rss.Enabled = on;
                break;
            case SourceKey.Telegram:
                s.Telegram.Enabled = on;
                break;
            case SourceKey.Vk:
                s.Vk.Enabled = on;
                break;
            case SourceKey.Osm:
                s.Osm.Enabled = on;
                break;
        }
    }

    private static void SetInterval(SearchSettings s, string key, double hours)
    {
        switch (key)
        {
            case SourceKey.Rss:
                s.Rss.IntervalHours = hours;
                break;
            case SourceKey.Telegram:
                s.Telegram.IntervalHours = hours;
                break;
            case SourceKey.Vk:
                s.Vk.IntervalHours = hours;
                break;
            case SourceKey.Osm:
                s.Osm.IntervalHours = hours;
                break;
        }
    }
}
