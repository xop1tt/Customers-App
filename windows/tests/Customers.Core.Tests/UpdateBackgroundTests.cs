using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace Customers.Core.Tests;

public class ReleaseNotesTextTests
{
    [Fact]
    public void RemovesMarkdownMarkers()
    {
        var text = ReleaseNotesText.Plain("## Что нового\n\n**Жирный** и *курсив*, `код`, ~~старое~~ и [ссылка](https://example.com/x).\n\n- первый пункт\n- второй **пункт**\n\n1. шаг один\n2. шаг два");
        Assert.DoesNotContain("**", text, StringComparison.Ordinal);
        Assert.DoesNotContain("##", text, StringComparison.Ordinal);
        Assert.DoesNotContain("`", text, StringComparison.Ordinal);
        Assert.DoesNotContain("](", text, StringComparison.Ordinal);
        Assert.Contains("Жирный и курсив, код, старое и ссылка.", text, StringComparison.Ordinal);
        Assert.Contains("• первый пункт\n• второй пункт", text, StringComparison.Ordinal);
        Assert.Contains("1. шаг один\n2. шаг два", text, StringComparison.Ordinal);
    }

    [Fact]
    public void ParsesKindsAndKeepsOrder()
    {
        var lines = ReleaseNotesText.Parse("# Заголовок\nАбзац из\nдвух строк\n* пункт\n---\n> цитата");
        Assert.Equal([NoteKind.Heading, NoteKind.Paragraph, NoteKind.Bullet, NoteKind.Paragraph], lines.Select(l => l.Kind).ToArray());
        Assert.Equal("Абзац из двух строк", lines[1].Text);
        Assert.Equal("цитата", lines[3].Text);
    }

    [Fact]
    public void HandlesCrLfFencesHtmlAndImages()
    {
        var text = ReleaseNotesText.Plain("Начало\r\n\r\n```\nkod()\n```\r\n<b>тег</b> ![картинка](a.png) <!-- скрыто -->\r\n<https://example.com>");
        Assert.Contains("kod()", text, StringComparison.Ordinal);
        Assert.DoesNotContain("<", text, StringComparison.Ordinal);
        Assert.DoesNotContain("```", text, StringComparison.Ordinal);
        Assert.Contains("тег картинка", text, StringComparison.Ordinal);
        Assert.Contains("https://example.com", text, StringComparison.Ordinal);
        Assert.DoesNotContain("\r", text, StringComparison.Ordinal);
    }

    [Fact]
    public void KeepsSnakeCaseAndPlainTextAndEmptyInput()
    {
        Assert.Equal("поле user_name и 2 * 3 = 6", ReleaseNotesText.Plain("поле user_name и 2 * 3 = 6"));
        Assert.Equal("", ReleaseNotesText.Plain(null));
        Assert.Equal("", ReleaseNotesText.Plain("  \n\n---\n"));
    }
}

