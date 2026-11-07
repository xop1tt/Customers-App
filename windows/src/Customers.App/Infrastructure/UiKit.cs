using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Customers.Ui;

/// <summary>Небольшие «кирпичики» интерфейса для страниц, которые строятся в коде: карточки настроек, переключатели, поля.</summary>
internal static class Glyphs
{
    public const string Delete = "\uE74D";
    public const string Check = "\uE73E";
    public const string Folder = "\uE8B7";
    public const string Refresh = "\uE72C";
    public const string Copy = "\uE8C8";
    public const string Add = "\uE710";
    public const string Link = "\uE71B";
}

internal static class UiKit
{
    public static Style Style(string key) => (Style)Application.Current.Resources[key];

    public static Brush ThemeBrush(string key) => (Brush)Application.Current.Resources[key];

    public static TextBlock Muted(string text) => new() { Text = text, Style = Style("MutedTextStyle") };

    public static TextBlock Strong(string text) => new() { Text = text, Style = Style("BodyStrongTextBlockStyle"), TextWrapping = TextWrapping.Wrap };

    public static TextBlock Body(string text, bool selectable = false) => new() { Text = text, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = selectable };

    public static TextBlock PageTitle(string text) => new() { Text = text, Style = Style("TitleTextBlockStyle") };

    public static TextBlock SubTitle(string text) => new() { Text = text, Style = Style("SubtitleTextBlockStyle"), TextWrapping = TextWrapping.Wrap };

    public static Border Card(UIElement child, double padding = 16) =>
        new() { Style = Style("CardStyle"), Padding = new Thickness(padding), Child = child };

    public static StackPanel VStack(double spacing, params UIElement[] children)
    {
        var panel = new StackPanel { Spacing = spacing };
        foreach (var c in children)
        {
            panel.Children.Add(c);
        }

        return panel;
    }

    public static StackPanel HStack(double spacing, params UIElement[] children)
    {
        var panel = new StackPanel { Orientation = Orientation.Horizontal, Spacing = spacing };
        foreach (var c in children)
        {
            panel.Children.Add(c);
        }

        return panel;
    }

    /// <summary>Ширина карточки, при которой элемент управления переходит под текст, чтобы строка не распиралась и не обрезалась.</summary>
    private const double StackBelow = 560;

    /// <summary>Строка настройки как в «Параметрах Windows»: название и пояснение слева, элемент управления справа. В узком окне (и при крупном масштабе) элемент управления переходит под текст.</summary>
    public static Border SettingRow(string title, string? description, FrameworkElement? control, string? glyph = null)
    {
        var grid = new Grid { ColumnSpacing = 16, RowSpacing = 10 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        if (glyph is not null)
        {
            grid.Children.Add(new FontIcon { Glyph = glyph, FontSize = 18, VerticalAlignment = VerticalAlignment.Center });
        }
        else
        {
            grid.ColumnDefinitions[0].Width = new GridLength(0);
            grid.ColumnSpacing = 0;
        }

        var text = new StackPanel { Spacing = 2, VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = title, TextWrapping = TextWrapping.Wrap });
        if (!string.IsNullOrEmpty(description))
        {
            text.Children.Add(Muted(description));
        }

        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        if (control is not null)
        {
            var stacked = false;
            void Place(bool below)
            {
                stacked = below;
                Grid.SetRow(control, below ? 1 : 0);
                Grid.SetColumn(control, below ? 1 : 2);
                control.HorizontalAlignment = below ? HorizontalAlignment.Left : HorizontalAlignment.Right;
                control.VerticalAlignment = VerticalAlignment.Center;
                grid.ColumnSpacing = glyph is null && below ? 0 : 16;
            }

            Place(false);
            grid.Children.Add(control);
            grid.SizeChanged += (_, e) =>
            {
                var below = e.NewSize.Width < StackBelow;
                if (below != stacked)
                {
                    Place(below);
                }
            };
        }

        return Card(grid, 14);
    }

    /// <summary>
    /// Единая раскладка «поле + кнопка действия» для интеграций: поле растягивается, кнопка стоит справа и выровнена по нижней кромке поля
    /// (а не по его подписи). В узком окне кнопка переходит под поле, чтобы ничего не обрезалось.
    /// </summary>
    public static Grid InputRow(FrameworkElement input, Button? action = null)
    {
        var grid = new Grid { ColumnSpacing = 8, RowSpacing = 8 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        input.HorizontalAlignment = HorizontalAlignment.Stretch;
        input.Width = double.NaN;
        input.MinWidth = 0;
        grid.Children.Add(input);
        if (action is not null)
        {
            action.VerticalAlignment = VerticalAlignment.Bottom;
            action.MinHeight = 32;
            Grid.SetColumn(action, 1);
            grid.Children.Add(action);
            var below = false;
            grid.SizeChanged += (_, e) =>
            {
                var narrow = e.NewSize.Width < 460;
                if (narrow == below)
                {
                    return;
                }

                below = narrow;
                Grid.SetRow(action, narrow ? 1 : 0);
                Grid.SetColumn(action, narrow ? 0 : 1);
                Grid.SetColumnSpan(action, narrow ? 2 : 1);
                action.HorizontalAlignment = narrow ? HorizontalAlignment.Left : HorizontalAlignment.Stretch;
            };
        }

        return grid;
    }

    public static Button TextButton(string text, Action action, bool accent = false, string? tip = null)
    {
        var button = new Button { Content = text };
        if (accent)
        {
            button.Style = Style("AccentButtonStyle");
        }

        if (tip is not null)
        {
            ToolTipService.SetToolTip(button, tip);
        }

        button.Click += (_, _) => action();
        return button;
    }

    public static Button IconButton(string glyph, string tip, Action action)
    {
        var button = new Button { Content = new FontIcon { Glyph = glyph, FontSize = 14 } };
        ToolTipService.SetToolTip(button, tip);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, tip);
        button.Click += (_, _) => action();
        return button;
    }

