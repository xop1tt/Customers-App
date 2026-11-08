using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Customers.Ui;

/// <summary>
/// Небольшие живые картинки к пунктам «Что нового»: показывают, как работает новая возможность, а не просто рисуют значок.
/// Исключения определяют формат тем же кодом, что и настройки, облегчённый режим считается тем же <see cref="PowerPolicy"/>.
/// При выключенных анимациях и в облегчённом режиме показывается один неподвижный кадр.
/// </summary>
internal static class WhatsNewPreviews
{
    private const double Height = 112;

    public static FrameworkElement Create(WhatsNewPreview kind, bool animate)
    {
        var frame = new Border {
            Height = Height,
            MinWidth = 200,
            CornerRadius = new CornerRadius(8),
            BorderThickness = new Thickness(1),
            BorderBrush = UiKit.ThemeBrush("CardStrokeColorDefaultBrush"),
            Background = UiKit.ThemeBrush("LayerFillColorDefaultBrush"),
            Padding = new Thickness(12),
        };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetAccessibilityView(frame, Microsoft.UI.Xaml.Automation.Peers.AccessibilityView.Raw);
        switch (kind)
        {
            case WhatsNewPreview.Sidebar:
                Sidebar(frame, animate);
                break;
            case WhatsNewPreview.Settings:
                SettingsWindow(frame, animate);
                break;
            case WhatsNewPreview.Adaptive:
                Adaptive(frame, animate);
                break;
            case WhatsNewPreview.Exclusions:
                Exclusions(frame, animate);
                break;
            case WhatsNewPreview.Categories:
                Categories(frame, animate);
                break;
            case WhatsNewPreview.Power:
                Power(frame, animate);
                break;
            case WhatsNewPreview.Update:
                Update(frame, animate);
                break;
            default:
                Cloud(frame, animate);
                break;
        }

        return frame;
    }

    // MARK: Общее

    private static Brush Accent => UiKit.ThemeBrush("AccentFillColorDefaultBrush");

    private static Brush Soft => UiKit.ThemeBrush("ControlFillColorSecondaryBrush");

    private static Brush Faint => UiKit.ThemeBrush("TextFillColorTertiaryBrush");

    private static Border Block(double width, double height, Brush? fill = null, double radius = 4) =>
        new() { Width = width, Height = height, CornerRadius = new CornerRadius(radius), Background = fill ?? Soft };

    private static TextBlock Caption(string text) =>
        new() { Text = text, FontSize = 12, Foreground = UiKit.ThemeBrush("TextFillColorSecondaryBrush"), TextWrapping = TextWrapping.Wrap };

    /// <summary>Крутит шаги по кругу, пока картинка на экране; без анимации показывает только первый шаг.</summary>
    private static void Loop(FrameworkElement host, double seconds, int steps, Action<int> show, bool animate)
    {
        show(steps > 1 && !animate ? steps - 1 : 0);
        if (!animate)
        {
            return;
        }

        DispatcherQueueTimer? timer = null;
        var step = 0;
        host.Loaded += (_, _) =>
        {
            timer ??= DispatcherQueue.GetForCurrentThread().CreateTimer();
            timer.Interval = TimeSpan.FromSeconds(seconds);
            timer.IsRepeating = true;
            timer.Tick += (_, _) =>
            {
                step = (step + 1) % steps;
                show(step);
            };
            timer.Start();
        };
        host.Unloaded += (_, _) => timer?.Stop();
    }

    // MARK: Боковая панель

