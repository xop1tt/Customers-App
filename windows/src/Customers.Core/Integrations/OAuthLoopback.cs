using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Customers.Core;

/// <summary>Ждёт возврата из браузера после входа. В приложении — <see cref="OAuthLoopback"/>, в тестах — подмена.</summary>
public interface IOAuthListener : IDisposable
{
    /// <summary>Порт, на котором слушает сервер (он входит в адрес возврата).</summary>
    int Port { get; }

    Task<OAuthCallback> WaitForCallbackAsync(CancellationToken ct);
}

/// <summary>
/// Крошечный HTTP-сервер на этом компьютере: принимает один запрос браузера на /oauth/callback и показывает страницу
/// «Вход выполнен». Слушает только адреса обратной петли (127.0.0.1 и ::1), снаружи недоступен. Как и в macOS-версии,
/// порт постоянный. Сервер открывается в конструкторе, чтобы к моменту перехода браузера порт уже был занят.
/// </summary>
public sealed class OAuthLoopback : IOAuthListener
{
    private readonly List<TcpListener> _listeners = [];

    public OAuthLoopback(int port = OAuthRedirect.Port)
    {
        TcpListener? v4 = null;
        try
        {
            v4 = new TcpListener(IPAddress.Loopback, port);
            v4.Start(4);
            _listeners.Add(v4);
        }
        catch (SocketException e)
        {
            v4?.Stop();
            throw new IntegrationException(IntegrationFailure.Busy,
                $"Порт {port} занят другой программой, поэтому войти через браузер сейчас нельзя. Закройте её или повторите позже. ({e.SocketErrorCode})");
        }

        Port = ((IPEndPoint)v4.LocalEndpoint).Port;
        // Браузер может перейти на localhost по IPv6: слушаем и ::1, если он есть. Без него вход работает по IPv4.
        if (Socket.OSSupportsIPv6)
        {
            try
            {
                var v6 = new TcpListener(IPAddress.IPv6Loopback, Port);
                v6.Start(4);
                _listeners.Add(v6);
            }
            catch (SocketException)
            {
                // IPv6 недоступен или порт занят только на нём.
            }
        }
    }

    public int Port { get; }

    public async Task<OAuthCallback> WaitForCallbackAsync(CancellationToken ct)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var accepts = _listeners.Select(l => AcceptLoopAsync(l, linked.Token)).ToList();
        try
        {
            var first = await Task.WhenAny(accepts).ConfigureAwait(false);
            return await first.ConfigureAwait(false);
        }
        finally
        {
            await linked.CancelAsync().ConfigureAwait(false);
            foreach (var accept in accepts)
            {
                try
                {
                    await accept.ConfigureAwait(false);
                }
                catch (Exception e) when (e is OperationCanceledException or ObjectDisposedException or SocketException or IOException)
                {
                    // Остальные ожидания только что отменены: их исход нас не интересует.
                }
            }
        }
    }

    private static async Task<OAuthCallback> AcceptLoopAsync(TcpListener listener, CancellationToken ct)
    {
        while (true)
        {
            using var client = await listener.AcceptTcpClientAsync(ct).ConfigureAwait(false);
            if (await TryServeAsync(client, ct).ConfigureAwait(false) is { } callback)
            {
                return callback;
            }
        }
    }

    private static async Task<OAuthCallback?> TryServeAsync(TcpClient client, CancellationToken ct)
    {
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            var stream = client.GetStream();
            var buffer = new byte[8192];
            var length = 0;
            // Достаточно первой строки запроса: «GET /oauth/callback?code=… HTTP/1.1».
            while (length < buffer.Length)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(length), timeout.Token).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }

                length += read;
                if (Array.IndexOf(buffer, (byte)'\n', 0, length) >= 0)
                {
                    break;
                }
            }

            var text = Encoding.ASCII.GetString(buffer, 0, length);
            var line = text.Split('\n', 2)[0].TrimEnd('\r');
            var callback = OAuthCallback.Parse(line);
            var (status, body) = callback is null
                ? ("404 Not Found", Page("Страница не найдена", "Это служебный адрес приложения Customers."))
                : callback.Error is null
                    ? ("200 OK", Page("Вход выполнен", "Можно закрыть эту вкладку и вернуться в Customers."))
                    : ("200 OK", Page("Вход не выполнен", "Вернитесь в Customers и попробуйте ещё раз."));
            var payload = Encoding.UTF8.GetBytes(body);
            var head = Encoding.ASCII.GetBytes($"HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {payload.Length}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n");
            await stream.WriteAsync(head, timeout.Token).ConfigureAwait(false);
            await stream.WriteAsync(payload, timeout.Token).ConfigureAwait(false);
            await stream.FlushAsync(timeout.Token).ConfigureAwait(false);
            return callback;
        }
        catch (Exception e) when (e is IOException or SocketException or ObjectDisposedException || (e is OperationCanceledException && !ct.IsCancellationRequested))
        {
            return null; // оборванное соединение или молчащий клиент: ждём следующего
        }
    }

    private static string Page(string title, string text) =>
        $"<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><title>{title}</title><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
        "<style>body{font:16px Segoe UI,system-ui,sans-serif;margin:15vh auto;max-width:28em;padding:0 1em;color:#222}h1{font-size:1.4em}@media(prefers-color-scheme:dark){body{background:#202020;color:#eee}}</style>" +
        $"</head><body><h1>{title}</h1><p>{text}</p></body></html>";

    public void Dispose()
    {
        foreach (var l in _listeners)
        {
            l.Stop();
        }

        _listeners.Clear();
    }
}
