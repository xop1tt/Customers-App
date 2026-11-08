namespace Customers.Core;

/// <summary>Состояние питания устройства.</summary>
/// <param name="SystemSaver">Включён системный режим экономии энергии.</param>
/// <param name="BatteryPercent">Заряд батареи в процентах; null, если батареи нет или система не сообщает.</param>
/// <param name="Charging">Подключено ли зарядное устройство; null — неизвестно.</param>
public sealed record PowerState(bool SystemSaver = false, int? BatteryPercent = null, bool? Charging = null);

/// <summary>Почему включён облегчённый режим (объясняется пользователю).</summary>
public abstract record LightModeReason
{
    public sealed record SystemSaver : LightModeReason;

    public sealed record LowBattery(int Percent, int Threshold) : LightModeReason;

    public string Explanation => this switch {
        SystemSaver => "Включён режим экономии энергии Windows: тяжёлые анимации и эффекты отключены.",
        LowBattery l => $"Заряд батареи {l.Percent}% ниже порога {l.Threshold}%: тяжёлые анимации и эффекты отключены.",
        _ => "",
    };

    public string ShortTitle => this switch {
        SystemSaver => "Экономия энергии Windows",
        LowBattery l => $"Низкий заряд, {l.Percent}%",
        _ => "",
    };
}

/// <summary>Решение об облегчённом режиме: по режиму экономии энергии системы и по заряду батареи.</summary>
public static class PowerPolicy
{
    public const int DefaultThreshold = 20;
    public const int MinThreshold = 5;
    public const int MaxThreshold = 50;

    public static int Clamp(int threshold) => Math.Min(Math.Max(threshold, MinThreshold), MaxThreshold);

    /// <summary>
    /// Причина включения облегчённого режима или null, если нужен обычный. Батарея учитывается, только пока устройство
    /// не заряжается. Если заряд неизвестен (стационарный компьютер, нет доступа к сведениям), работает один лишь
    /// режим экономии энергии системы.
    /// </summary>
    public static LightModeReason? Evaluate(PowerState state, bool automatic, int threshold)
    {
        if (!automatic)
        {
            return null;
        }

        if (state.SystemSaver)
        {
            return new LightModeReason.SystemSaver();
        }

        var limit = Clamp(threshold);
        return state.BatteryPercent is { } p && state.Charging != true && p < limit ? new LightModeReason.LowBattery(p, limit) : null;
    }
}
