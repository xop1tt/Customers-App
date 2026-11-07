using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>Основа страницы настроек: заголовок, пояснение, прокрутка и безопасный запуск длительных действий.</summary>
internal abstract class SettingsPage : UserControl
{
    private readonly StackPanel _root = new() { Spacing = 10 };

    protected SettingsPage(AppModel model, SessionModel session, ShellView shell)
    {
        Model = model;
        Session = session;
        Shell = shell;
        Content = UiKit.Page(_root);
    }

    protected AppModel Model { get; }

    protected SessionModel Session { get; }

    protected ShellView Shell { get; }

    protected DevicePreferences Device => App.Instance.Env.Device;

    protected StackPanel Root => _root;

    protected abstract SettingsSection Kind { get; }

    protected virtual string? Lead => null;

    /// <summary>Наполняет страницу (после заголовка).</summary>
    protected abstract void Fill();

    /// <summary>Перестраивает страницу, сохраняя положение прокрутки.</summary>
    public void Refresh()
    {
        var offset = (Content as ScrollViewer)?.VerticalOffset ?? 0;
        _root.Children.Clear();
        _root.Children.Add(UiKit.PageTitle(Kind.Title()));
        if (Lead is { } lead)
        {
            _root.Children.Add(UiKit.Muted(lead));
        }

        Fill();
        if (offset > 0 && Content is ScrollViewer sv)
        {
            sv.UpdateLayout();
            sv.ChangeView(null, offset, null, true);
        }
    }

    protected void Add(UIElement element) => _root.Children.Add(element);

    protected void Heading(string text) =>
        _root.Children.Add(new TextBlock { Text = text, Style = UiKit.Style("SectionTitleStyle"), Margin = new Thickness(0, 10, 0, 0) });

    protected static void Notify(NoticeKind kind, string title, string message = "") => App.Instance.Notifier.Post(new Notice(kind, title, message));

    protected static void Ok(string title, string message = "") => App.Instance.Notifier.Success(title, message);

    protected static void Fail(string title, string message = "") => App.Instance.Notifier.Error(title, message);

    /// <summary>Выполняет действие и показывает ошибку, если оно упало; интерфейс при этом не замирает.</summary>
    protected async void Run(Func<Task> work, string failTitle = "Не получилось")
    {
        try
        {
            await work();
        }
        catch (OperationCanceledException)
        {
            // Пользователь отменил.
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            App.Instance.Env.Log.Error(failTitle, e);
            Fail(failTitle, e.Message);
        }
    }

    /// <summary>Редактор списка строк (ленты, каналы, ключевые слова…): добавление с проверкой, удаление, подсказки.</summary>
    internal static FrameworkElement ListEditor(string title, string? hint, Func<IReadOnlyList<string>> get, Action<List<string>> set,
        Func<string, string?> normalize, string placeholder, string invalidText, bool pill = false)
    {
        var items = new StackPanel { Spacing = 4 };
        var error = new TextBlock { Foreground = UiKit.ThemeBrush("SystemFillColorCriticalBrush"), TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed };
        var input = new TextBox { PlaceholderText = placeholder, MinWidth = 240, HorizontalAlignment = HorizontalAlignment.Stretch };

        void Rebuild()
        {
            items.Children.Clear();
            var current = get();
            if (current.Count == 0)
            {
                items.Children.Add(UiKit.Muted("Список пуст."));
            }

            foreach (var value in current)
            {
                var text = new TextBlock { Text = value, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis, IsTextSelectionEnabled = true };
                var remove = UiKit.IconButton(Glyphs.Delete, "Удалить из списка", () =>
                {
                    var list = get().ToList();
                    list.Remove(value);
                    set(list);
                    Rebuild();
                });
                var row = new Grid { ColumnSpacing = 8, MinHeight = 36 };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.Children.Add(text);
                Grid.SetColumn(remove, 1);
                row.Children.Add(remove);
                items.Children.Add(row);
            }
        }

        void Add()
        {
            var added = 0;
            var bad = new List<string>();
            var list = get().ToList();
            foreach (var raw in SourceInput.Split(input.Text))
            {
                if (normalize(raw) is { } v)
                {
                    if (!list.Contains(v, StringComparer.OrdinalIgnoreCase))
                    {
                        list.Add(v);
                        added++;
                    }
                }
                else
                {
                    bad.Add(raw);
                }
            }

            if (added > 0)
            {
                set(list);
            }

            error.Text = bad.Count > 0 ? $"{invalidText}: {string.Join(", ", bad)}" : "";
            error.Visibility = Fmt.Vis(bad.Count > 0);
            if (bad.Count == 0)
            {
                input.Text = "";
            }

            Rebuild();
        }

        var add = UiKit.TextButton("Добавить", Add, accent: false);
        input.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Enter)
            {
                Add();
            }
        };
        var entry = new Grid { ColumnSpacing = 8 };
        entry.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        entry.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        entry.Children.Add(input);
        Grid.SetColumn(add, 1);
        entry.Children.Add(add);

        var body = UiKit.VStack(8, UiKit.Strong(title));
        if (hint is not null)
        {
            body.Children.Add(UiKit.Muted(hint));
        }

        var scroll = new ScrollViewer { Content = items, MaxHeight = 260, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        body.Children.Add(scroll);
        body.Children.Add(entry);
        body.Children.Add(error);
        Rebuild();
        return UiKit.Card(body);
    }
}
