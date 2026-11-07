using Microsoft.UI;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace Customers.Ui;

/// <summary>Тема, акцентный цвет и материал окна (Mica / Mica Alt / Acrylic) с запасными вариантами для Windows 10.</summary>
internal static class Appearance
{
    public static bool MicaSupported => TrySupported(MicaController.IsSupported);

    public static bool AcrylicSupported => TrySupported(DesktopAcrylicController.IsSupported);

    private static bool TrySupported(Func<bool> probe)
    {
        try
        {
            return probe();
        }
        catch (Exception e) when (e is InvalidOperationException or System.Runtime.InteropServices.COMException or TypeLoadException)
        {
            return false;
        }
    }

    public static ElementTheme ToElementTheme(ThemeChoice theme) => theme switch {
        ThemeChoice.Light => ElementTheme.Light,
        ThemeChoice.Dark => ElementTheme.Dark,
        _ => ElementTheme.Default,
    };

    /// <summary>Материал окна по выбору пользователя. Mica есть только в Windows 11: на Windows 10 берётся акрил, а если и его нет — обычный фон.</summary>
    public static SystemBackdrop? CreateBackdrop(BackdropChoice choice)
    {
        switch (choice)
        {
            case BackdropChoice.None:
                return null;
            case BackdropChoice.Acrylic:
                return AcrylicSupported ? new DesktopAcrylicBackdrop() : MicaFallback();
            case BackdropChoice.MicaAlt when MicaSupported:
                return new MicaBackdrop { Kind = MicaKind.BaseAlt };
            case BackdropChoice.Mica when MicaSupported:
                return new MicaBackdrop();
            default:
                return AcrylicSupported ? new DesktopAcrylicBackdrop() : null;
        }
    }

    private static SystemBackdrop? MicaFallback() => MicaSupported ? new MicaBackdrop() : null;

    /// <summary>Что именно получится при выбранном материале (для подсказки в настройках).</summary>
    public static string BackdropNote(BackdropChoice choice) => choice switch {
        BackdropChoice.None => "Сплошной фон без прозрачности.",
        BackdropChoice.Acrylic when !AcrylicSupported => "Акрил недоступен в этой системе, используется обычный фон.",
        BackdropChoice.Acrylic => "Полупрозрачный акрил.",
        _ when MicaSupported => "Mica — материал Windows 11, подстраивается под обои.",
        _ when AcrylicSupported => "Mica есть только в Windows 11. В этой системе вместо него используется акрил.",
        _ => "Прозрачные материалы недоступны в этой системе, используется обычный фон.",
    };

    public static Color? ParseColor(string? hex)
    {
        var normalized = DevicePreferences.NormalizeColor(hex);
        if (normalized is null)
        {
            return null;
        }

        return Color.FromArgb(255, Convert.ToByte(normalized.Substring(1, 2), 16), Convert.ToByte(normalized.Substring(3, 2), 16),
            Convert.ToByte(normalized.Substring(5, 2), 16));
    }

    private static Color Mix(Color c, Color other, double amount) => Color.FromArgb(255,
        (byte)Math.Round(c.R + ((other.R - c.R) * amount)),
        (byte)Math.Round(c.G + ((other.G - c.G) * amount)),
        (byte)Math.Round(c.B + ((other.B - c.B) * amount)));

    private static Color WithAlpha(Color c, double alpha) => Color.FromArgb((byte)Math.Round(255 * alpha), c.R, c.G, c.B);

    /// <summary>Набор оттенков акцентного цвета (как SystemAccentColor, Light1–3, Dark1–3 в Windows).</summary>
    internal sealed record AccentSet(Color Accent, Color[] Lights, Color[] Darks)
    {
        public Color Light(int step) => Lights[step - 1];

        public Color Dark(int step) => Darks[step - 1];

        /// <summary>Цвет заливки акцентных элементов (кнопка, переключатель): в светлой теме темнее выбранного цвета, в тёмной светлее.</summary>
        public Color Fill(bool dark) => dark ? Light(2) : Dark(1);
    }

    /// <summary>Свой цвет и его оттенки (формула та же, что для расчёта предпросмотра: 18% к белому или чёрному за ступень).</summary>
    internal static AccentSet Shades(Color accent) =>
        new(accent, [.. Enumerable.Range(1, 3).Select(i => Mix(accent, Colors.White, 0.18 * i))], [.. Enumerable.Range(1, 3).Select(i => Mix(accent, Colors.Black, 0.18 * i))]);

    /// <summary>Акцентный цвет Windows и его оттенки, как их видит система.</summary>
    internal static AccentSet SystemShades()
    {
        var ui = new Windows.UI.ViewManagement.UISettings();
        return new AccentSet(ui.GetColorValue(Windows.UI.ViewManagement.UIColorType.Accent),
            [ui.GetColorValue(Windows.UI.ViewManagement.UIColorType.AccentLight1), ui.GetColorValue(Windows.UI.ViewManagement.UIColorType.AccentLight2), ui.GetColorValue(Windows.UI.ViewManagement.UIColorType.AccentLight3)],
            [ui.GetColorValue(Windows.UI.ViewManagement.UIColorType.AccentDark1), ui.GetColorValue(Windows.UI.ViewManagement.UIColorType.AccentDark2), ui.GetColorValue(Windows.UI.ViewManagement.UIColorType.AccentDark3)]);
    }

