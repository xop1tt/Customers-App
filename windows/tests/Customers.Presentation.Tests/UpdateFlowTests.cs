using System.Security.Cryptography;
using System.Text;

namespace Customers.Presentation.Tests;

internal sealed class ScriptedDownloader(byte[] data) : IFileDownloader
{
    public int Calls { get; private set; }

    public Exception? Fail { get; set; }

    public TaskCompletionSource? Gate { get; set; }

    public async Task<long> DownloadAsync(Uri url, string destination, IProgress<DownloadProgress>? progress, CancellationToken ct)
    {
        Calls++;
        if (Gate is not null)
        {
            await Gate.Task.WaitAsync(ct);
        }

        if (Fail is not null)
        {
            throw Fail;
        }

        await File.WriteAllBytesAsync(destination, data, ct);
        progress?.Report(new DownloadProgress(data.Length, data.Length));
        return data.Length;
    }
}

public sealed class UpdateModelTests : IDisposable
{
    private static readonly byte[] Payload = Encoding.UTF8.GetBytes(new string('x', 4000));
    private readonly Sandbox _box = new();
    private DateTimeOffset _now = DateTimeOffset.Parse("2026-11-08T10:00:00+00:00");

    public void Dispose() => _box.Dispose();

    private static string Hash(byte[] d) => Convert.ToHexStringLower(SHA256.HashData(d));

    private static string ReleaseJson(string tag = "v1.3.0", byte[]? payload = null) => $$"""
        {"tag_name":"{{tag}}","name":"Customers {{tag}}","body":"## Новое\n- **быстрее**","html_url":"https://github.com/x/y/releases/tag/{{tag}}","draft":false,"prerelease":false,
         "assets":[{"name":"Customers-{{tag}}-Windows-x64-Setup.exe","size":{{(payload ?? Payload).Length}},"browser_download_url":"https://example.com/s.exe","digest":"sha256:{{Hash(payload ?? Payload)}}"}]}
        """;

    private sealed class Rig
    {
        public required UpdateModel Model { get; init; }

        public required AppEnvironment Env { get; init; }

        public required ScriptedDownloader Downloader { get; init; }

        public List<string> Launched { get; } = [];

        public int Requests { get; set; }
    }

    private Rig Make(string installed = "1.2.0", Func<string>? release = null, bool online = true, Func<string, long>? free = null,
        bool metered = false, bool launchOk = true, byte[]? payload = null)
    {
        var downloader = new ScriptedDownloader(payload ?? Payload);
        Rig? rig = null;
        var env = AppEnvironment.ForTests(_box.Root,
            search: () => new MockSearchTransport(r =>
            {
                rig!.Requests++;
                return new HttpResult(200, Encoding.UTF8.GetBytes((release ?? (() => ReleaseJson()))()), new Dictionary<string, string>(), r.Url);
            }),
            downloader: downloader, freeSpace: free, launchInstaller: p =>
            {
                rig!.Launched.Add(p);
                return launchOk;
            }, isMetered: () => metered, now: () => _now, online: online);
        rig = new Rig { Downloader = downloader, Env = env, Model = new UpdateModel(env, AppVersion.Parse(installed)!) };
        return rig;
    }

    [Fact]
    public async Task CheckFindsOfferAndRemembersTime()
    {
        var r = Make();
        Assert.Equal(UpdatePhase.Idle, r.Model.Phase);
        var offer = await r.Model.CheckAsync();
        Assert.Equal("1.3.0", offer!.Version.ToString());
        Assert.Equal(UpdatePhase.Available, r.Model.Phase);
        Assert.Equal(_now, r.Env.Device.LastUpdateCheck);
        Assert.False(r.Model.ReadyToInstall);
    }

    [Fact]
    public async Task UpToDateAndOfflineAndServerErrors()
    {
        var up = Make("1.3.0");
        Assert.Null(await up.Model.CheckAsync());
        Assert.Equal(UpdatePhase.UpToDate, up.Model.Phase);

        var offline = Make(online: false);
        var lastBefore = offline.Env.Device.LastUpdateCheck;
        Assert.Null(await offline.Model.CheckAsync());
        Assert.Equal(UpdatePhase.Failed, offline.Model.Phase);
        Assert.Contains("интернет", offline.Model.Error, StringComparison.Ordinal);
        Assert.Equal(0, offline.Requests);
        Assert.Equal(lastBefore, offline.Env.Device.LastUpdateCheck); // неудачная проверка не считается проверкой
    }

    [Fact]
    public async Task DownloadProducesReadyUpdateAndRaisesEventWithoutInstalling()
    {
        var r = Make();
        StagedUpdate? announced = null;
        r.Model.UpdateReady += s => announced = s;
        await r.Model.CheckAsync();
        Assert.True(await r.Model.DownloadAsync());
        Assert.Equal(UpdatePhase.Ready, r.Model.Phase);
        Assert.True(r.Model.ReadyToInstall);
        Assert.Equal("1.3.0", announced!.Version);
        Assert.Empty(r.Launched);
        Assert.True(File.Exists(r.Model.Staged!.InstallerPath));
    }

