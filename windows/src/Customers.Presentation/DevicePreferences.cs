using System.Text.Json;
using System.Text.Json.Nodes;

namespace Customers.Presentation;

public enum ThemeChoice
{
    System,
    Light,
    Dark,
}

public enum BackdropChoice
{
    Mica,
    MicaAlt,
    Acrylic,
    None,
}

/// <summary>
/// Настройки этого компьютера, не относящиеся к учётной записи: оформление, размеры панелей, окно.
/// Хранятся в device.json в папке данных. Повреждённый файл не мешает запуску — берутся значения по умолчанию.
/// </summary>
public sealed class DevicePreferences : ObservableObject
{
    private readonly string _path;
    private readonly object _gate = new();
    private ThemeChoice _theme = ThemeChoice.System;
    private BackdropChoice _backdrop = BackdropChoice.Mica;
    private string? _accent;
    private double _navWidth = 260;
    private bool _navOpen = true;
    private bool _navHidden;
    private double _inspectorWidth = 400;
    private bool _inspectorShown = true;
    private bool _compactRows;
    private bool _animations = true;
    private bool _checkUpdates = true;
    private int _updateCheckHours = UpdateSchedule.DefaultHours;
    private DateTimeOffset? _lastUpdateCheck;
    private bool _backgroundDownload = true;
    private string? _lastSeenVersion;
    private bool _closeToTray = true;
    private bool _startMinimized = true;
    private bool _trayHintShown;
    private string? _rememberedUser;
    private string _lastSection = "all";
    private double _windowWidth = 1360;
    private double _windowHeight = 860;
    private bool _maximized;
    private string _listSort = "score";
    private bool _listSortDescending = true;

    public DevicePreferences(string path)
    {
        _path = path;
        Load();
    }

    public ThemeChoice Theme { get => _theme; set => Update(ref _theme, value); }

    public BackdropChoice Backdrop { get => _backdrop; set => Update(ref _backdrop, value); }

    /// <summary>Свой акцентный цвет (#RRGGBB) или null — системный.</summary>
    public string? Accent { get => _accent; set => Update(ref _accent, NormalizeColor(value)); }

    public double NavWidth { get => _navWidth; set => Update(ref _navWidth, Math.Clamp(value, 180, 420)); }

    public bool NavOpen { get => _navOpen; set => Update(ref _navOpen, value); }

    public bool NavHidden { get => _navHidden; set => Update(ref _navHidden, value); }

    public double InspectorWidth { get => _inspectorWidth; set => Update(ref _inspectorWidth, Math.Clamp(value, 280, 640)); }

    public bool InspectorShown { get => _inspectorShown; set => Update(ref _inspectorShown, value); }

    public bool CompactRows { get => _compactRows; set => Update(ref _compactRows, value); }

    public bool Animations { get => _animations; set => Update(ref _animations, value); }

    public bool CheckUpdates { get => _checkUpdates; set => Update(ref _checkUpdates, value); }

    /// <summary>Как часто автоматически проверять обновления, в часах: 0 — при каждом запуске, иначе одно из <see cref="UpdateSchedule.Choices"/>.</summary>
    public int UpdateCheckHours { get => _updateCheckHours; set => Update(ref _updateCheckHours, UpdateSchedule.Normalize(value)); }

    /// <summary>Когда обновления проверялись в последний раз (автоматически или вручную).</summary>
    public DateTimeOffset? LastUpdateCheck { get => _lastUpdateCheck; set => Update(ref _lastUpdateCheck, value); }

    /// <summary>Скачивать найденное обновление в фоне, пока пользователь работает. Установка всё равно только по согласию.</summary>
    public bool BackgroundDownload { get => _backgroundDownload; set => Update(ref _backgroundDownload, value); }

    /// <summary>Версия, для которой уже показан экран «Что нового» (или записана молча при первом запуске).</summary>
    public string? LastSeenVersion { get => _lastSeenVersion; set => Update(ref _lastSeenVersion, value); }

    /// <summary>Закрытие окна не завершает приложение, а оставляет его работать в области уведомлений (автопоиск и копии продолжаются).</summary>
    public bool CloseToTray { get => _closeToTray; set => Update(ref _closeToTray, value); }

    /// <summary>При запуске вместе с Windows не показывать окно, а оставить приложение в области уведомлений.</summary>
    public bool StartMinimized { get => _startMinimized; set => Update(ref _startMinimized, value); }

    /// <summary>Подсказка «приложение продолжает работать в фоне» уже показана.</summary>
    public bool TrayHintShown { get => _trayHintShown; set => Update(ref _trayHintShown, value); }

    /// <summary>Имя локальной учётной записи, в которую входить автоматически.</summary>
    public string? RememberedUser { get => _rememberedUser; set => Update(ref _rememberedUser, value); }

    public string LastSection { get => _lastSection; set => Update(ref _lastSection, value); }

    public double WindowWidth { get => _windowWidth; set => Update(ref _windowWidth, Math.Clamp(value, 800, 8000)); }

