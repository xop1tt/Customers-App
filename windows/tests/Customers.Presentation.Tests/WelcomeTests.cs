namespace Customers.Presentation.Tests;

public sealed class WelcomeTests : IDisposable
{
    private readonly Sandbox _box = new();

    public void Dispose() => _box.Dispose();

    private AppModel Model(string name = "maksim")
    {
        var m = new AppModel(_box.Env(), name, name, false, Path.Combine(_box.Root, "users", name));
        Assert.Null(m.StartupError);
        return m;
    }

    private sealed class Scope(AppModel model) : IDisposable
    {
        public AppModel Model { get; } = model;

        public void Dispose() => Model.Shutdown();
    }

    private static WelcomeModel Wizard(AppModel m) => new(m, new IntegrationsModel(m.Environment, m.Username));

    [Fact]
    public void WalksThroughAllStepsWithProgressAndBack()
    {
        using var scope = new Scope(Model());
        var w = Wizard(scope.Model);
        Assert.Equal(WelcomeStep.Intro, w.Step);
        Assert.Equal("Шаг 1 из 5", w.Position);
        Assert.False(w.CanGoBack);
        Assert.False(w.CanSkip);
        var seen = new List<WelcomeStep> { w.Step };
        var progress = new List<double> { w.Progress };
        while (!w.IsLast)
        {
            w.Next();
            seen.Add(w.Step);
            progress.Add(w.Progress);
        }

        Assert.Equal(WelcomeSteps.All, seen);
        Assert.Equal(1.0, progress[^1]);
        Assert.Equal(progress.Order().ToList(), progress);
        Assert.True(w.CanGoBack);
        w.Back();
        Assert.Equal(WelcomeStep.Drives, w.Step);
        Assert.False(w.IsLast);
        Assert.Equal("Шаг 4 из 5", w.Position);
    }

    [Fact]
    public void OptionalStepsCanBeSkippedButIntroCannot()
    {
        using var scope = new Scope(Model());
        var w = Wizard(scope.Model);
        w.Skip(); // знакомство: просто идём дальше
        Assert.Equal(WelcomeStep.Sources, w.Step);
        Assert.Equal(WelcomeStepState.Pending, w.StateOf(WelcomeStep.Intro));
        scope.Model.UpdateSearchSettings(s => { s.Rss.Enabled = s.Telegram.Enabled = s.Vk.Enabled = s.Osm.Enabled = false; });
        w.Skip();
        Assert.Equal(WelcomeStepState.Skipped, w.StateOf(WelcomeStep.Sources));
        w.Skip();
        w.Skip();
        Assert.Equal(WelcomeStepState.Skipped, w.StateOf(WelcomeStep.Integrations));
        Assert.Equal(WelcomeStepState.Skipped, w.StateOf(WelcomeStep.Drives));
        Assert.True(w.IsLast);
        w.Back();
        w.Next(); // вернулись к дискам и прошли «Далее»: больше не «пропущено»
        Assert.Equal(WelcomeStepState.Pending, w.StateOf(WelcomeStep.Drives));
        Assert.True(w.IsLast);
        Assert.False(w.Finished);
        w.Next(); // «Далее» на последнем шаге — готово
        Assert.True(w.Finished);
    }

    [Fact]
    public void FinishMarksDoneOpensHomeAndRaisesCompletedOnce()
    {
        using var scope = new Scope(Model());
        var m = scope.Model;
        m.Section = NavSection.Archive;
        var w = Wizard(m);
        var completed = 0;
        w.Completed += () => completed++;
        Assert.True(WelcomeModel.IsNeeded(m));
        while (!w.Finished)
        {
            w.Next();
        }

        w.Finish();
        Assert.Equal(1, completed);
        Assert.True(m.Prefs.WelcomeDone);
        Assert.Equal(NavSection.Home, m.Section);
        Assert.False(WelcomeModel.IsNeeded(m));
        Assert.False(w.CanGoBack);
    }

    [Fact]
    public void ClosingWizardEarlyAlsoCompletesIt()
    {
        using var scope = new Scope(Model());
        var w = Wizard(scope.Model);
        w.Next();
        w.Finish();
        Assert.True(scope.Model.Prefs.WelcomeDone);
        Assert.True(w.Finished);
    }

    [Fact]
    public void AlreadyConfiguredThingsAreRecognised()
    {
        using var scope = new Scope(Model());
        var m = scope.Model;
        var w = Wizard(m);
        Assert.True(w.SourcesConfigured); // источники по умолчанию включены
        Assert.False(w.IntegrationsConfigured);
        Assert.False(w.DrivesConfigured);
        Assert.Equal(WelcomeStepState.Configured, w.StateOf(WelcomeStep.Sources));
        m.SetCrmSecret(CrmKind.Webhook, "https://hooks.example.com/abc");
        Assert.True(w.IntegrationsConfigured);
        Assert.Equal(WelcomeStepState.Configured, w.StateOf(WelcomeStep.Integrations));
        w.Skip();
        w.Skip();
        w.Skip(); // интеграции: пропуск не затирает уже настроенное
        Assert.Equal(WelcomeStepState.Configured, w.StateOf(WelcomeStep.Integrations));
    }

    [Fact]
    public void SettledAccountsDoNotGetWizard()
    {
        using var scope = new Scope(Model());
        var m = scope.Model;
        Assert.True(WelcomeModel.IsNeeded(m));
        Data.Seed(m);
        Assert.False(WelcomeModel.IsNeeded(m));
        WelcomeModel.MarkLegacyAccount(m);
        Assert.True(m.Prefs.WelcomeDone);
    }

    [Fact]
    public void FreshAccountIsNotMarkedAsLegacy()
    {
        using var scope = new Scope(Model("новый"));
        WelcomeModel.MarkLegacyAccount(scope.Model);
        Assert.False(scope.Model.Prefs.WelcomeDone);
        Assert.True(WelcomeModel.IsNeeded(scope.Model));
    }

    [Fact]
    public void WelcomeStateSurvivesReopen()
    {
        using (var scope = new Scope(Model()))
        {
            Wizard(scope.Model).Finish();
        }

        using var again = new Scope(Model());
        Assert.True(again.Model.Prefs.WelcomeDone);
        Assert.False(WelcomeModel.IsNeeded(again.Model));
    }

    [Fact]
    public void AppearanceChangesApplyImmediatelyThroughDevicePreferences()
    {
        var env = _box.Env();
        var changed = new List<string>();
        env.Device.PropertyChanged += (_, e) => changed.Add(e.PropertyName!);
        env.Device.Theme = ThemeChoice.Dark;
        env.Device.Accent = "#2E7D32";
        Assert.Contains(nameof(DevicePreferences.Theme), changed);
        Assert.Contains(nameof(DevicePreferences.Accent), changed);
        Assert.Equal("#2E7D32", new DevicePreferences(Path.Combine(_box.Root, "device.json")).Accent);
    }
}