    [Fact]
    public async Task ReadyUpdateSurvivesRestartAndIsDroppedOnceInstalled()
    {
        var r = Make();
        await r.Model.CheckAsync();
        await r.Model.DownloadAsync();
        var reopened = new UpdateModel(r.Env, AppVersion.Parse("1.2.0")!);
        Assert.Equal(UpdatePhase.Ready, reopened.Phase);
        Assert.Equal("1.3.0", reopened.Staged!.Version);
        var installed = new UpdateModel(r.Env, AppVersion.Parse("1.3.0")!);
        Assert.Equal(UpdatePhase.Idle, installed.Phase);
        Assert.Null(installed.Staged);
        Assert.False(File.Exists(reopened.Staged.InstallerPath));
    }

    [Fact]
    public async Task InstallRunsInstallerOnlyOnRequestAndKeepsNotesForWhatsNew()
    {
        var r = Make();
        await r.Model.CheckAsync();
        await r.Model.DownloadAsync();
        Assert.Empty(r.Launched);
        Assert.True(await r.Model.InstallAsync());
        Assert.Single(r.Launched);
        Assert.Equal(r.Model.Staged!.InstallerPath, r.Launched[0]);
        Assert.Contains("быстрее", r.Model.Stage.LoadInstalledNotes(AppVersion.Parse("1.3.0")!)!.Notes, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TamperedInstallerIsNotLaunched()
    {
        var r = Make();
        await r.Model.CheckAsync();
        await r.Model.DownloadAsync();
        var path = r.Model.Staged!.InstallerPath;
        await File.WriteAllBytesAsync(path, Encoding.UTF8.GetBytes(new string('y', 4000)));
        Assert.False(await r.Model.InstallAsync());
        Assert.Empty(r.Launched);
        Assert.Equal(UpdatePhase.Failed, r.Model.Phase);
        Assert.False(File.Exists(path));
        Assert.Null(r.Model.Staged);
    }

    [Fact]
    public async Task InstallerThatCannotStartLeavesAppUntouchedAndDropsNotes()
    {
        var r = Make(launchOk: false);
        await r.Model.CheckAsync();
        await r.Model.DownloadAsync();
        Assert.False(await r.Model.InstallAsync());
        Assert.Equal(UpdatePhase.Failed, r.Model.Phase);
        Assert.Null(r.Model.Stage.LoadInstalledNotes(AppVersion.Parse("1.3.0")!));
        Assert.NotNull(r.Model.Staged); // файл цел: можно повторить
    }

    [Fact]
    public async Task NotEnoughSpaceIsReportedAndAppKeepsWorking()
    {
        var r = Make(free: _ => 1000);
        await r.Model.CheckAsync();
        Assert.False(await r.Model.DownloadAsync());
        Assert.Equal(UpdatePhase.Failed, r.Model.Phase);
        Assert.True(r.Model.ErrorIsSpace);
        Assert.Contains("Недостаточно места", r.Model.Error, StringComparison.Ordinal);
        Assert.Equal(0, r.Downloader.Calls);
    }

    [Fact]
    public async Task ConnectionLossDuringDownloadIsReported()
    {
        var r = Make();
        r.Downloader.Fail = new HttpFailure("связь прервалась", null, transient: true);
        await r.Model.CheckAsync();
        Assert.False(await r.Model.DownloadAsync());
        Assert.Equal(UpdatePhase.Failed, r.Model.Phase);
        Assert.Contains("связь прервалась", r.Model.Error, StringComparison.Ordinal);
        Assert.Null(r.Model.Staged);
        Assert.False(r.Model.ErrorIsSpace);
    }

    [Fact]
    public async Task CancelledDownloadReturnsToAvailable()
    {
        var r = Make();
        r.Downloader.Gate = new TaskCompletionSource();
        await r.Model.CheckAsync();
        var task = r.Model.DownloadAsync();
        await Task.Delay(50);
        Assert.Equal(UpdatePhase.Downloading, r.Model.Phase);
        r.Model.CancelDownload();
        Assert.False(await task);
        Assert.Equal(UpdatePhase.Available, r.Model.Phase);
        Assert.True(r.Model.NeedsManualDownload || r.Env.Device.BackgroundDownload);
    }

    [Fact]
    public async Task ScheduledRunChecksThenDownloadsInBackgroundButNeverInstalls()
    {
        var r = Make();
        Assert.True(r.Model.IsCheckDue());
        await r.Model.RunScheduledAsync();
        Assert.Equal(UpdatePhase.Ready, r.Model.Phase);
        Assert.Empty(r.Launched);
        Assert.False(r.Model.IsCheckDue()); // только что проверили
        _now += TimeSpan.FromHours(23);
        Assert.False(r.Model.IsCheckDue());
        _now += TimeSpan.FromHours(1);
        Assert.True(r.Model.IsCheckDue());
    }

    [Fact]
    public async Task IntervalSettingControlsHowOftenWeCheck()
    {
        var r = Make();
        r.Env.Device.UpdateCheckHours = 168;
        await r.Model.CheckAsync();
        _now += TimeSpan.FromDays(6);
        Assert.False(r.Model.IsCheckDue());
        _now += TimeSpan.FromDays(1);
        Assert.True(r.Model.IsCheckDue());
        r.Env.Device.UpdateCheckHours = 5; // такого варианта нет
        Assert.Equal(UpdateSchedule.DefaultHours, r.Env.Device.UpdateCheckHours);
    }

    [Fact]
    public async Task EveryLaunchModeChecksOncePerRunNotOnEveryTick()
    {
        var r = Make();
        r.Env.Device.UpdateCheckHours = 0;
        Assert.True(r.Model.IsCheckDue());
        await r.Model.CheckAsync();
        _now += TimeSpan.FromHours(5);
        Assert.False(r.Model.IsCheckDue());
    }

    [Fact]
    public async Task BackgroundDownloadCanBeSwitchedOffAndManualDownloadStillWorks()
    {
        var r = Make();
        r.Env.Device.BackgroundDownload = false;
        await r.Model.RunScheduledAsync();
        Assert.Equal(UpdatePhase.Available, r.Model.Phase);
        Assert.True(r.Model.NeedsManualDownload);
        Assert.Equal(0, r.Downloader.Calls);
        Assert.True(await r.Model.DownloadAsync());
        Assert.True(r.Model.ReadyToInstall);
    }

    [Fact]
    public async Task AutomaticChecksOffMeansNothingHappens()
    {
        var r = Make();
        r.Env.Device.CheckUpdates = false;
        Assert.False(r.Model.IsCheckDue());
        await r.Model.RunScheduledAsync();
        Assert.Equal(UpdatePhase.Idle, r.Model.Phase);
        Assert.Equal(0, r.Requests);
        // вручную проверить всё равно можно
        Assert.NotNull(await r.Model.CheckAsync());
    }

    [Fact]
    public async Task MeteredConnectionPostponesBackgroundDownloadOnly()
    {
        var r = Make(metered: true);
        await r.Model.RunScheduledAsync();
        Assert.Equal(UpdatePhase.Available, r.Model.Phase);
        Assert.Equal(0, r.Downloader.Calls);
        Assert.True(await r.Model.DownloadAsync()); // по просьбе пользователя — можно
    }

    [Fact]
    public async Task FailedAutomaticAttemptWaitsAnHourBeforeRetry()
    {
        var r = Make();
        r.Downloader.Fail = new HttpFailure("сбой", null, transient: true);
        await r.Model.RunScheduledAsync();
        Assert.Equal(UpdatePhase.Failed, r.Model.Phase);
        Assert.Equal(1, r.Downloader.Calls);
        await r.Model.RunScheduledAsync();
        Assert.Equal(1, r.Downloader.Calls); // ещё рано
        _now += UpdateModel.RetryAfterFailure + TimeSpan.FromMinutes(1);
        r.Downloader.Fail = null;
        await r.Model.RunScheduledAsync();
        Assert.Equal(UpdatePhase.Ready, r.Model.Phase);
    }

    [Fact]
    public async Task NewerReleaseReplacesAlreadyDownloadedOne()
    {
        var current = "v1.3.0";
        var r = Make(release: () => ReleaseJson(current));
        await r.Model.CheckAsync();
        await r.Model.DownloadAsync();
        var old = r.Model.Staged!.InstallerPath;
        current = "v1.4.0";
        await r.Model.CheckAsync();
        Assert.Equal(UpdatePhase.Available, r.Model.Phase);
        Assert.Null(r.Model.Staged);
        Assert.False(File.Exists(old));
    }

    [Fact]
    public async Task DiscardRemovesDownloadedUpdate()
    {
        var r = Make();
        await r.Model.CheckAsync();
        await r.Model.DownloadAsync();
        var path = r.Model.Staged!.InstallerPath;
        r.Model.Discard();
        Assert.False(File.Exists(path));
        Assert.Equal(UpdatePhase.Available, r.Model.Phase);
        Assert.False(r.Model.ReadyToInstall);
    }
}

public sealed class WhatsNewTests : IDisposable
{
    private readonly Sandbox _box = new();

    public void Dispose() => _box.Dispose();

    [Theory]
    [InlineData(null, "1.0.0", false, WhatsNewDecision.RecordOnly)]
    [InlineData(null, "1.0.0", true, WhatsNewDecision.Show)]
    [InlineData("1.0.0", "1.1.0", false, WhatsNewDecision.Show)]
    [InlineData("1.1.0", "1.1.0", true, WhatsNewDecision.None)]
    [InlineData("1.2.0", "1.1.0", true, WhatsNewDecision.RecordOnly)]
    [InlineData("мусор", "1.1.0", false, WhatsNewDecision.RecordOnly)]
    [InlineData("1.0.9", "1.0.10", false, WhatsNewDecision.Show)]
    public void Policy(string? seen, string current, bool existing, WhatsNewDecision expected) =>
        Assert.Equal(expected, WhatsNewPolicy.Decide(seen, AppVersion.Parse(current)!, existing));

    [Fact]
    public void FreshInstallRecordsVersionSilentlyAndNeverShows()
    {
        var env = _box.Env();
        Assert.Null(WhatsNewModel.Create(env, AppVersion.Parse("1.3.0")!, hasExistingData: false));
        Assert.Equal("1.3.0", env.Device.LastSeenVersion);
        Assert.Null(WhatsNewModel.Create(env, AppVersion.Parse("1.3.0")!, hasExistingData: false));
    }

    [Fact]
    public async Task ShownOncePerVersionWithNotesFromInstalledRecord()
    {
        var env = _box.Env();
        env.Device.LastSeenVersion = "1.2.0";
        var stage = new UpdateStage(Path.Combine(env.Root, "updates"));
        stage.SaveInstalledNotes(new StagedUpdate("1.3.0", "Customers 1.3.0", "## Новое\n- **быстрее** запуск\n- меньше памяти", null, "", "", 0, DateTimeOffset.Now));
        var model = WhatsNewModel.Create(env, AppVersion.Parse("1.3.0")!, true)!;
        Assert.Equal("Что нового в версии 1.3.0?", model.Title);
        await model.LoadAsync();
        Assert.False(model.Unavailable);
        Assert.Equal(["Новое", "быстрее запуск", "меньше памяти"], model.Lines.Select(l => l.Text).ToArray());
        model.Dismiss();
        Assert.Equal("1.3.0", env.Device.LastSeenVersion);
        Assert.Null(WhatsNewModel.Create(env, AppVersion.Parse("1.3.0")!, true));
        Assert.Null(stage.LoadInstalledNotes(AppVersion.Parse("1.3.0")!));
        Assert.NotNull(WhatsNewModel.Create(env, AppVersion.Parse("1.4.0")!, true));
    }

    [Fact]
    public async Task WithoutSavedNotesUsesReleaseHistoryAndFallsBackWhenOffline()
    {
        var env = _box.Env(search: () => new MockSearchTransport(r => new HttpResult(200,
            Encoding.UTF8.GetBytes("""{"tag_name":"v1.3.0","body":"* из истории релизов","draft":false,"prerelease":false,"assets":[]}"""), new Dictionary<string, string>(), r.Url)));
        env.Device.LastSeenVersion = "1.0.0";
        var model = WhatsNewModel.Create(env, AppVersion.Parse("1.3.0")!, true)!;
        await model.LoadAsync();
        Assert.Equal("из истории релизов", Assert.Single(model.Lines).Text);

        var failing = _box.Env(search: () => new MockSearchTransport(r => new HttpResult(500, [], new Dictionary<string, string>(), r.Url)));
        failing.Device.LastSeenVersion = "1.0.0";
        var offline = WhatsNewModel.Create(failing, AppVersion.Parse("1.3.0")!, true)!;
        await offline.LoadAsync();
        Assert.True(offline.Unavailable);
        Assert.False(offline.Loading);
        Assert.EndsWith("/releases/tag/v1.3.0", offline.ReleasesPage.AbsoluteUri, StringComparison.Ordinal);
    }

    [Fact]
    public void PreferencesPersist()
    {
        var path = Path.Combine(_box.Root, "device.json");
        var a = new DevicePreferences(path) {
            BackgroundDownload = false,
            UpdateCheckHours = 168,
            LastSeenVersion = "1.2.3",
            LastUpdateCheck = DateTimeOffset.Parse("2026-11-08T10:00:00+00:00"),
        };
        a.Save();
        var b = new DevicePreferences(path);
        Assert.False(b.BackgroundDownload);
        Assert.Equal(168, b.UpdateCheckHours);
        Assert.Equal("1.2.3", b.LastSeenVersion);
        Assert.Equal(DateTimeOffset.Parse("2026-11-08T10:00:00+00:00"), b.LastUpdateCheck);
        var fresh = new DevicePreferences(Path.Combine(_box.Root, "none.json"));
        Assert.True(fresh.BackgroundDownload);
        Assert.Equal(24, fresh.UpdateCheckHours);
        Assert.Null(fresh.LastSeenVersion);
    }
}