    public static ToggleSwitch Toggle(bool on, Action<bool> changed, string onText = "Вкл.", string offText = "Выкл.")
    {
        var toggle = new ToggleSwitch { IsOn = on, OnContent = onText, OffContent = offText, MinWidth = 0 };
        toggle.Toggled += (_, _) => changed(toggle.IsOn);
        return toggle;
    }

    public static NumberBox Number(double value, double min, double max, Action<double> changed, double step = 1, string? header = null, double width = 140)
    {
        var box = new NumberBox {
            Value = value,
            Minimum = min,
            Maximum = max,
            SmallChange = step,
            SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Inline,
            Width = width,
            Header = header,
        };
        box.ValueChanged += (_, e) =>
        {
            if (!double.IsNaN(e.NewValue) && e.NewValue != e.OldValue)
            {
                changed(e.NewValue);
            }
        };
        return box;
    }

    /// <summary>Текстовое поле: значение применяется, когда пользователь закончил ввод (потеря фокуса или Enter).</summary>
    public static TextBox Text(string value, Action<string> committed, string? header = null, string? placeholder = null, double width = 0)
    {
        var box = new TextBox { Text = value, Header = header, PlaceholderText = placeholder ?? "" };
        if (width > 0)
        {
            box.Width = width;
        }

        var last = value;
        void Commit()
        {
            if (box.Text != last)
            {
                last = box.Text;
                committed(box.Text);
            }
        }

        box.LostFocus += (_, _) => Commit();
        box.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Enter && !box.AcceptsReturn)
            {
                Commit();
            }
        };
        return box;
    }

    public static PasswordBox Secret(string value, Action<string> committed, string? header = null, string? placeholder = null, double width = 0)
    {
        var box = new PasswordBox { Password = value, Header = header, PlaceholderText = placeholder ?? "" };
        if (width > 0)
        {
            box.Width = width;
        }

        var last = value;
        void Commit()
        {
            if (box.Password != last)
            {
                last = box.Password;
                committed(box.Password);
            }
        }

        box.LostFocus += (_, _) => Commit();
        box.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Enter)
            {
                Commit();
            }
        };
        return box;
    }

    public static ComboBox Combo<T>(IEnumerable<(string Text, T Value)> items, T selected, Action<T> changed, double width = 220)
    {
        var combo = new ComboBox { Width = width };
        var index = 0;
        foreach (var (text, value) in items)
        {
            combo.Items.Add(new ComboBoxItem { Content = text, Tag = value });
            if (EqualityComparer<T>.Default.Equals(value, selected))
            {
                index = combo.Items.Count - 1;
            }
        }

        combo.SelectedIndex = index;
        combo.SelectionChanged += (_, _) =>
        {
            if ((combo.SelectedItem as ComboBoxItem)?.Tag is T v)
            {
                changed(v);
            }
        };
        return combo;
    }

    public static InfoBar Bar(InfoBarSeverity severity, string title, string message, bool open = true) =>
        new() { Severity = severity, Title = title, Message = message, IsOpen = open, IsClosable = false };

    /// <summary>
    /// Страница со скроллом. Содержимое занимает всю ширину, но не больше <paramref name="maxWidth"/>, и всегда прижато влево:
    /// раньше оно центрировалось и «ездило» вправо, когда левую панель сворачивали или окно растягивали.
    /// </summary>
    public static ScrollViewer Page(StackPanel content, double maxWidth = 1000)
    {
        content.Padding = new Thickness(24, 8, 24, 32);
        var scroll = new ScrollViewer {
            Content = content,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
        };
        FitWidth(scroll, content, maxWidth);
        return scroll;
    }

    /// <summary>Делает ширину содержимого равной ширине окна просмотра, но не больше предела; выравнивание — по левому краю.</summary>
    public static void FitWidth(ScrollViewer host, FrameworkElement content, double maxWidth)
    {
        content.HorizontalAlignment = HorizontalAlignment.Left;
        host.SizeChanged += (_, e) => content.Width = Math.Max(0, Math.Min(maxWidth, e.NewSize.Width));
    }

    public static Border Pill(string text, Brush? background = null, Brush? foreground = null)
    {
        var label = new TextBlock { Text = text, FontSize = 12, Padding = new Thickness(8, 2, 8, 3) };
        if (foreground is not null)
        {
            label.Foreground = foreground;
        }

        return new Border {
            Child = label,
            CornerRadius = new CornerRadius(10),
            Background = background ?? ThemeBrush("SubtleFillColorSecondaryBrush"),
        };
    }

    public static Brush Transparent { get; } = new SolidColorBrush(Colors.Transparent);
}
