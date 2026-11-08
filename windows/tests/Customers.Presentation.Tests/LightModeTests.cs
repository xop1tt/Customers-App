namespace Customers.Presentation.Tests;

public sealed class LightModeTests : IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), "light-" + Guid.NewGuid().ToString("N") + ".json");

    public void Dispose()
    {
        if (File.Exists(_path))
        {
            File.Delete(_path);
        }
    }

    [Fact]
    public void DefaultsAreAutomaticWithTwentyPercent()
    {
        var device = new DevicePreferences(_path);
        Assert.True(device.LightModeAuto);
        Assert.Equal(20, device.LightModeThreshold);
    }

    [Fact]
    public void ThresholdIsClampedAndPersisted()
    {
        var device = new DevicePreferences(_path) { LightModeThreshold = 3, LightModeAuto = false };
        Assert.Equal(PowerPolicy.MinThreshold, device.LightModeThreshold);
        device.LightModeThreshold = 80;
        Assert.Equal(PowerPolicy.MaxThreshold, device.LightModeThreshold);
        device.LightModeThreshold = 35;
        var again = new DevicePreferences(_path);
        Assert.Equal(35, again.LightModeThreshold);
        Assert.False(again.LightModeAuto);
    }

    [Fact]
    public void TurnsOnAndOffWithThePowerState()
    {
        var model = new LightModeModel(new DevicePreferences(_path));
        var changes = new List<string?>();
        model.PropertyChanged += (_, e) => changes.Add(e.PropertyName);

        Assert.False(model.Active);
        model.Update(new PowerState(false, 15, false));
        Assert.True(model.Active);
        Assert.Equal(new LightModeReason.LowBattery(15, 20), model.Reason);
        Assert.Contains(nameof(LightModeModel.Active), changes);

        model.Update(new PowerState(false, 15, true)); // поставили на зарядку: обычный режим
        Assert.False(model.Active);

        model.Update(new PowerState(true, 90, true));
        Assert.IsType<LightModeReason.SystemSaver>(model.Reason);
        model.Update(new PowerState(false, 90, true));
        Assert.Null(model.Reason);
    }

    [Fact]
    public void ChangingSettingsRecalculatesImmediately()
    {
        var device = new DevicePreferences(_path);
        var model = new LightModeModel(device);
        model.Update(new PowerState(false, 30, false));
        Assert.False(model.Active);
        device.LightModeThreshold = 40;
        Assert.True(model.Active);
        device.LightModeAuto = false;
        Assert.False(model.Active);
        device.LightModeAuto = true;
        Assert.True(model.Active);
    }

    [Fact]
    public void NoBatteryInformationIsHandled()
    {
        var model = new LightModeModel(new DevicePreferences(_path));
        model.Update(new PowerState());
        Assert.False(model.HasBattery);
        Assert.False(model.Active);
        model.Update(new PowerState(true));
        Assert.True(model.Active);
    }

    [Fact]
    public void WindowsDigestKeepsOnlyWindowsChanges()
    {
        var f = WhatsNewDigest.Build("- Windows: адаптивная сетка карточек\n- macOS: окно настроек", ReleasePlatform.Windows);
        Assert.Single(f);
    }
}
