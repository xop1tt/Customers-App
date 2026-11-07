using System.Net;
using System.Net.Http.Headers;

namespace Customers.Core;

/// <summary>Сколько уже скачано и сколько всего (если сервер сообщил размер).</summary>
public readonly record struct DownloadProgress(long Received, long? Total)
{
    public double? Fraction => Total is > 0 ? Math.Min(1.0, (double)Received / Total.Value) : null;
}

/// <summary>Скачивание большого файла на диск без загрузки его целиком в память.</summary>
public interface IFileDownloader
{
    /// <summary>Скачивает адрес в <paramref name="destination"/>. Если файл уже частично скачан, докачивает. Возвращает размер файла.</summary>
    Task<long> DownloadAsync(Uri url, string destination, IProgress<DownloadProgress>? progress, CancellationToken ct);
}

/// <summary>
/// Скачивание через HttpClient: поток пишется прямо в файл, обрыв связи повторяется с докачкой (Range),
/// перенаправления не могут увести на локальные адреса, недокачанный файл не принимается за целый.
/// </summary>
public sealed class HttpFileDownloader : IFileDownloader, IDisposable
{
    private readonly HttpClient _client;
    private readonly int _attempts;
    private readonly TimeSpan _retryDelay;

    public HttpFileDownloader(HttpMessageHandler? handler = null, int attempts = 4, TimeSpan? retryDelay = null)
    {
        _client = new HttpClient(handler ?? new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, PooledConnectionLifetime = TimeSpan.FromMinutes(5) }) {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        _attempts = Math.Max(1, attempts);
        _retryDelay = retryDelay ?? TimeSpan.FromSeconds(3);
    }

    public void Dispose() => _client.Dispose();

    public async Task<long> DownloadAsync(Uri url, string destination, IProgress<DownloadProgress>? progress, CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(destination))!);
        Exception? last = null;
        for (var attempt = 1; attempt <= _attempts; attempt++)
        {
            try
            {
                return await OnceAsync(url, destination, progress, ct).ConfigureAwait(false);
            }
            catch (HttpFailure e) when (e.Transient && attempt < _attempts)
            {
                last = e;
            }
            catch (IOException e) when (attempt < _attempts && !IsDiskFull(e))
            {
                last = e;
            }

            await Task.Delay(_retryDelay * attempt, ct).ConfigureAwait(false);
        }

        throw last ?? new HttpFailure("не удалось скачать файл", null, transient: true);
    }

    /// <summary>Диск заполнен (код ошибки Windows 112 и ENOSPC в Linux): повторять бессмысленно.</summary>
    internal static bool IsDiskFull(IOException e) => (e.HResult & 0xFFFF) is 112 or 39 or 28 || e.Message.Contains("space", StringComparison.OrdinalIgnoreCase);

    private async Task<long> OnceAsync(Uri start, string destination, IProgress<DownloadProgress>? progress, CancellationToken ct)
    {
        var existing = File.Exists(destination) ? new FileInfo(destination).Length : 0;
        var url = start;
        for (var hop = 0; hop < 8; hop++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.TryAddWithoutValidation("User-Agent", SourceHttp.UserAgent);
            if (existing > 0)
            {
                request.Headers.Range = new RangeHeaderValue(existing, null);
            }

            HttpResponseMessage response;
            try
            {
                using var headerTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                headerTimeout.CancelAfter(TimeSpan.FromSeconds(30));
                response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, headerTimeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw new HttpFailure("сервер не отвечает", null, transient: true);
            }
            catch (HttpRequestException e)
            {
                throw new HttpFailure("нет связи с сервером: " + e.Message, null, transient: true);
            }

            using (response)
            {
                var code = (int)response.StatusCode;
                if (code is 301 or 302 or 303 or 307 or 308 && response.Headers.Location is { } loc)
                {
                    var next = loc.IsAbsoluteUri ? loc : new Uri(url, loc);
                    if (!SiteChecker.IsPublicHttpUrl(next.AbsoluteUri))
                    {
                        throw new HttpFailure("перенаправление на нелокальный адрес запрещено", code);
                    }

                    url = next;
                    continue;
                }

                if (code == 416)
                {
                    // Докачивать нечего или файл на сервере другой: начинаем заново.
                    File.Delete(destination);
                    existing = 0;
                    continue;
                }

                if (code >= 400)
                {
                    throw new HttpFailure($"сервер ответил HTTP {code}", code, transient: code is 429 or >= 500);
                }

                var append = code == (int)HttpStatusCode.PartialContent && existing > 0;
                if (!append)
                {
                    existing = 0;
                }

                var total = response.Content.Headers.ContentRange?.Length
                    ?? (response.Content.Headers.ContentLength is { } len ? len + existing : null);
                await using var source = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                await using var target = new FileStream(destination, append ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.Read, 81920, useAsync: true);
                var buffer = new byte[81920];
                var received = existing;
                progress?.Report(new DownloadProgress(received, total));
                int read;
                while ((read = await ReadWithTimeoutAsync(source, buffer, ct).ConfigureAwait(false)) > 0)
                {
                    await target.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                    received += read;
                    progress?.Report(new DownloadProgress(received, total));
                }

                await target.FlushAsync(ct).ConfigureAwait(false);
                if (total is { } expected && received != expected)
                {
                    throw new HttpFailure($"файл скачан не полностью ({received} из {expected} байт)", null, transient: true);
                }

                return received;
            }
        }

        throw new HttpFailure("слишком много перенаправлений");
    }

    private static async Task<int> ReadWithTimeoutAsync(Stream source, byte[] buffer, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(60)); // 60 секунд без единого байта — связь потеряна
        try
        {
            return await source.ReadAsync(buffer, cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new HttpFailure("связь прервалась: данные не приходят", null, transient: true);
        }
        catch (Exception e) when (e is HttpRequestException or IOException)
        {
            throw new HttpFailure("связь прервалась: " + e.Message, null, transient: true);
        }
    }
}
