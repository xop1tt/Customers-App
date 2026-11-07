using System.Text.Json.Nodes;

namespace Customers.Presentation.Tests;

/// <summary>«Удалить все лиды»: без успешной проверки пароля данные не трогаются.</summary>
public sealed class DeleteAllLeadsTests : IDisposable
{
    private readonly Sandbox _box = new();

    public void Dispose() => _box.Dispose();

    private async Task<SessionModel> LocalWithLeadsAsync()
    {
        var s = new SessionModel(_box.Env());
        await s.RegisterAsync("maksim", "Хороший-пароль-1", "Хороший-пароль-1", remember: false);
        Data.Seed(s.Current!);
        Assert.Equal(4, s.Current!.AllLeads.Count);
        return s;
    }

    [Fact]
    public async Task LocalWrongPasswordDeletesNothing()
    {
        var s = await LocalWithLeadsAsync();
        var backups = s.Current!.BackupFiles.Count;
        var problem = await s.DeleteAllLeadsAsync("не тот пароль");
        Assert.NotNull(problem);
        Assert.Contains("Неверный пароль", problem);
        Assert.Equal(4, s.Current!.AllLeads.Count);
        Assert.Equal(backups, s.Current.BackupFiles.Count); // без пароля даже копия не создаётся
        s.Current.Shutdown();
    }

    [Fact]
    public async Task EmptyPasswordDeletesNothing()
    {
        var s = await LocalWithLeadsAsync();
        Assert.NotNull(await s.DeleteAllLeadsAsync(""));
        Assert.Equal(4, s.Current!.AllLeads.Count);
        s.Current.Shutdown();
    }

    [Fact]
    public async Task LocalRightPasswordBacksUpThenDeletes()
    {
        var s = await LocalWithLeadsAsync();
        var backups = s.Current!.BackupFiles.Count;
        Assert.Null(await s.DeleteAllLeadsAsync("Хороший-пароль-1"));
        Assert.Empty(s.Current!.AllLeads);
        Assert.True(s.Current.BackupFiles.Count >= Math.Max(1, backups)); // копия есть (имя по времени: в ту же секунду она заменяет дневную)
        s.Current.Shutdown();
    }

    [Fact]
    public async Task RepeatedWrongPasswordsAreThrottled()
    {
        var s = await LocalWithLeadsAsync();
        for (var i = 0; i < 5; i++)
        {
            Assert.NotNull(await s.DeleteAllLeadsAsync("нет"));
        }

        Assert.NotNull(await s.DeleteAllLeadsAsync("Хороший-пароль-1")); // правильный пароль тоже ждёт паузу
        Assert.Equal(4, s.Current!.AllLeads.Count);
        s.Current.Shutdown();
    }

    [Fact]
    public async Task NotSignedInReturnsMessage()
    {
        var s = new SessionModel(_box.Env());
        Assert.NotNull(await s.DeleteAllLeadsAsync("x"));
    }

    private static (int, string) Gate(string path, bool good) => path.EndsWith("/auth/v1/token", StringComparison.Ordinal)
        ? good ? (200, Data.Token()) : (400, new JsonObject { ["error_code"] = "invalid_credentials", ["msg"] = "x" }.ToJsonString())
        : path.StartsWith("/rest/v1/", StringComparison.Ordinal) ? (200, path.Contains("rpc") ? "{}" : "[]") : (404, "{}");

    [Fact]
    public async Task CloudChecksPasswordOnServer()
    {
        var good = true;
        var cloud = new MockCloud((req, _) => Gate(req.RequestUri!.AbsolutePath, good));
        var s = new SessionModel(_box.Env(Data.Config, cloud));
        await s.CloudSignInAsync("u@example.com", "Хороший-пароль-1");
        Assert.True(s.IsCloudSession);
        s.Sync?.Dispose();
        Data.Seed(s.Current!);

        good = false;
        Assert.Contains("Неверный пароль", await s.DeleteAllLeadsAsync("не тот"));
        Assert.Equal(4, s.Current!.AllLeads.Count);

        good = true;
        Assert.Null(await s.DeleteAllLeadsAsync("Хороший-пароль-1"));
        Assert.Empty(s.Current.AllLeads);
        Assert.True(s.IsCloudSession); // сессия не потеряна
        s.Current.Shutdown();
    }

