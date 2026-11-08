using System.Runtime.InteropServices;
using Windows.System.Power;

namespace Customers.Ui;

/// <summary>
/// Следит за питанием компьютера (режим экономии энергии Windows, заряд батареи, зарядное устройство) и сообщает о нём
/// <see cref="LightModeModel"/>. Решение о включении облегчённого режима принимает <see cref="PowerPolicy"/>, здесь только чтение системы.
/// </summary>
internal sealed class PowerWatcher : IDisposable
{
    private readonly LightModeModel _model;
    private readonly IUiDispatcher _ui;
    private readonly FileLog _log;
    private bool _started;

    public PowerWatcher(LightModeModel model, IUiDispatcher ui, FileLog log)
    {
        _model = model;
        _ui = ui;
        _log = log;
    }

    public void Start()
    {
        if (_started)
        {
            return;
        }

        _started = true;
        try
        {
            PowerManager.EnergySaverStatusChanged += OnChanged;
            PowerManager.RemainingChargePercentChanged += OnChanged;
            PowerManager.BatteryStatusChanged += OnChanged;
            PowerManager.PowerSupplyStatusChanged += OnChanged;
        }
        catch (Exception e) when (e is COMException or InvalidOperationException or TypeLoadException)
        {
            _log.Warn("Состояние питания недоступно, облегчённый режим по заряду не работает: " + e.Message);
        }

        Refresh();
    }

    public void Dispose()
    {
        if (!_started)
        {
            return;
        }

        _started = false;
        try
        {
            PowerManager.EnergySaverStatusChanged -= OnChanged;
            PowerManager.RemainingChargePercentChanged -= OnChanged;
            PowerManager.BatteryStatusChanged -= OnChanged;
            PowerManager.PowerSupplyStatusChanged -= OnChanged;
        }
        catch (Exception e) when (e is COMException or InvalidOperationException or TypeLoadException)
        {
            // Приложение закрывается: отписка не обязательна.
        }
    }

    private void OnChanged(object? sender, object e) => _ui.Post(Refresh);

    /// <summary>Читает текущее состояние. Любой сбой системы означает «сведений нет»: остаётся обычный режим.</summary>
    public void Refresh() => _model.Update(Read());

    internal static PowerState Read()
    {
        try
        {
            var saver = PowerManager.EnergySaverStatus == EnergySaverStatus.On;
            if (PowerManager.BatteryStatus == BatteryStatus.NotPresent)
            {
                return new PowerState(saver); // настольный компьютер: заряда нет
            }

            var percent = PowerManager.RemainingChargePercent;
            var charging = PowerManager.PowerSupplyStatus != PowerSupplyStatus.NotPresent || PowerManager.BatteryStatus == BatteryStatus.Charging;
            return new PowerState(saver, percent is >= 0 and <= 100 ? percent : null, charging);
        }
        catch (Exception e) when (e is COMException or InvalidOperationException or TypeLoadException)
        {
            return new PowerState();
        }
    }
}
