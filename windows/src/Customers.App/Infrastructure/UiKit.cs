using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Customers.Ui;

/// <summary>Небольшие «кирпичики» интерфейса для страниц, которые строятся в коде: карточки настроек, переключатели, поля.</summary>
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

    /// <summary>Строка настройки как в «Параметрах Windows»: название и пояснение слева, элемент управления справа.</summary>
    public static Border SettingRow(string title, string? description, FrameworkElement? control, string? glyph = null)
    {
        var grid = new Grid { ColumnSpacing = 16 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        if (glyph is not null)
        {
            grid.Children.Add(new FontIcon { Glyph = glyph, FontSize = 18, VerticalAlignment = VerticalAlignment.Center });
        }
        else
        {
            grid.ColumnDefinitions[0].Width = new GridLength(0);
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
            control.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetColumn(control, 2);
            grid.Children.Add(control);
        }

        return Card(grid, 14);
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

    /// <summary>Страница со скроллом и ограничением ширины, чтобы текст не растягивался на весь монитор.</summary>
    public static ScrollViewer Page(StackPanel content, double maxWidth = 1000)
    {
        content.MaxWidth = maxWidth;
        content.HorizontalAlignment = HorizontalAlignment.Stretch;
        content.Padding = new Thickness(24, 8, 24, 32);
        return new ScrollViewer {
            Content = content,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
        };
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
