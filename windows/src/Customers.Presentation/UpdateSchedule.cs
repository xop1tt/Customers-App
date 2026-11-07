namespace Customers.Presentation;

/// <summary>Расписание автоматической проверки обновлений: как часто и пора ли проверять сейчас.</summary>
public static class UpdateSchedule
{
    public const int DefaultHours = 24;

    /// <summary>Доступные варианты частоты (часы): при каждом запуске, раз в сутки, в неделю, в месяц.</summary>
    public static readonly IReadOnlyList<(string Title, int Hours)> Choices =
    [
        ("При каждом запуске", 0),
        ("Раз в сутки", 24),
        ("Раз в неделю", 168),
        ("Раз в месяц", 720),
    ];

    /// <summary>Приводит значение к одному из вариантов (неизвестное — к значению по умолчанию).</summary>
    public static int Normalize(int hours) => Choices.Any(c => c.Hours == hours) ? hours : DefaultHours;

    /// <summary>Пора ли проверять: автоматическая проверка включена и с прошлой прошло не меньше выбранного срока.</summary>
    public static bool IsDue(bool enabled, int hours, DateTimeOffset? last, DateTimeOffset now) =>
        enabled && (hours <= 0 || last is null || last > now || now - last.Value >= TimeSpan.FromHours(hours));
}
