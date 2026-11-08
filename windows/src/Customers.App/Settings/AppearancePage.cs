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

    private TextBlock? _lightStatus;

    protected override SettingsSection Kind => SettingsSection.Appearance;

    /// <summary>Пока страница открыта, строка о причине облегчённого режима следует за состоянием питания.</summary>
    private void Subscribe()
    {
        Loaded += (_, _) =>
        {
            App.Instance.LightMode.PropertyChanged += OnLightModeChanged;
            UpdateLightStatus();
        };
        Unloaded += (_, _) => App.Instance.LightMode.PropertyChanged -= OnLightModeChanged;
    }

    private bool _subscribed;

    private void OnLightModeChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e) => UpdateLightStatus();

    private void UpdateLightStatus()
    {
        if (_lightStatus is null)
        {
            return;
        }

        var mode = App.Instance.LightMode;
        _lightStatus.Text = mode.Reason is { } reason
            ? "Сейчас включён. " + reason.Explanation + " Когда причина исчезнет, обычный вид вернётся сам."
            : mode.HasBattery
                ? $"Сейчас выключен. Заряд {mode.State.BatteryPercent}%."
                : "Сейчас выключен. Заряда батареи компьютер не сообщает, поэтому учитывается только режим экономии энергии Windows.";
    }

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

        Heading("Энергосбережение");
        Add(UiKit.SettingRow("Облегчённый режим автоматически",
            "Отключает анимации и прозрачные материалы окна, когда в Windows включена экономия энергии или заряд батареи ниже порога.",
            UiKit.Toggle(Device.LightModeAuto, v =>
            {
                Device.LightModeAuto = v;
                UpdateLightStatus();
            })));
        Add(UiKit.SettingRow("Порог заряда батареи, %", "От 5 до 50. Если компьютер заряжается, порог не учитывается.",
            UiKit.Number(Device.LightModeThreshold, PowerPolicy.MinThreshold, PowerPolicy.MaxThreshold, v =>
            {
                Device.LightModeThreshold = (int)Math.Round(v);
                UpdateLightStatus();
            }, 1, null, 120)));
        _lightStatus = UiKit.Muted("");
        _lightStatus.TextWrapping = TextWrapping.Wrap;
        Add(_lightStatus);
        UpdateLightStatus();
        if (!_subscribed)
        {
            _subscribed = true;
            Subscribe();
        }

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

        var system = new Button {
            Height = 36,
            Padding = new Thickness(12, 0, 12, 0),
            CornerRadius = new CornerRadius(18),
            BorderThickness = new Thickness(current is null ? 3 : 1),
            BorderBrush = current is null ? UiKit.ThemeBrush("TextFillColorPrimaryBrush") : UiKit.ThemeBrush("ControlStrokeColorDefaultBrush"),
            Content = current is null ? "✓ Как в системе" : "Как в системе",
        };
        ToolTipService.SetToolTip(system, "Цвет, выбранный в настройках Windows");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(system, "Как в системе");
        system.Click += (_, _) =>
        {
            Device.Accent = null;
            Refresh();
        };
        wrap.Children.Insert(0, system);
        var presetNames = Presets.Select(p => p.Hex).ToArray();
        var custom = current is not null && !presetNames.Contains(current, StringComparer.OrdinalIgnoreCase);
        var body = UiKit.VStack(12, UiKit.Strong("Цвет выделения, кнопок и переключателей"), wrap,
            UiKit.Muted(custom
                ? "Сейчас задан цвет из прошлой версии. Выберите оттенок из набора или «Как в системе»."
                : "Цвет применяется сразу, перезапускать приложение не нужно."));
        return UiKit.Card(body);
    }
}