    public double WindowHeight { get => _windowHeight; set => Update(ref _windowHeight, Math.Clamp(value, 560, 8000)); }

    public bool Maximized { get => _maximized; set => Update(ref _maximized, value); }

    public string ListSort { get => _listSort; set => Update(ref _listSort, value); }

    public bool ListSortDescending { get => _listSortDescending; set => Update(ref _listSortDescending, value); }

    public static string? NormalizeColor(string? raw)
    {
        var s = (raw ?? "").Trim().TrimStart('#');
        return s.Length == 6 && s.All(Uri.IsHexDigit) ? "#" + s.ToUpperInvariant() : null;
    }

    private void Update<T>(ref T field, T value, [System.Runtime.CompilerServices.CallerMemberName] string? name = null)
    {
        if (Set(ref field, value, name))
        {
            Save();
        }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_path) || JsonNode.Parse(File.ReadAllText(_path)) is not JsonObject o)
            {
                return;
            }

            T? Get<T>(string key) => o[key] is JsonValue v && v.TryGetValue<T>(out var x) ? x : default;
            if (Enum.TryParse<ThemeChoice>(Get<string>("theme"), true, out var t))
            {
                _theme = t;
            }

            if (Enum.TryParse<BackdropChoice>(Get<string>("backdrop"), true, out var b))
            {
                _backdrop = b;
            }

            _accent = NormalizeColor(Get<string>("accent"));
            _navWidth = Math.Clamp(Get<double?>("navWidth") ?? _navWidth, 180, 420);
            _navOpen = Get<bool?>("navOpen") ?? _navOpen;
            _navHidden = Get<bool?>("navHidden") ?? _navHidden;
            _inspectorWidth = Math.Clamp(Get<double?>("inspectorWidth") ?? _inspectorWidth, 280, 640);
            _inspectorShown = Get<bool?>("inspectorShown") ?? _inspectorShown;
            _compactRows = Get<bool?>("compactRows") ?? _compactRows;
            _animations = Get<bool?>("animations") ?? _animations;
            _checkUpdates = Get<bool?>("checkUpdates") ?? _checkUpdates;
            _updateCheckHours = UpdateSchedule.Normalize(Get<int?>("updateCheckHours") ?? _updateCheckHours);
            _lastUpdateCheck = DateTimeOffset.TryParse(Get<string>("lastUpdateCheck"), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out var last) ? last : null;
            _backgroundDownload = Get<bool?>("backgroundDownload") ?? _backgroundDownload;
            _lastSeenVersion = Get<string>("lastSeenVersion");
            _closeToTray = Get<bool?>("closeToTray") ?? _closeToTray;
            _startMinimized = Get<bool?>("startMinimized") ?? _startMinimized;
            _trayHintShown = Get<bool?>("trayHintShown") ?? _trayHintShown;
            _rememberedUser = Get<string>("rememberedUser");
            _lastSection = Get<string>("lastSection") ?? _lastSection;
            _windowWidth = Math.Clamp(Get<double?>("windowWidth") ?? _windowWidth, 800, 8000);
            _windowHeight = Math.Clamp(Get<double?>("windowHeight") ?? _windowHeight, 560, 8000);
            _maximized = Get<bool?>("maximized") ?? _maximized;
            _listSort = Get<string>("listSort") ?? _listSort;
            _listSortDescending = Get<bool?>("listSortDescending") ?? _listSortDescending;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            // Берём значения по умолчанию.
        }
    }

    public void Save()
    {
        var o = new JsonObject {
            ["theme"] = Theme.ToString(),
            ["backdrop"] = Backdrop.ToString(),
            ["accent"] = Accent,
            ["navWidth"] = NavWidth,
            ["navOpen"] = NavOpen,
            ["navHidden"] = NavHidden,
            ["inspectorWidth"] = InspectorWidth,
            ["inspectorShown"] = InspectorShown,
            ["compactRows"] = CompactRows,
            ["animations"] = Animations,
            ["checkUpdates"] = CheckUpdates,
            ["updateCheckHours"] = UpdateCheckHours,
            ["lastUpdateCheck"] = LastUpdateCheck?.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            ["backgroundDownload"] = BackgroundDownload,
            ["lastSeenVersion"] = LastSeenVersion,
            ["closeToTray"] = CloseToTray,
            ["startMinimized"] = StartMinimized,
            ["trayHintShown"] = TrayHintShown,
            ["rememberedUser"] = RememberedUser,
            ["lastSection"] = LastSection,
            ["windowWidth"] = WindowWidth,
            ["windowHeight"] = WindowHeight,
            ["maximized"] = Maximized,
            ["listSort"] = ListSort,
            ["listSortDescending"] = ListSortDescending,
        };
        try
        {
            lock (_gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_path))!);
                var tmp = _path + ".tmp";
                File.WriteAllText(tmp, o.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
                File.Move(tmp, _path, overwrite: true); // запись целиком или не запись вовсе
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}