public sealed class UpdateStageTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private (UpdateStage Stage, StagedUpdate Staged) Staged(string version = "1.2.0", string content = "installer")
    {
        var stage = new UpdateStage(_dir.File("updates"));
        Directory.CreateDirectory(stage.Directory);
        var path = stage.FinalPath("Setup.exe");
        File.WriteAllText(path, content);
        var sha = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(content)));
        var staged = new StagedUpdate(version, "Customers " + version, "Заметки", "https://example.com/r", path, sha, new FileInfo(path).Length, DateTimeOffset.Now);
        stage.Save(staged);
        return (stage, staged);
    }

    [Fact]
    public void LoadReturnsSavedRecordForNewerVersion()
    {
        var (stage, staged) = Staged();
        var loaded = stage.Load(AppVersion.Parse("1.1.0")!)!;
        Assert.Equal(staged.Version, loaded.Version);
        Assert.Equal(staged.InstallerPath, loaded.InstallerPath);
        Assert.Equal("Заметки", loaded.Notes);
        Assert.True(UpdateStage.VerifyFile(loaded));
    }

    [Fact]
    public void LoadDropsStaleAndBrokenRecords()
    {
        var (stage, staged) = Staged("1.2.0");
        Assert.Null(stage.Load(AppVersion.Parse("1.2.0")!)); // уже установлена
        Assert.False(File.Exists(staged.InstallerPath));

        var (stage2, staged2) = Staged();
        File.AppendAllText(staged2.InstallerPath, "x"); // размер изменился
        Assert.Null(stage2.Load(AppVersion.Parse("1.0.0")!));
        Assert.False(File.Exists(staged2.InstallerPath));

        var (stage3, _) = Staged();
        File.WriteAllText(Path.Combine(stage3.Directory, "staged.json"), "не json");
        Assert.Null(stage3.Load(AppVersion.Parse("1.0.0")!));
    }

    [Fact]
    public void LoadRefusesInstallerOutsideStageFolder()
    {
        var (stage, staged) = Staged();
        var outside = _dir.File("elsewhere.exe");
        File.WriteAllText(outside, "installer");
        stage.Save(staged with { InstallerPath = outside });
        Assert.Null(stage.Load(AppVersion.Parse("1.0.0")!));
        Assert.True(File.Exists(outside));
    }

    [Fact]
    public void VerifyFileDetectsTampering()
    {
        var (_, staged) = Staged();
        File.WriteAllText(staged.InstallerPath, "INSTALLER"); // тот же размер, другое содержимое
        Assert.False(UpdateStage.VerifyFile(staged));
        File.Delete(staged.InstallerPath);
        Assert.False(UpdateStage.VerifyFile(staged));
    }

    [Fact]
    public void InstalledNotesSurviveClearAndMatchOnlyTheirVersion()
    {
        var (stage, staged) = Staged();
        stage.SaveInstalledNotes(staged);
        stage.Clear();
        Assert.False(File.Exists(staged.InstallerPath));
        Assert.Equal("Заметки", stage.LoadInstalledNotes(AppVersion.Parse("1.2.0")!)!.Notes);
        Assert.Null(stage.LoadInstalledNotes(AppVersion.Parse("1.3.0")!));
        stage.ClearInstalledNotes();
        Assert.Null(stage.LoadInstalledNotes(AppVersion.Parse("1.2.0")!));
    }
}

public sealed class UpdateStagingTests : IDisposable
{
    private readonly TempDir _dir = new();
    private static readonly byte[] Payload = Encoding.UTF8.GetBytes(new string('я', 5000));

    public void Dispose() => _dir.Dispose();

