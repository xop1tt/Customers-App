namespace Customers.Presentation;

/// <summary>
/// Облегчённый режим: меньше анимаций и прозрачных материалов, когда Windows экономит энергию или батарея почти разряжена.
/// Правила (порог, режим экономии, нет батареи) — в <see cref="PowerPolicy"/>; здесь только текущее состояние для интерфейса.
/// Состояние питания приходит снаружи (из системы), поэтому модель проверяется тестами без Windows.
/// </summary>
public sealed class LightModeModel : ObservableObject
{
    private readonly DevicePreferences _device;
    private PowerState _state = new();
    private LightModeReason? _reason;

    public LightModeModel(DevicePreferences device)
    {
        _device = device;
        _device.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName is nameof(DevicePreferences.LightModeAuto) or nameof(DevicePreferences.LightModeThreshold))
            {
                Recalculate();
            }
        };
    }

    /// <summary>Последнее известное состояние питания.</summary>
    public PowerState State => _state;

    /// <summary>Причина включения или null, если режим выключен.</summary>
    public LightModeReason? Reason { get => _reason; private set { if (Set(ref _reason, value)) { Raise(nameof(Active)); } } }

    public bool Active => _reason is not null;

    /// <summary>Есть ли в компьютере батарея (без неё остаётся только режим экономии Windows).</summary>
    public bool HasBattery => _state.BatteryPercent is not null;

    /// <summary>Система сообщила новое состояние питания.</summary>
    public void Update(PowerState state)
    {
        _state = state;
        Raise(nameof(State));
        Raise(nameof(HasBattery));
        Recalculate();
    }

    private void Recalculate() => Reason = PowerPolicy.Evaluate(_state, _device.LightModeAuto, _device.LightModeThreshold);
}
