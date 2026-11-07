using System.Security.Cryptography;

namespace Customers.Core;

public sealed partial class UpdateChecker
{
    /// <summary>Запас свободного места сверх размера установщика: на распаковку и журналы установщика.</summary>
    public const long SpaceMargin = 200L * 1024 * 1024;

    /// <summary>Размер установщика, если GitHub его не сообщил (обычно около 100 МБ).</summary>
    public const long AssumedInstallerSize = 150L * 1024 * 1024;

    /// <summary>Нужно места на диске для скачивания: размер установщика с запасом.</summary>
    public static long RequiredSpace(UpdateOffer offer) => (offer.Installer.Size ?? AssumedInstallerSize) + SpaceMargin;

    /// <summary>
    /// Скачивает установщик в папку обновлений и проверяет его, не трогая установленную копию:
    /// место на диске, потоковая запись с докачкой, SHA-256, размер. Результат записывается в <paramref name="stage"/>.
    /// При любой ошибке остаётся прежнее состояние, а недокачанный файл удаляется, если он испорчен.
    /// </summary>
    public async Task<StagedUpdate> StageAsync(UpdateOffer offer, UpdateStage stage, IFileDownloader downloader, Func<string, long> freeSpace,
        IProgress<DownloadProgress>? progress = null, CancellationToken ct = default)
    {
        var expected = await ExpectedHashAsync(offer, ct).ConfigureAwait(false)
            ?? throw new HttpFailure("у релиза нет контрольной суммы SHA-256 — обновление отменено");
        Directory.CreateDirectory(stage.Directory);
        var partial = stage.PartialPath(offer.Installer.Name);
        var already = File.Exists(partial) ? new FileInfo(partial).Length : 0;
        var required = RequiredSpace(offer) - already;
        var free = freeSpace(stage.Directory);
        if (free < required)
        {
            throw new InsufficientSpaceException(required, free);
        }

        long size;
        try
        {
            size = await downloader.DownloadAsync(offer.Installer.DownloadUrl, partial, progress, ct).ConfigureAwait(false);
        }
        catch (IOException e) when (HttpFileDownloader.IsDiskFull(e))
        {
            TryDelete(partial);
            throw new InsufficientSpaceException(required, freeSpace(stage.Directory));
        }

        if (offer.Installer.Size is { } announced && announced != size)
        {
            TryDelete(partial);
            throw new HttpFailure($"размер файла не совпал с релизом ({size} вместо {announced} байт) — обновление отменено");
        }

        string actual;
        await using (var stream = File.OpenRead(partial))
        {
            actual = Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, ct).ConfigureAwait(false));
        }

        if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
        {
            TryDelete(partial);
            throw new HttpFailure("контрольная сумма установщика не совпала — обновление отменено");
        }

        var final = stage.FinalPath(offer.Installer.Name);
        File.Move(partial, final, overwrite: true);
        var staged = new StagedUpdate(offer.Version.ToString(), offer.Release.Name ?? $"Customers {offer.Version}", offer.Release.Body ?? "",
            offer.Release.HtmlUrl?.AbsoluteUri, final, actual, size, DateTimeOffset.Now);
        stage.Save(staged);
        return staged;
    }

    /// <summary>Описание релиза по тегу — для экрана «Что нового», если записи об обновлении нет (обновились вручную). Нет сети — null.</summary>
    public async Task<ReleaseInfo?> FetchReleaseAsync(AppVersion version, CancellationToken ct = default)
    {
        foreach (var tag in new[] { "v" + version, version.ToString() })
        {
            var req = new HttpRequestSpec { Url = new Uri($"https://api.github.com/repos/{repository}/releases/tags/{tag}") };
            req.Headers["Accept"] = "application/vnd.github+json";
            req.Headers["User-Agent"] = SourceHttp.UserAgent;
            var resp = await transport.SendAsync(req, ct).ConfigureAwait(false);
            if (resp.Status == 404)
            {
                continue;
            }

            if (resp.Status >= 400)
            {
                throw new HttpFailure($"GitHub ответил HTTP {resp.Status}", resp.Status);
            }

            if (ReleaseInfo.Parse(resp.Data) is { Draft: false } release)
            {
                return release;
            }
        }

        return null;
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}