    private static void Sidebar(Border frame, bool animate)
    {
        var grid = new Grid { ColumnSpacing = 8 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(70) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var rail = new StackPanel { Spacing = 6, Padding = new Thickness(6), Background = Soft };
        for (var i = 0; i < 4; i++)
        {
            rail.Children.Add(Block(i == 0 ? 54 : 44, 8, i == 0 ? Accent : null));
        }

        var rail2 = new Border { CornerRadius = new CornerRadius(6), Child = rail };
        var content = new StackPanel { Spacing = 6, VerticalAlignment = VerticalAlignment.Center };
        content.Children.Add(Block(120, 10));
        content.Children.Add(Block(160, 10));
        content.Children.Add(Block(90, 10));
        var caption = Caption("");
        Grid.SetRow(caption, 1);
        Grid.SetColumnSpan(caption, 2);
        grid.Children.Add(rail2);
        Grid.SetColumn(content, 1);
        grid.Children.Add(content);
        grid.Children.Add(caption);
        frame.Child = grid;
        Loop(frame, 1.6, 3, i =>
        {
            grid.ColumnDefinitions[0].Width = new GridLength(i == 1 ? 0 : 70);
            rail2.Opacity = i == 1 ? 0 : 1;
            caption.Text = i switch {
                0 => "Панель закреплена",
                1 => "Свёрнута: больше места для списка",
                _ => "Курсор у левого края — панель выезжает сама",
            };
        }, animate);
    }

    // MARK: Окно настроек

    private static void SettingsWindow(Border frame, bool animate)
    {
        var grid = new Grid { ColumnSpacing = 10 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(86) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var list = new StackPanel { Spacing = 5 };
        var search = new Border { Height = 14, CornerRadius = new CornerRadius(7), Background = Soft, Child = new TextBlock { Text = "поиск", FontSize = 9, Margin = new Thickness(8, 0, 0, 0), Foreground = Faint, VerticalAlignment = VerticalAlignment.Center } };
        list.Children.Add(search);
        var rows = new List<Border>();
        foreach (var title in new[] { "Оформление", "Источники", "Данные", "Обновления" })
        {
            var row = new Border { CornerRadius = new CornerRadius(4), Padding = new Thickness(6, 3, 6, 3), Child = new TextBlock { Text = title, FontSize = 10 } };
            rows.Add(row);
            list.Children.Add(row);
        }

        var page = new StackPanel { Spacing = 6, VerticalAlignment = VerticalAlignment.Center };
        var heading = new TextBlock { FontSize = 12, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold };
        page.Children.Add(heading);
        page.Children.Add(Block(150, 9));
        page.Children.Add(Block(110, 9));
        grid.Children.Add(list);
        Grid.SetColumn(page, 1);
        grid.Children.Add(page);
        frame.Child = grid;
        var names = new[] { "Оформление", "Источники", "Данные", "Обновления" };
        Loop(frame, 1.2, 4, i =>
        {
            for (var r = 0; r < rows.Count; r++)
            {
                rows[r].Background = r == i ? Soft : null;
            }

            heading.Text = names[i];
        }, animate);
    }

    // MARK: Раскладка

    private static void Adaptive(Border frame, bool animate)
    {
        var holder = new Border { HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Center };
        var wrap = new WrapPanel { HorizontalSpacing = 6, VerticalSpacing = 6 };
        for (var i = 0; i < 6; i++)
        {
            wrap.Children.Add(Block(40, 26, i == 0 ? Accent : null, 5));
        }

        holder.Child = wrap;
        var caption = Caption("");
        caption.VerticalAlignment = VerticalAlignment.Bottom;
        var root = new Grid();
        root.Children.Add(holder);
        root.Children.Add(caption);
        frame.Child = root;
        Loop(frame, 1.5, 2, i =>
        {
            holder.Width = i == 0 ? 280 : 140;
            caption.Text = i == 0 ? "Широкое окно: карточки в ряд" : "Панель раскрыта: карточки перестроились без прокрутки";
        }, animate);
    }

    // MARK: Исключения

    private static void Exclusions(Border frame, bool animate)
    {
        var samples = new[] { "example.ru", "+7 843 212-48-90", "name@mail.ru", "Студия «Лаванда»" };
        var box = new Border {
            CornerRadius = new CornerRadius(4),
            BorderThickness = new Thickness(1),
            BorderBrush = UiKit.ThemeBrush("ControlStrokeColorDefaultBrush"),
            Background = UiKit.ThemeBrush("ControlFillColorDefaultBrush"),
            Padding = new Thickness(8, 5, 8, 5),
        };
        var value = new TextBlock { FontSize = 12 };
        box.Child = value;
        var tag = new Border { CornerRadius = new CornerRadius(4), Padding = new Thickness(8, 2, 8, 2), Background = Accent, HorizontalAlignment = HorizontalAlignment.Left };
        var tagText = new TextBlock { FontSize = 11, Foreground = Fmt.White };
        tag.Child = tagText;
        var caption = Caption("Одно поле: формат определяется сам");
        var stack = UiKit.VStack(8, box, tag, caption);
        stack.VerticalAlignment = VerticalAlignment.Center;
        frame.Child = stack;
        Loop(frame, 1.3, samples.Length, i =>
        {
            value.Text = samples[i];
            tagText.Text = "Добавится как: " + (EnumText.DetectExclusion(samples[i]) switch {
                ExclusionKind.Domain => "домен",
                ExclusionKind.Phone => "телефон",
                ExclusionKind.Email => "email",
                _ => "название",
            });
        }, animate);
    }

    // MARK: Категории карты

    private static void Categories(Border frame, bool animate)
    {
        var chips = new WrapPanel { HorizontalSpacing = 6, VerticalSpacing = 6 };
        var all = SearchDefaults.OsmCategories();
        var shown = new[] { "beauty", "massage", "yoga", "carrepair", "hotel", "vet", "lawyer", "photographer" }
            .Select(k => all.FirstOrDefault(c => c.Key == k)).Where(c => c is not null).Cast<OSMCategory>().ToList();
        var borders = new List<Border>();
        foreach (var c in shown)
        {
            var chip = new Border { CornerRadius = new CornerRadius(10), Padding = new Thickness(8, 2, 8, 2), Background = Soft, Child = new TextBlock { Text = c.Label, FontSize = 11 } };
            borders.Add(chip);
            chips.Children.Add(chip);
        }

        var caption = Caption($"Больше категорий на карте: {all.Count} в каталоге");
        var stack = UiKit.VStack(8, chips, caption);
        stack.VerticalAlignment = VerticalAlignment.Center;
        frame.Child = stack;
        Loop(frame, 0.45, borders.Count + 2, i =>
        {
            for (var k = 0; k < borders.Count; k++)
            {
                borders[k].Background = k < i ? Accent : Soft;
                ((TextBlock)borders[k].Child).Foreground = k < i ? Fmt.White : UiKit.ThemeBrush("TextFillColorPrimaryBrush");
            }
        }, animate);
    }

    // MARK: Облегчённый режим

    private static void Power(Border frame, bool animate)
    {
        var levels = new[] { 80, 50, 30, 19, 12, 80 };
        var shell = new Border { Width = 70, Height = 28, CornerRadius = new CornerRadius(5), BorderThickness = new Thickness(2), BorderBrush = Faint, HorizontalAlignment = HorizontalAlignment.Left };
        var fill = new Border { HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(2), CornerRadius = new CornerRadius(3) };
        shell.Child = fill;
        var percent = new TextBlock { FontSize = 12, VerticalAlignment = VerticalAlignment.Center };
        var badge = new Border { CornerRadius = new CornerRadius(4), Padding = new Thickness(8, 2, 8, 2), Background = Accent, HorizontalAlignment = HorizontalAlignment.Left };
        var badgeText = new TextBlock { FontSize = 11, Foreground = Fmt.White };
        badge.Child = badgeText;
        var caption = Caption("Облегчённый режим включается сам и объясняет причину");
        var top = UiKit.HStack(10, shell, percent);
        var stack = UiKit.VStack(8, top, badge, caption);
        stack.VerticalAlignment = VerticalAlignment.Center;
        frame.Child = stack;
        Loop(frame, 1.0, levels.Length, i =>
        {
            var level = levels[i];
            fill.Width = 62 * level / 100.0;
            fill.Height = 20;
            fill.Background = level < PowerPolicy.DefaultThreshold ? Accent : Soft;
            percent.Text = level + "%";
            var reason = PowerPolicy.Evaluate(new PowerState(false, level, false), true, PowerPolicy.DefaultThreshold);
            badge.Visibility = Fmt.Vis(reason is not null);
            badgeText.Text = reason?.ShortTitle ?? "";
        }, animate);
    }

    // MARK: Кнопка обновления

    private static void Update(Border frame, bool animate)
    {
        var button = new Border { CornerRadius = new CornerRadius(5), Padding = new Thickness(12, 6, 12, 6), Background = Accent, HorizontalAlignment = HorizontalAlignment.Left };
        var label = new TextBlock { FontSize = 12, Foreground = Fmt.White };
        button.Child = label;
        var bar = new ProgressBar { Maximum = 100, Width = 160, HorizontalAlignment = HorizontalAlignment.Left };
        var caption = Caption("Состояние обновления — в самой кнопке «Обновить»");
        var stack = UiKit.VStack(8, button, bar, caption);
        stack.VerticalAlignment = VerticalAlignment.Center;
        frame.Child = stack;
        var steps = new (string Text, double Value)[] { ("Обновить до новой версии", 0), ("Загрузка 35%", 35), ("Загрузка 80%", 80), ("Установить и перезапустить", 100) };
        Loop(frame, 1.1, steps.Length, i =>
        {
            label.Text = steps[i].Text;
            bar.Value = steps[i].Value;
            bar.Visibility = Fmt.Vis(i is 1 or 2);
        }, animate);
    }

    // MARK: Облако

    private static void Cloud(Border frame, bool animate)
    {
        var left = Block(46, 32, null, 5);
        var right = Block(46, 32, null, 5);
        var arrow = new FontIcon { Glyph = "", FontSize = 18 };
        var caption = Caption("");
        var row = UiKit.HStack(14, left, arrow, right);
        row.HorizontalAlignment = HorizontalAlignment.Left;
        var stack = UiKit.VStack(10, row, caption);
        stack.VerticalAlignment = VerticalAlignment.Center;
        frame.Child = stack;
        Loop(frame, 1.2, 2, i =>
        {
            right.Background = i == 1 ? Accent : Soft;
            arrow.Opacity = i == 1 ? 1 : 0.4;
            caption.Text = i == 1 ? "Лиды и настройки появились на втором компьютере" : "Изменения на первом компьютере";
        }, animate);
    }
}