    private static readonly string[] Themes = ["Light", "Dark"];

    // Кисти создаются один раз и дальше только меняют цвет: все элементы, которые уже ссылаются на кисть, перекрашиваются сразу.
    private static readonly Dictionary<string, SolidColorBrush> LiveBrushes = [];

    /// <summary>
    /// Подставляет акцентный цвет в ресурсы приложения (hex = null — цвет Windows). Вызывается до создания окна и затем при каждой
    /// смене цвета: стандартные элементы берут заливку из кистей AccentFill…/AccentText… этого словаря, а кисти при смене цвета
    /// меняют цвет «на месте», поэтому перезапуск не нужен. Остальные ресурсы читаются заново после <see cref="Refresh"/>.
    /// </summary>
    public static void ApplyAccent(string? hex)
    {
        var set = ParseColor(hex) is { } custom ? Shades(custom) : SystemShades();
        var resources = Application.Current.Resources;
        resources["SystemAccentColor"] = set.Accent;
        for (var i = 1; i <= 3; i++)
        {
            resources["SystemAccentColorLight" + i] = set.Light(i);
            resources["SystemAccentColorDark" + i] = set.Dark(i);
        }

        foreach (var theme in Themes)
        {
            var dark = theme == "Dark";
            var fill = set.Fill(dark);
            var dictionary = ThemeDictionary(resources, theme);
            void Put(string name, Color color)
            {
                dictionary[name] = color;
                var key = theme + "/" + name;
                if (LiveBrushes.TryGetValue(key, out var brush))
                {
                    brush.Color = color;
                }
                else
                {
                    brush = new SolidColorBrush(color);
                    LiveBrushes[key] = brush;
                }

                dictionary[name + "Brush"] = brush;
            }

            Put("AccentFillColorDefault", fill);
            Put("AccentFillColorSecondary", WithAlpha(fill, 0.9));
            Put("AccentFillColorTertiary", WithAlpha(fill, 0.8));
            Put("AccentFillColorSelectedTextBackground", set.Accent);
            Put("AccentTextFillColorPrimary", dark ? set.Light(3) : set.Dark(2));
            Put("AccentTextFillColorSecondary", dark ? set.Light(3) : set.Dark(3));
            Put("AccentTextFillColorTertiary", dark ? set.Light(2) : set.Dark(1));
        }
    }

    private static Windows.UI.ViewManagement.UISettings? _systemWatcher;

    /// <summary>Пока выбран цвет Windows, следует за ним: пользователь сменил акцент в системе — приложение перекрашивается без перезапуска.</summary>
    public static void FollowSystemAccent(DevicePreferences device)
    {
        _systemWatcher = new Windows.UI.ViewManagement.UISettings();
        _systemWatcher.ColorValuesChanged += (_, _) => App.Instance.Ui.Post(() =>
        {
            if (device.Accent is null)
            {
                ApplyAccent(null);
                Refresh(App.Instance.MainWindow.RootElement);
            }
        });
    }

    /// <summary>Цвет, которым сейчас закрашена акцентная заливка в теме (для проверки).</summary>
    internal static Color? CurrentFill(bool dark) =>
        LiveBrushes.TryGetValue((dark ? "Dark" : "Light") + "/AccentFillColorDefault", out var brush) ? brush.Color : null;

    private static ResourceDictionary ThemeDictionary(ResourceDictionary resources, string theme)
    {
        if (resources.ThemeDictionaries.TryGetValue(theme, out var existing) && existing is ResourceDictionary dictionary)
        {
            return dictionary;
        }

        var fresh = new ResourceDictionary();
        resources.ThemeDictionaries[theme] = fresh;
        return fresh;
    }

    /// <summary>
    /// Заставляет уже показанные элементы заново прочитать ресурсы темы: на мгновение переключает тему корневого элемента
    /// на противоположную и сразу возвращает. Всё происходит в одном такте интерфейса, мерцания нет.
    /// </summary>
    public static void Refresh(FrameworkElement root)
    {
        var requested = root.RequestedTheme;
        root.RequestedTheme = root.ActualTheme == ElementTheme.Dark ? ElementTheme.Light : ElementTheme.Dark;
        root.RequestedTheme = requested;
    }

    /// <summary>Цвета кнопок свернуть/развернуть/закрыть под текущую тему (окно рисует их само, а тему задаём мы).</summary>
    public static void StyleTitleBar(AppWindow window, bool dark)
    {
        if (!AppWindowTitleBar.IsCustomizationSupported())
        {
            return;
        }

        var bar = window.TitleBar;
        var fore = dark ? Colors.White : Colors.Black;
        var hover = dark ? Color.FromArgb(40, 255, 255, 255) : Color.FromArgb(28, 0, 0, 0);
        bar.ButtonBackgroundColor = Colors.Transparent;
        bar.ButtonInactiveBackgroundColor = Colors.Transparent;
        bar.ButtonForegroundColor = fore;
        bar.ButtonInactiveForegroundColor = Color.FromArgb(160, fore.R, fore.G, fore.B);
        bar.ButtonHoverBackgroundColor = hover;
        bar.ButtonHoverForegroundColor = fore;
        bar.ButtonPressedBackgroundColor = Color.FromArgb(60, fore.R, fore.G, fore.B);
        bar.ButtonPressedForegroundColor = fore;
    }
}
