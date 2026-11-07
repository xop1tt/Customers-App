using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Customers.Ui;

internal sealed class AppearancePage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    private static readonly (string Name, string Hex)[] Presets =
    [
        ("Синий", "#0067C0"), ("Бирюзовый", "#0F7B8A"), ("Зелёный", "#107C10"), ("Фиолетовый", "#744DA9"),
        ("Розовый", "#C239B3"), ("Красный", "#C42B1C"), ("Оранжевый", "#CA5010"), ("Графитовый", "#515C6B"),
    ];

    protected override SettingsSection Kind => SettingsSection.Appearance;

    protected override string Lead => "Оформление хранится на этом компьютере и не зависит от учётной записи.";

    protected override void Fill()
    {
        Add(UiKit.SettingRow("Тема", "«Как в системе» следует настройке Windows.",
            UiKit.Combo([("Как в системе", ThemeChoice.System), ("Светлая", ThemeChoice.Light), ("Тёмная", ThemeChoice.Dark)], Device.Theme, v => Device.Theme = v, 180)));

        var note = UiKit.Muted(Appearance.BackdropNote(Device.Backdrop));
        var backdrop = UiKit.Combo([
            ("Mica", BackdropChoice.Mica), ("Mica Alt", BackdropChoice.MicaAlt), ("Акрил", BackdropChoice.Acrylic), ("Без материала", BackdropChoice.None)],
            Device.Backdrop, v =>
            {
                Device.Backdrop = v;
                note.Text = Appearance.BackdropNote(v);
            }, 180);
        Add(UiKit.SettingRow("Материал окна", null, backdrop));
        Add(note);

        Heading("Акцентный цвет");
        Add(BuildAccent());

        Heading("Интерфейс");
        Add(UiKit.SettingRow("Компактный список", "Строки лидов ниже — на экране помещается больше.",
            UiKit.Toggle(Device.CompactRows, v => Device.CompactRows = v)));
        Add(UiKit.SettingRow("Анимации", "Плавные переходы между разделами и панелями. Выключите, если они мешают или компьютер слабый.",
            UiKit.Toggle(Device.Animations, v => Device.Animations = v)));
        Add(UiKit.SettingRow("Боковая панель навигации", "Её можно скрыть кнопкой в заголовке окна и менять ширину, потянув за край.",
            UiKit.Toggle(!Device.NavHidden, v => Device.NavHidden = !v)));
        Add(UiKit.SettingRow("Панель сведений о лиде", "Справа от списка: заметки, история и действия.",
            UiKit.Toggle(Device.InspectorShown, v => Device.InspectorShown = v)));
        Add(UiKit.SettingRow("Размеры панелей", "Вернуть ширину боковой панели и панели сведений по умолчанию.",
            UiKit.TextButton("Сбросить", () =>
            {
                Device.NavWidth = 280;
                Device.InspectorWidth = 380;
                Ok("Размеры панелей сброшены");
            })));
    }

    private UIElement BuildAccent()
    {
        var current = Device.Accent;
        var swatches = new ItemsControl();
        var wrap = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        foreach (var (name, hex) in Presets)
        {
            var color = Appearance.ParseColor(hex)!.Value;
            var selected = string.Equals(current, hex, StringComparison.OrdinalIgnoreCase);
            var button = new Button {
                Width = 36,
                Height = 36,
                Padding = new Thickness(0),
                CornerRadius = new CornerRadius(18),
                Background = new SolidColorBrush(color),
                BorderThickness = new Thickness(selected ? 3 : 1),
                BorderBrush = selected ? UiKit.ThemeBrush("TextFillColorPrimaryBrush") : UiKit.ThemeBrush("ControlStrokeColorDefaultBrush"),
                Content = selected ? new FontIcon { Glyph = Glyphs.Check, FontSize = 14, Foreground = Fmt.White } : null,
            };
            ToolTipService.SetToolTip(button, name);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, name);
            button.Click += (_, _) =>
            {
                Device.Accent = hex;
                Refresh();
            };
            wrap.Children.Add(button);
        }

        var hexBox = new TextBox { Text = current ?? "", PlaceholderText = "#RRGGBB", Width = 130, Header = "Свой цвет" };
        var error = new TextBlock { Foreground = UiKit.ThemeBrush("SystemFillColorCriticalBrush"), Visibility = Visibility.Collapsed };
        var apply = UiKit.TextButton("Применить", () =>
        {
            if (DevicePreferences.NormalizeColor(hexBox.Text) is { } normalized)
            {
                Device.Accent = normalized;
                Refresh();
            }
            else
            {
                error.Text = "Цвет задаётся в виде #RRGGBB, например #0067C0.";
                error.Visibility = Visibility.Visible;
            }
        });
        var reset = UiKit.TextButton("Как в системе", () =>
        {
            Device.Accent = null;
            Refresh();
        });
        var restart = UiKit.TextButton("Перезапустить сейчас", App.Restart, accent: true);
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, VerticalAlignment = VerticalAlignment.Bottom };
        row.Children.Add(hexBox);
        row.Children.Add(apply);
        row.Children.Add(reset);
        var body = UiKit.VStack(12, UiKit.Strong("Цвет выделения, кнопок и переключателей"), wrap, row, error,
            UiKit.Muted("Новый цвет полностью применяется после перезапуска приложения: так устроены стандартные элементы Windows."), restart);
        _ = swatches;
        return UiKit.Card(body);
    }
}