    [Fact]
    public async Task CloudOfflineDoesNotDelete()
    {
        var online = true;
        var cloud = new MockCloud((req, _) => online ? Gate(req.RequestUri!.AbsolutePath, true) : throw new CloudException(CloudErrorKind.Network, "нет сети"));
        var s = new SessionModel(_box.Env(Data.Config, cloud));
        await s.CloudSignInAsync("u@example.com", "Хороший-пароль-1");
        s.Sync?.Dispose();
        Data.Seed(s.Current!);
        online = false;
        var problem = await s.DeleteAllLeadsAsync("Хороший-пароль-1");
        Assert.NotNull(problem);
        Assert.Contains("не удалены", problem);
        Assert.Equal(4, s.Current!.AllLeads.Count);
        s.Current.Shutdown();
    }
}

public sealed class UpdateScheduleAndDefaultsTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-11-07T12:00:00Z");

    [Fact]
    public void DueRules()
    {
        Assert.False(UpdateSchedule.IsDue(false, 0, null, Now)); // автопроверка выключена
        Assert.True(UpdateSchedule.IsDue(true, 24, null, Now)); // ещё не проверяли
        Assert.True(UpdateSchedule.IsDue(true, 0, Now, Now)); // при каждом запуске
        Assert.False(UpdateSchedule.IsDue(true, 24, Now.AddHours(-23), Now));
        Assert.True(UpdateSchedule.IsDue(true, 24, Now.AddHours(-24), Now));
        Assert.False(UpdateSchedule.IsDue(true, 168, Now.AddDays(-6), Now));
        Assert.True(UpdateSchedule.IsDue(true, 168, Now.AddDays(-7), Now));
        Assert.True(UpdateSchedule.IsDue(true, 720, Now.AddDays(-30), Now));
        Assert.True(UpdateSchedule.IsDue(true, 24, Now.AddDays(1), Now)); // часы переведены назад: не ждём вечно
    }

    [Fact]
    public void ChoicesAreValidAndNormalized()
    {
        Assert.Equal([0, 24, 168, 720], UpdateSchedule.Choices.Select(c => c.Hours));
        Assert.Equal(UpdateSchedule.Choices.Count, UpdateSchedule.Choices.Select(c => c.Title).Distinct().Count());
        Assert.Equal(168, UpdateSchedule.Normalize(168));
        Assert.Equal(UpdateSchedule.DefaultHours, UpdateSchedule.Normalize(5));
        Assert.Equal(UpdateSchedule.DefaultHours, UpdateSchedule.Normalize(-1));
    }

    [Fact]
    public void FrequencyAndLastCheckPersist()
    {
        var path = Path.Combine(Path.GetTempPath(), "customers-dev-" + Guid.NewGuid().ToString("N") + ".json");
        try
        {
            var p = new DevicePreferences(path) { UpdateCheckHours = 168, LastUpdateCheck = Now };
            Assert.Equal(24, new DevicePreferences(Path.Combine(Path.GetTempPath(), "none-" + Guid.NewGuid().ToString("N") + ".json")).UpdateCheckHours);
            var again = new DevicePreferences(path);
            Assert.Equal(168, again.UpdateCheckHours);
            Assert.Equal(Now, again.LastUpdateCheck);
            p.UpdateCheckHours = 7; // неизвестное значение сводится к варианту по умолчанию
            Assert.Equal(24, p.UpdateCheckHours);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void CallConfirmationIsOnByDefaultAndOldOffIsMigrated()
    {
        var dir = Path.Combine(Path.GetTempPath(), "customers-acc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var path = Path.Combine(dir, "prefs.json");
            Assert.True(new AccountPreferences(path, "B").ConfirmCalls);

            // Файл старого формата: «выключено» записано автоматически, без версии — это не выбор пользователя.
            File.WriteAllText(path, """{"autoSearchMinutes":30,"confirmCalls":false}""");
            Assert.True(new AccountPreferences(path, "B").ConfirmCalls);

            // Теперь пользователь выключает осознанно — выбор сохраняется.
            var prefs = new AccountPreferences(path, "B") { ConfirmCalls = false };
            Assert.False(new AccountPreferences(path, "B").ConfirmCalls);
            prefs.ConfirmCalls = true;
            Assert.True(new AccountPreferences(path, "B").ConfirmCalls);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