    private static string Hash(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));

    private static UpdateOffer Offer(byte[] payload, long? size = null, string? sha = null, bool withDigest = true)
    {
        var tag = "v1.2.0";
        var digest = withDigest ? $"\"digest\":\"sha256:{sha ?? Hash(payload)}\"," : "";
        var json = $$"""
            {"tag_name":"{{tag}}","name":"Customers 1.2.0","body":"**Новое**","html_url":"https://github.com/x/y/releases/tag/v1.2.0","draft":false,"prerelease":false,
             "assets":[{"name":"Customers-v1.2.0-Windows-x64-Setup.exe",{{digest}}"size":{{size ?? payload.Length}},"browser_download_url":"https://example.com/setup.exe"}]}
            """;
        var release = ReleaseInfo.Parse(Encoding.UTF8.GetBytes(json))!;
        return new UpdateOffer(AppVersion.Parse(tag)!, release, release.WindowsInstaller!);
    }

    private sealed class FakeDownloader(byte[] data, Action<string>? before = null) : IFileDownloader
    {
        public int Calls { get; private set; }

        public async Task<long> DownloadAsync(Uri url, string destination, IProgress<DownloadProgress>? progress, CancellationToken ct)
        {
            Calls++;
            before?.Invoke(destination);
            await File.WriteAllBytesAsync(destination, data, ct);
            progress?.Report(new DownloadProgress(data.Length, data.Length));
            return data.Length;
        }
    }

    private static UpdateChecker Checker() => new(new MockTransport(r => MockTransport.Status(404, r.Url)));

    [Fact]
    public async Task StagesVerifiedInstallerAndWritesRecord()
    {
        var stage = new UpdateStage(_dir.File("u"));
        var offer = Offer(Payload);
        var staged = await Checker().StageAsync(offer, stage, new FakeDownloader(Payload), _ => long.MaxValue);
        Assert.Equal("1.2.0", staged.Version);
        Assert.Equal(Hash(Payload), staged.Sha256);
        Assert.Equal(Payload, await File.ReadAllBytesAsync(staged.InstallerPath));
        Assert.Equal("**Новое**", staged.Notes);
        Assert.False(File.Exists(stage.PartialPath(offer.Installer.Name)));
        Assert.Equal(staged.InstallerPath, stage.Load(AppVersion.Parse("1.0.0")!)!.InstallerPath);
    }

    [Fact]
    public async Task NotEnoughDiskSpaceStopsBeforeDownload()
    {
        var stage = new UpdateStage(_dir.File("u"));
        var downloader = new FakeDownloader(Payload);
        var e = await Assert.ThrowsAsync<InsufficientSpaceException>(() => Checker().StageAsync(Offer(Payload), stage, downloader, _ => 1024));
        Assert.Equal(0, downloader.Calls);
        Assert.Contains("Недостаточно места", e.Message, StringComparison.Ordinal);
        Assert.True(e.Required > e.Available);
        Assert.Null(stage.Load(AppVersion.Parse("1.0.0")!));
    }

    [Fact]
    public async Task DiskFullDuringWriteIsReportedAsSpaceProblemAndCleansUp()
    {
        var stage = new UpdateStage(_dir.File("u"));
        var downloader = new ThrowingDownloader(new IOException("На диске не хватает места", unchecked((int)0x80070070)));
        await Assert.ThrowsAsync<InsufficientSpaceException>(() => Checker().StageAsync(Offer(Payload), stage, downloader, _ => long.MaxValue));
        Assert.False(File.Exists(stage.PartialPath("Customers-v1.2.0-Windows-x64-Setup.exe")));
    }

    private sealed class ThrowingDownloader(Exception error) : IFileDownloader
    {
        public Task<long> DownloadAsync(Uri url, string destination, IProgress<DownloadProgress>? progress, CancellationToken ct)
        {
            File.WriteAllText(destination, "частично");
            throw error;
        }
    }

    [Fact]
    public async Task WrongChecksumRemovesDownloadAndKeepsPreviousState()
    {
        var stage = new UpdateStage(_dir.File("u"));
        var offer = Offer(Payload, sha: new string('0', 64));
        var e = await Assert.ThrowsAsync<HttpFailure>(() => Checker().StageAsync(offer, stage, new FakeDownloader(Payload), _ => long.MaxValue));
        Assert.Contains("контрольная сумма", e.Message, StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateFiles(stage.Directory));
    }

    [Fact]
    public async Task WrongSizeAndMissingChecksumAreRefused()
    {
        var stage = new UpdateStage(_dir.File("u"));
        var e = await Assert.ThrowsAsync<HttpFailure>(() => Checker().StageAsync(Offer(Payload, size: Payload.Length + 5), stage, new FakeDownloader(Payload), _ => long.MaxValue));
        Assert.Contains("размер", e.Message, StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateFiles(stage.Directory));
        var e2 = await Assert.ThrowsAsync<HttpFailure>(() => Checker().StageAsync(Offer(Payload, withDigest: false), stage, new FakeDownloader(Payload), _ => long.MaxValue));
        Assert.Contains("SHA-256", e2.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReusesPartialFileSpaceInCheck()
    {
        var stage = new UpdateStage(_dir.File("u"));
        var offer = Offer(Payload);
        var needed = UpdateChecker.RequiredSpace(offer);
        var staged = await Checker().StageAsync(offer, stage, new FakeDownloader(Payload), _ => needed);
        Assert.NotNull(staged);
        await Assert.ThrowsAsync<InsufficientSpaceException>(() => Checker().StageAsync(offer, stage, new FakeDownloader(Payload), _ => needed - 1));
    }

    [Fact]
    public async Task FetchReleaseByTagFallsBackToPlainTagAndHandlesMissing()
    {
        var calls = new List<string>();
        var transport = new MockTransport(r =>
        {
            calls.Add(r.Url.AbsolutePath);
            return r.Url.AbsolutePath.EndsWith("/v1.2.0", StringComparison.Ordinal)
                ? MockTransport.Status(404, r.Url)
                : MockTransport.Ok("""{"tag_name":"1.2.0","body":"Текст","draft":false,"prerelease":false,"assets":[]}""", r.Url);
        });
        var release = await new UpdateChecker(transport).FetchReleaseAsync(AppVersion.Parse("1.2.0")!);
        Assert.Equal("Текст", release!.Body);
        Assert.Equal(2, calls.Count);

        var none = new MockTransport(r => MockTransport.Status(404, r.Url));
        Assert.Null(await new UpdateChecker(none).FetchReleaseAsync(AppVersion.Parse("9.9")!));
        var broken = new MockTransport(r => MockTransport.Status(500, r.Url));
        await Assert.ThrowsAsync<HttpFailure>(() => new UpdateChecker(broken).FetchReleaseAsync(AppVersion.Parse("1.2.0")!));
    }
}

public sealed class HttpFileDownloaderTests : IDisposable
{
    private readonly TempDir _dir = new();
    private static readonly byte[] Data = Enumerable.Range(0, 300_000).Select(i => (byte)(i % 251)).ToArray();

    public void Dispose() => _dir.Dispose();

    private sealed class Handler(Func<HttpRequestMessage, int, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public List<string?> Ranges { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Ranges.Add(request.Headers.Range?.ToString());
            return Task.FromResult(respond(request, Ranges.Count));
        }
    }

    /// <summary>Поток, который обрывается на середине.</summary>
    private sealed class BreakingContent(byte[] data, int cut) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => stream.WriteAsync(data.AsMemory(0, cut)).AsTask();

        protected override bool TryComputeLength(out long length)
        {
            length = data.Length;
            return true;
        }

        protected override Task<Stream> CreateContentReadStreamAsync() => Task.FromResult<Stream>(new BreakStream(data, cut));
    }

    private sealed class BreakStream(byte[] data, int cut) : MemoryStream(data, 0, cut)
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var read = await base.ReadAsync(buffer, cancellationToken);
            if (read == 0)
            {
                throw new HttpRequestException("соединение разорвано");
            }

            return read;
        }
    }

    private static HttpResponseMessage Ok(byte[] data) => new(HttpStatusCode.OK) { Content = new ByteArrayContent(data) };

    [Fact]
    public async Task DownloadsWholeFileWithProgress()
    {
        using var d = new HttpFileDownloader(new Handler((_, _) => Ok(Data)), attempts: 1);
        var reports = new List<DownloadProgress>();
        var size = await d.DownloadAsync(new Uri("https://example.com/a.exe"), _dir.File("a.exe"), new Progress<DownloadProgress>(reports.Add), CancellationToken.None);
        Assert.Equal(Data.Length, size);
        Assert.Equal(Data, await File.ReadAllBytesAsync(_dir.File("a.exe")));
        await Task.Delay(100);
        Assert.Contains(reports, r => r.Total == Data.Length);
    }

    [Fact]
    public async Task ResumesAfterConnectionBreak()
    {
        var handler = new Handler((req, n) =>
        {
            if (n == 1)
            {
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new BreakingContent(Data, 100_000) };
            }

            var from = (int)req.Headers.Range!.Ranges.First().From!.Value;
            var resp = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(Data[from..]) };
            resp.Content.Headers.ContentRange = new System.Net.Http.Headers.ContentRangeHeaderValue(from, Data.Length - 1, Data.Length);
            return resp;
        });
        using var d = new HttpFileDownloader(handler, attempts: 3, retryDelay: TimeSpan.FromMilliseconds(1));
        await d.DownloadAsync(new Uri("https://example.com/a.exe"), _dir.File("a.exe"), null, CancellationToken.None);
        Assert.Equal(Data, await File.ReadAllBytesAsync(_dir.File("a.exe")));
        Assert.Null(handler.Ranges[0]);
        Assert.StartsWith("bytes=", handler.Ranges[1], StringComparison.Ordinal);
    }

    [Fact]
    public async Task GivesUpAfterRepeatedBreaksAndNeverReportsTruncatedFileAsDone()
    {
        var handler = new Handler((_, _) => new HttpResponseMessage(HttpStatusCode.OK) { Content = new BreakingContent(Data, 50_000) });
        using var d = new HttpFileDownloader(handler, attempts: 2, retryDelay: TimeSpan.FromMilliseconds(1));
        var e = await Assert.ThrowsAsync<HttpFailure>(() => d.DownloadAsync(new Uri("https://example.com/a.exe"), _dir.File("a.exe"), null, CancellationToken.None));
        Assert.True(e.Transient);
    }

    [Fact]
    public async Task ServerErrorsAreRetriedButNotFoundIsNot()
    {
        var calls = 0;
        using var flaky = new HttpFileDownloader(new Handler((_, n) =>
        {
            calls = n;
            return n < 3 ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) : Ok(Data);
        }), attempts: 4, retryDelay: TimeSpan.FromMilliseconds(1));
        await flaky.DownloadAsync(new Uri("https://example.com/a.exe"), _dir.File("a.exe"), null, CancellationToken.None);
        Assert.Equal(3, calls);

        var missing = 0;
        using var gone = new HttpFileDownloader(new Handler((_, n) =>
        {
            missing = n;
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }), attempts: 4, retryDelay: TimeSpan.FromMilliseconds(1));
        var e = await Assert.ThrowsAsync<HttpFailure>(() => gone.DownloadAsync(new Uri("https://example.com/b.exe"), _dir.File("b.exe"), null, CancellationToken.None));
        Assert.Equal(404, e.Status);
        Assert.Equal(1, missing);
    }

    [Fact]
    public async Task RedirectToLocalAddressIsRefusedAndPublicRedirectFollowed()
    {
        var local = new HttpResponseMessage(HttpStatusCode.Found);
        local.Headers.Location = new Uri("http://127.0.0.1/secret");
        using var bad = new HttpFileDownloader(new Handler((_, _) => local), attempts: 1);
        var e = await Assert.ThrowsAsync<HttpFailure>(() => bad.DownloadAsync(new Uri("https://example.com/a.exe"), _dir.File("a.exe"), null, CancellationToken.None));
        Assert.Contains("перенаправление", e.Message, StringComparison.Ordinal);

        using var good = new HttpFileDownloader(new Handler((req, _) =>
        {
            if (req.RequestUri!.Host == "example.com")
            {
                var r = new HttpResponseMessage(HttpStatusCode.Found);
                r.Headers.Location = new Uri("https://objects.example.org/file");
                return r;
            }

            return Ok(Data);
        }), attempts: 1);
        Assert.Equal(Data.Length, await good.DownloadAsync(new Uri("https://example.com/a.exe"), _dir.File("c.exe"), null, CancellationToken.None));
    }

    [Fact]
    public async Task CancellationStopsWithoutRetry()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        using var d = new HttpFileDownloader(new Handler((_, _) => Ok(Data)), attempts: 3);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => d.DownloadAsync(new Uri("https://example.com/a.exe"), _dir.File("a.exe"), null, cts.Token));
    }
}
