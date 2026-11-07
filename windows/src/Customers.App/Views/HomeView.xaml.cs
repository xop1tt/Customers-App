using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>Главная: показатели, запуск поиска, лучшие новые лиды и состояние источников.</summary>
public sealed partial class HomeView : UserControl, ISectionAware, IDetachable
{
    private readonly ShellView _shell;

    public HomeView(AppModel model, ShellView shell)
    {
        Model = model;
        _shell = shell;
        InitializeComponent();
        UiKit.FitWidth(Scroller, PageStack, 1100);
        Scroller.SizeChanged += (_, e) => Adapt(e.NewSize.Width);
        Model.PropertyChanged += OnModelChanged;
        Model.DataReloaded += Refresh;
        Refresh();
    }

    public AppModel Model { get; }

    /// <summary>Перестраивает сетку под ширину окна (и масштаб Windows): четыре показателя в ряд, затем 2×2, затем в столбик.</summary>
    private void Adapt(double width)
    {
        var cols = width >= 760 ? 4 : width >= 440 ? 2 : 1;
        Stats.ColumnDefinitions.Clear();
        Stats.RowDefinitions.Clear();
        for (var c = 0; c < cols; c++)
        {
            Stats.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        }

        for (var r = 0; r < (Stats.Children.Count + cols - 1) / cols; r++)
        {
            Stats.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        }

        for (var i = 0; i < Stats.Children.Count; i++)
        {
            var item = (FrameworkElement)Stats.Children[i];
            Grid.SetColumn(item, i % cols);
            Grid.SetRow(item, i / cols);
        }

        var stacked = width < 820;
        Lower.ColumnDefinitions.Clear();
        Lower.RowDefinitions.Clear();
        Lower.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(stacked ? 1 : 3, GridUnitType.Star) });
        if (!stacked)
        {
            Lower.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(2, GridUnitType.Star) });
        }

        Lower.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        if (stacked)
        {
            Lower.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        }

        Grid.SetColumn(SourcesCard, stacked ? 0 : 1);
        Grid.SetRow(SourcesCard, stacked ? 1 : 0);
    }

    public void OnShown(NavSection section) => Refresh();

    public void Detach()
    {
        Model.PropertyChanged -= OnModelChanged;
        Model.DataReloaded -= Refresh;
    }

    private void OnModelChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(AppModel.Searching) or nameof(AppModel.SearchProgress) or nameof(AppModel.LastSearchAt) or nameof(AppModel.SearchSettings))
        {
            Refresh();
        }
    }

    private void Refresh()
    {
        var hour = DateTime.Now.Hour;
        var hello = hour is >= 5 and < 12 ? "Доброе утро" : hour is >= 12 and < 18 ? "Добрый день" : hour is >= 18 and < 23 ? "Добрый вечер" : "Доброй ночи";
        Greeting.Text = $"{hello}, {Model.DisplayName}";
        Summary.Text = Model.NewLeads > 0
            ? $"Новых лидов: {Model.NewLeads}. Последний поиск: {Fmt.Ago(Model.LastSearchAt)}."
            : $"Новых лидов нет. Последний поиск: {Fmt.Ago(Model.LastSearchAt)}.";
        TotalNumber.Text = Model.TotalLeads.ToString(System.Globalization.CultureInfo.CurrentCulture);
        NewNumber.Text = Model.NewLeads.ToString(System.Globalization.CultureInfo.CurrentCulture);
        HighNumber.Text = Model.HighLeads.ToString(System.Globalization.CultureInfo.CurrentCulture);
        FavoriteNumber.Text = Model.FavoriteLeads.ToString(System.Globalization.CultureInfo.CurrentCulture);

        var searching = Model.Searching;
        SearchBar.Visibility = Fmt.Vis(searching);
        FindButton.Content = searching ? "Остановить" : "Найти лиды";
        SearchStatus.Text = searching
            ? Model.SearchProgress ?? "Поиск…"
            : Model.LastReport is { } report ? report.Summary : "Поиск запускается вручную или по расписанию (Настройки → Поиск).";

        Onboarding.Visibility = Fmt.Vis(Model.AllLeads.Count == 0);
        BuildTopLeads();
        BuildSources();
    }

    private void BuildTopLeads()
    {
        TopLeads.Children.Clear();
        var top = Model.AllLeads.Where(l => LeadQuery.InSection(l, NavSection.New) && l.Data.Relevance != Relevance.Rejected)
            .OrderByDescending(l => l.Data.Score).ThenByDescending(l => l.DiscoveredAt).Take(6).ToList();
        if (top.Count == 0)
        {
            TopLeads.Children.Add(UiKit.Muted(Model.AllLeads.Count == 0 ? "Пока нет ни одного лида." : "Новых лидов нет — все просмотрены."));
            return;
        }

        foreach (var lead in top)
        {
            var row = new Button {
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
                Background = UiKit.Transparent,
                BorderThickness = new Thickness(0),
                Padding = new Thickness(8, 6, 8, 6),
            };
            var grid = new Grid { ColumnSpacing = 10 };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var score = new Border {
                Width = 40,
                Height = 24,
                CornerRadius = new CornerRadius(12),
                Background = Fmt.LevelBrush(lead.Data.Relevance.Raw()),
                Child = new TextBlock { Text = Math.Round(lead.Data.Score).ToString(System.Globalization.CultureInfo.InvariantCulture), Foreground = Fmt.White, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center },
            };
            var text = new StackPanel();
            text.Children.Add(new TextBlock { Text = string.IsNullOrWhiteSpace(lead.Data.Title) ? "(без названия)" : lead.Data.Title, TextTrimming = TextTrimming.CharacterEllipsis, MaxLines = 1 });
            text.Children.Add(new TextBlock { Text = $"{SourceCatalog.Title(lead.Data.Source)} · {Fmt.Ago(lead.DiscoveredAt)}", Style = UiKit.Style("MutedTextStyle"), TextWrapping = TextWrapping.NoWrap });
            Grid.SetColumn(text, 1);
            grid.Children.Add(score);
            grid.Children.Add(text);
            row.Content = grid;
            var id = lead.Id;
            row.Click += (_, _) => OpenLead(id);
            TopLeads.Children.Add(row);
        }
    }

    private void OpenLead(string id)
    {
        _shell.Navigate(NavSection.New);
        Model.SetSelection([id]);
    }

    private void BuildSources()
    {
        SourceStatus.Children.Clear();
        foreach (var key in SourceKey.All)
        {
            var state = Model.Sources.FirstOrDefault(s => s.Source == key);
            var enabled = Model.SearchSettings.IsEnabled(key);
            string text;
            string glyph;
            if (!enabled)
            {
                (text, glyph) = ("выключен", "");
            }
            else if (Model.Problem(key) is { } problem)
            {
                (text, glyph) = (problem, "");
            }
            else if (state is { ConsecutiveFailures: > 0 })
            {
                (text, glyph) = ($"ошибка: {state.LastError}", "");
            }
            else if (state?.LastSuccessAt is { } ok)
            {
                (text, glyph) = ($"обновлён {Fmt.Ago(ok)}", "");
            }
            else
            {
                (text, glyph) = ("ещё не запускался", "");
            }

            var grid = new Grid { ColumnSpacing = 10 };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.Children.Add(new FontIcon { Glyph = glyph, FontSize = 14, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 3, 0, 0) });
            var info = new StackPanel();
            info.Children.Add(new TextBlock { Text = SourceCatalog.Title(key), TextTrimming = TextTrimming.CharacterEllipsis });
            info.Children.Add(new TextBlock { Text = text, Style = UiKit.Style("MutedTextStyle"), TextTrimming = TextTrimming.CharacterEllipsis, MaxLines = 2 });
            Grid.SetColumn(info, 1);
            grid.Children.Add(info);
            SourceStatus.Children.Add(grid);
        }
    }

    private void OnStatClick(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: string tag } && Enum.TryParse<NavSection>(tag, out var section))
        {
            _shell.Navigate(section);
        }
    }

    private void OnSourcesClick(object sender, RoutedEventArgs e) => _shell.Navigate(NavSection.Sources);

    private void OnFindClick(object sender, RoutedEventArgs e)
    {
        if (Model.Searching)
        {
            Model.StopSearch();
        }
        else
        {
            _ = Model.RunSearchAsync();
        }
    }
}
