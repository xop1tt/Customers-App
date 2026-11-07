using System.ComponentModel;
using System.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>Журнал поиска: итог последнего запуска по источникам, история запусков и ошибки источников.</summary>
public sealed class RunsView : UserControl, ISectionAware, IDetachable
{
    private readonly StackPanel _root = new() { Spacing = 12 };

    public RunsView(AppModel model, ShellView shell)
    {
        Model = model;
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
        if (e.PropertyName is nameof(AppModel.Searching) or nameof(AppModel.SearchProgress) or nameof(AppModel.LastReport))
        {
            Build();
        }
    }

    private void Build()
    {
        _root.Children.Clear();
        _root.Children.Add(UiKit.PageTitle("Журнал поиска"));
        _root.Children.Add(UiKit.Muted("Что нашёл каждый источник при последних запусках и какие были ошибки."));

        var run = UiKit.TextButton(Model.Searching ? "Остановить" : "Найти лиды", () =>
        {
            if (Model.Searching)
            {
                Model.StopSearch();
            }
            else
            {
                _ = Model.RunSearchAsync();
            }
        }, accent: true);
        var top = UiKit.HStack(12, run);
        if (Model.Searching)
        {
            top.Children.Add(new ProgressRing { IsActive = true, Width = 20, Height = 20 });
            top.Children.Add(new TextBlock { Text = Model.SearchProgress ?? "Поиск…", VerticalAlignment = VerticalAlignment.Center });
        }

        _root.Children.Add(top);

        if (Model.LastReport is { } report)
        {
            _root.Children.Add(new TextBlock { Text = "Последний запуск", Style = UiKit.Style("SectionTitleStyle"), Margin = new Thickness(0, 8, 0, 0) });
            _root.Children.Add(UiKit.Bar(report.Failed.Count > 0 ? InfoBarSeverity.Warning : InfoBarSeverity.Success, report.Summary, ""));
            foreach (var s in report.Sources)
            {
                _root.Children.Add(SourceRow(s));
            }
        }

        _root.Children.Add(new TextBlock { Text = "История запусков", Style = UiKit.Style("SectionTitleStyle"), Margin = new Thickness(0, 8, 0, 0) });
        if (Model.RunLog.Count == 0)
        {
            _root.Children.Add(UiKit.Muted("Запусков ещё не было."));
        }
        else
        {
            var list = new StackPanel { Spacing = 6 };
            foreach (var e in Model.RunLog.Take(30))
            {
                list.Children.Add(LogRow(Fmt.Date(e.At), e.Ok ? "" : "", $"Новых {e.Added}, обновлено {e.Updated}. {e.Message}"));
            }

            _root.Children.Add(UiKit.Card(list));
        }

        _root.Children.Add(new TextBlock { Text = "Ошибки и предупреждения источников", Style = UiKit.Style("SectionTitleStyle"), Margin = new Thickness(0, 8, 0, 0) });
        if (Model.PipelineErrors.Count == 0)
        {
            _root.Children.Add(UiKit.Muted("Ошибок нет."));
        }
        else
        {
            var list = new StackPanel { Spacing = 6 };
            foreach (var e in Model.PipelineErrors.Take(50))
            {
                list.Children.Add(LogRow(Fmt.Date(e.At), "", $"{e.Module}: {e.Message}"));
            }

            _root.Children.Add(UiKit.Card(list));
            var copy = UiKit.TextButton("Скопировать для отчёта", () =>
            {
                var sb = new StringBuilder();
                foreach (var e in Model.PipelineErrors)
                {
                    sb.AppendLine($"{Fmt.Date(e.At)}  {e.Module}: {e.Message}");
                }

                Launcher.Copy(sb.ToString());
                App.Instance.Notifier.Success("Скопировано в буфер обмена");
            });
            copy.HorizontalAlignment = HorizontalAlignment.Left;
            _root.Children.Add(copy);
        }
    }

    private static UIElement SourceRow(SourceReport s)
    {
        var detail = s.Skipped is not null
            ? $"пропущен: {s.Skipped}"
            : $"найдено {s.Found}, новых {s.Added}, обновлено {s.Updated}, дубликатов {s.Duplicates}";
        var panel = new StackPanel { Spacing = 4 };
        panel.Children.Add(UiKit.Strong(SourceCatalog.Title(s.Source)));
        panel.Children.Add(UiKit.Body(detail));
        foreach (var w in s.Warnings.Take(5))
        {
            panel.Children.Add(UiKit.Muted("Предупреждение: " + w));
        }

        foreach (var err in s.Errors.Take(5))
        {
            panel.Children.Add(new TextBlock { Text = "Ошибка: " + err, TextWrapping = TextWrapping.Wrap, Foreground = UiKit.ThemeBrush("SystemFillColorCriticalBrush") });
        }

        return UiKit.Card(panel, 12);
    }

    private static Grid LogRow(string time, string glyph, string text)
    {
        var grid = new Grid { ColumnSpacing = 10 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(124) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.Children.Add(UiKit.Muted(time));
        var icon = new FontIcon { Glyph = glyph, FontSize = 13, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 2, 0, 0) };
        Grid.SetColumn(icon, 1);
        grid.Children.Add(icon);
        var body = UiKit.Body(text, selectable: true);
        Grid.SetColumn(body, 2);
        grid.Children.Add(body);
        return grid;
    }
}
