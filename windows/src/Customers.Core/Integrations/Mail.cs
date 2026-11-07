using System.Globalization;
using System.Net.Security;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Customers.Core;

// Отправка писем прямо из приложения по SMTP. Протокол и сборка письма — как в macOS-версии (RFC 5322 + MIME, AUTH PLAIN/LOGIN,
// STARTTLS). Без шифрования приложение не отправляет: пароль ушёл бы открытым текстом. Само соединение открывает TcpSmtpTransport,
// в тестах его заменяет поддельный сервер.

/// <summary>Почтовый сервис: готовые настройки SMTP и где взять пароль приложения.</summary>
public enum MailProvider
{
    Gmail,
    Yandex,
    MailRu,
    ICloud,
    Custom,
}

/// <summary>Шифрование соединения: TLS с первого байта (порт 465) или обязательный STARTTLS (587).</summary>
public enum MailSecurity
{
    Tls,
    StartTls,
}

/// <summary>Как отправлять письма из окна «Написать».</summary>
public enum MailDelivery
{
    /// <summary>Письмо открывается в почтовой программе по умолчанию: она хранит отправленные.</summary>
    MailApp,

    /// <summary>Отправка прямо из приложения по SMTP.</summary>
    Smtp,
}

public static class MailProviders
{
    public static string Title(this MailProvider p) => p switch {
        MailProvider.Gmail => "Gmail",
        MailProvider.Yandex => "Яндекс Почта",
        MailProvider.MailRu => "Почта Mail.ru",
        MailProvider.ICloud => "iCloud Почта",
        _ => "Другой сервер (SMTP)",
    };

    public static string Host(this MailProvider p) => p switch {
        MailProvider.Gmail => "smtp.gmail.com",
        MailProvider.Yandex => "smtp.yandex.ru",
        MailProvider.MailRu => "smtp.mail.ru",
        MailProvider.ICloud => "smtp.mail.me.com",
        _ => "",
    };

    public static int Port(this MailProvider p) => p == MailProvider.ICloud ? 587 : 465;

    public static MailSecurity Security(this MailProvider p) => p == MailProvider.ICloud ? MailSecurity.StartTls : MailSecurity.Tls;

    /// <summary>Страница, где создаётся пароль приложения (обычный пароль сервисы по SMTP не принимают).</summary>
    public static Uri? AppPasswordPage(this MailProvider p) => p switch {
        MailProvider.Gmail => new Uri("https://myaccount.google.com/apppasswords"),
        MailProvider.Yandex => new Uri("https://id.yandex.ru/security/app-passwords"),
        MailProvider.MailRu => new Uri("https://account.mail.ru/user/2-step-auth/passwords/"),
        MailProvider.ICloud => new Uri("https://account.apple.com/account/manage"),
        _ => null,
    };

    public static string Hint(this MailProvider p) => p switch {
        MailProvider.Gmail => "Нужна двухэтапная аутентификация и пароль приложения из 16 букв.",
        MailProvider.Yandex => "Создайте пароль приложения для «Почты» и включите доступ по протоколам в настройках Яндекс Почты.",
        MailProvider.MailRu => "Создайте пароль для внешнего приложения в настройках безопасности Mail.ru.",
        MailProvider.ICloud => "Создайте пароль приложения в настройках Apple ID. Логин — адрес @icloud.com.",
        _ => "Адрес SMTP-сервера и порт даёт ваш почтовый сервис. 465 — TLS, 587 — STARTTLS.",
    };

    /// <summary>Сервис по домену адреса, иначе «другой сервер».</summary>
    public static MailProvider Detect(string email)
    {
        var domain = email.Contains('@') ? email[(email.LastIndexOf('@') + 1)..].ToLowerInvariant() : "";
        return domain switch {
            "gmail.com" or "googlemail.com" => MailProvider.Gmail,
            "yandex.ru" or "ya.ru" or "yandex.com" or "yandex.by" or "yandex.kz" or "narod.ru" => MailProvider.Yandex,
            "mail.ru" or "inbox.ru" or "list.ru" or "bk.ru" or "internet.ru" => MailProvider.MailRu,
            "icloud.com" or "me.com" or "mac.com" => MailProvider.ICloud,
            _ => MailProvider.Custom,
        };
    }

    public static string Title(this MailSecurity s) => s == MailSecurity.Tls ? "TLS (465)" : "STARTTLS (587)";

    public static string Title(this MailDelivery d) => d == MailDelivery.MailApp ? "Через почтовую программу Windows" : "Прямо из приложения (SMTP)";
}

/// <summary>Настройки почтового ящика без пароля. Пароль приложения лежит в защищённом хранилище.</summary>
public sealed record MailAccount(MailProvider Provider = MailProvider.Custom, string Host = "", int Port = 465, MailSecurity Security = MailSecurity.Tls,
    string Username = "", string FromAddress = "", string FromName = "", bool CopyToSelf = true)
{
    /// <summary>Готовые настройки сервиса по адресу.</summary>
    public static MailAccount Preset(string email, string name = "")
    {
        var p = MailProviders.Detect(email);
        return new MailAccount(p, p.Host(), p.Port(), p.Security(), email, email, name);
    }

    /// <summary>Текст ошибки, если настройки неполные; null — можно отправлять.</summary>
    public string? Problem
    {
        get
        {
            var h = Host.Trim();
            if (h.Length == 0 || h.Any(c => char.IsWhiteSpace(c) || c is '/' or ':'))
            {
                return "Укажите адрес SMTP-сервера";
            }

            if (Port is < 1 or > 65535)
            {
                return "Неверный порт";
            }

            if (string.IsNullOrWhiteSpace(Username))
            {
                return "Укажите логин";
            }

            if (!ContactLinks.IsEmail(FromAddress))
            {
                return "Укажите адрес отправителя";
            }

            return FromName.Any(c => c is '\r' or '\n') ? "Имя отправителя не должно содержать переводов строки" : null;
        }
    }

    public string Encode() => new JsonObject {
        ["provider"] = Provider.ToString(),
        ["host"] = Host,
        ["port"] = Port,
        ["security"] = Security.ToString(),
        ["username"] = Username,
        ["fromAddress"] = FromAddress,
        ["fromName"] = FromName,
        ["copyToSelf"] = CopyToSelf,
    }.ToJsonString();

    public static MailAccount? Decode(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        try
        {
            if (JsonNode.Parse(text) is not JsonObject o)
            {
                return null;
            }

            return new MailAccount(
                Enum.TryParse<MailProvider>(o["provider"]?.ToString(), out var p) ? p : MailProvider.Custom,
                o["host"]?.ToString() ?? "",
                o["port"] is JsonValue v && v.TryGetValue<int>(out var port) ? port : 465,
                Enum.TryParse<MailSecurity>(o["security"]?.ToString(), out var s) ? s : MailSecurity.Tls,
                o["username"]?.ToString() ?? "",
                o["fromAddress"]?.ToString() ?? "",
                o["fromName"]?.ToString() ?? "",
                o["copyToSelf"] is not JsonValue c || !c.TryGetValue<bool>(out var copy) || copy);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }
}

/// <summary>Письмо: один получатель, простой текст в UTF-8.</summary>
public sealed record OutgoingMail(string To, string Subject, string Body);

public enum MailFailure
{
    InvalidRecipient,
    InvalidAccount,
    EmptyMessage,
    NoPassword,
    TlsUnavailable,
    AuthUnsupported,
    Server,
    BadReply,
    Connection,
}

public sealed class MailException(MailFailure failure, string message, int code = 0, string stage = "") : Exception(message)
{
    public MailFailure Failure { get; } = failure;

    public int Code { get; } = code;

    public string Stage { get; } = stage;

    public static MailException InvalidRecipient() => new(MailFailure.InvalidRecipient, "Неверный адрес получателя");

    public static MailException InvalidAccount(string text) => new(MailFailure.InvalidAccount, text);

    public static MailException EmptyMessage() => new(MailFailure.EmptyMessage, "Пустое письмо: добавьте тему или текст");

    public static MailException NoPassword() => new(MailFailure.NoPassword, "Не задан пароль приложения для почты (Настройки → Почта)");

    public static MailException TlsUnavailable() => new(MailFailure.TlsUnavailable, "Сервер не поддерживает шифрование STARTTLS. Выберите TLS (порт 465)");

    public static MailException AuthUnsupported() => new(MailFailure.AuthUnsupported, "Сервер не поддерживает вход по логину и паролю (AUTH PLAIN / LOGIN)");

    public static MailException BadReply(string text) => new(MailFailure.BadReply, "Непонятный ответ почтового сервера: " + text);

    public static MailException Connection(string text) => new(MailFailure.Connection, "Не удалось связаться с почтовым сервером: " + text);

    /// <summary>Ответ сервера с кодом ошибки на шаге <paramref name="stage"/>.</summary>
    public static MailException ServerError(int code, string text, string stage)
    {
        var message = code is 535 or 534 || (stage == "AUTH" && code >= 500)
            ? $"Почтовый сервер не принял логин или пароль. Нужен пароль приложения, а не обычный пароль. ({code})"
            : stage == "RCPT"
                ? $"Сервер отклонил адрес получателя: {text} ({code})"
                : $"Почтовый сервер ответил ошибкой на шаге {stage}: {text} ({code})";
        return new MailException(MailFailure.Server, message, code, stage);
    }
}

// MARK: Сборка письма (RFC 5322 + MIME)

public static class MimeMessage
{
    /// <summary>Письмо целиком, строки через CRLF, без завершающей точки DATA.</summary>
    public static string Build(OutgoingMail mail, MailAccount account, DateTimeOffset date, string messageId)
    {
        var to = mail.To.Trim(' ', '\t');
        if (!ContactLinks.IsEmail(to))
        {
            throw MailException.InvalidRecipient();
        }

        if (account.Problem is { } problem)
        {
            throw MailException.InvalidAccount(problem);
        }

        var subject = mail.Subject.Replace('\r', ' ').Replace('\n', ' ');
        if (string.IsNullOrWhiteSpace(subject) && string.IsNullOrWhiteSpace(mail.Body))
        {
            throw MailException.EmptyMessage();
        }

        var from = account.FromAddress.Trim(' ', '\t');
        var name = account.FromName.Trim(' ', '\t');
        var domain = from.Contains('@') ? from[(from.LastIndexOf('@') + 1)..] : "localhost";
        var headers = new List<string> {
            "From: " + (name.Length == 0 ? $"<{from}>" : $"{EncodedWord(name)} <{from}>"),
            $"To: <{to}>",
            "Subject: " + EncodedWord(subject),
            "Date: " + Rfc5322Date(date),
            $"Message-ID: <{messageId}@{domain}>",
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=UTF-8",
            "Content-Transfer-Encoding: base64",
            "X-Mailer: Customers",
        };
        return string.Join("\r\n", headers) + "\r\n\r\n" + Base64Lines(Encoding.UTF8.GetBytes(NormalizeNewlines(mail.Body))) + "\r\n";
    }

    public static string NormalizeNewlines(string s) => s.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Replace("\n", "\r\n", StringComparison.Ordinal);

    /// <summary>Base64 строками по 76 символов через CRLF (без завершающего перевода строки).</summary>
    public static string Base64Lines(byte[] data)
    {
        var b64 = Convert.ToBase64String(data);
        var sb = new StringBuilder();
        for (var i = 0; i < b64.Length; i += 76)
        {
            if (i > 0)
            {
                sb.Append("\r\n");
            }

            sb.Append(b64, i, Math.Min(76, b64.Length - i));
        }

        return sb.ToString();
    }

    /// <summary>
    /// Заголовок в кодировке RFC 2047 (=?UTF-8?B?…?=). Только ASCII без спецсимволов — как есть. Длинный текст делится на
    /// несколько слов, каждое не длиннее 75 символов; символ (в том числе из двух кодовых единиц) не разрывается.
    /// </summary>
    public static string EncodedWord(string text)
    {
        var plainOk = text.All(c => c is >= (char)0x20 and < (char)0x7F) && !text.Contains("=?", StringComparison.Ordinal)
            && !text.Any(c => "\"<>()@,;:".Contains(c));
        if (plainOk && text.Length <= 70)
        {
            return text;
        }

        var words = new List<string>();
        var chunk = new List<byte>();
        foreach (var element in Elements(text))
        {
            var bytes = Encoding.UTF8.GetBytes(element);
            if (chunk.Count + bytes.Length > 45)
            {
                words.Add($"=?UTF-8?B?{Convert.ToBase64String([.. chunk])}?=");
                chunk.Clear();
            }

            chunk.AddRange(bytes);
        }

        if (chunk.Count > 0 || words.Count == 0)
        {
            words.Add($"=?UTF-8?B?{Convert.ToBase64String([.. chunk])}?=");
        }

        return string.Join("\r\n ", words);
    }

    private static IEnumerable<string> Elements(string text)
    {
        var e = StringInfo.GetTextElementEnumerator(text);
        while (e.MoveNext())
        {
            yield return (string)e.Current;
        }
    }

    public static string Rfc5322Date(DateTimeOffset date)
    {
        var offset = date.Offset;
        var sign = offset < TimeSpan.Zero ? "-" : "+";
        return date.ToString("ddd, dd MMM yyyy HH:mm:ss", CultureInfo.InvariantCulture) + $" {sign}{Math.Abs(offset.Hours):00}{Math.Abs(offset.Minutes):00}";
    }

    /// <summary>Точка в начале строки удваивается, чтобы сервер не принял её за конец письма.</summary>
    public static string DotStuffed(string message) =>
        string.Join("\r\n", message.Split("\r\n").Select(line => line.StartsWith('.') ? "." + line : line));
}

// MARK: SMTP

/// <summary>Соединение с почтовым сервером: байты туда и обратно и включение TLS по STARTTLS.</summary>
public interface ISmtpTransport
{
    /// <summary>Следующая порция байтов от сервера. Пустой ответ — соединение закрыто.</summary>
    Task<byte[]> ReceiveAsync(CancellationToken ct);

    Task SendAsync(byte[] data, CancellationToken ct);

    /// <summary>Перевести открытое соединение в TLS (после ответа 220 на STARTTLS).</summary>
    Task StartTlsAsync(CancellationToken ct);

    void Close();
}

public sealed record SmtpReply(int Code, IReadOnlyList<string> Lines)
{
    public string Text => string.Join(' ', Lines);
}

/// <summary>Диалог SMTP: EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA, QUIT.</summary>
public sealed class SmtpClient(ISmtpTransport transport)
{
    private readonly List<byte> _buffer = [];
    private readonly List<string> _log = [];

    /// <summary>Что говорили клиент и сервер (пароль скрыт). Для диагностики и тестов.</summary>
    public IReadOnlyList<string> Log => _log;

    /// <summary>Отправляет письмо. Транспорт для TLS должен быть уже зашифрован, для STARTTLS — открыт.</summary>
    public async Task SendAsync(OutgoingMail mail, MailAccount account, string password, CancellationToken ct, string hostname = "localhost",
        DateTimeOffset? date = null)
    {
        if (password.Length == 0)
        {
            throw MailException.NoPassword();
        }

        var message = MimeMessage.Build(mail, account, date ?? DateTimeOffset.Now, Guid.NewGuid().ToString());
        try
        {
            Expect(await ReplyAsync(ct).ConfigureAwait(false), [220], "приветствие");
            var caps = await EhloAsync(hostname, ct).ConfigureAwait(false);
            if (account.Security == MailSecurity.StartTls)
            {
                if (!caps.Any(c => c.Equals("STARTTLS", StringComparison.OrdinalIgnoreCase)))
                {
                    throw MailException.TlsUnavailable();
                }

                await CommandAsync("STARTTLS", [220], "STARTTLS", ct).ConfigureAwait(false);
                await transport.StartTlsAsync(ct).ConfigureAwait(false);
                _buffer.Clear();
                caps = await EhloAsync(hostname, ct).ConfigureAwait(false);
            }

            await AuthenticateAsync(caps, account.Username.Trim(), password, ct).ConfigureAwait(false);
            var from = account.FromAddress.Trim();
            var to = mail.To.Trim();
            await CommandAsync($"MAIL FROM:<{from}>", [250], "MAIL", ct).ConfigureAwait(false);
            await CommandAsync($"RCPT TO:<{to}>", [250, 251], "RCPT", ct).ConfigureAwait(false);
            if (account.CopyToSelf && !from.Equals(to, StringComparison.OrdinalIgnoreCase))
            {
                await CommandAsync($"RCPT TO:<{from}>", [250, 251], "RCPT", ct).ConfigureAwait(false);
            }

            await CommandAsync("DATA", [354], "DATA", ct).ConfigureAwait(false);
            await transport.SendAsync(Encoding.UTF8.GetBytes(MimeMessage.DotStuffed(message) + ".\r\n"), ct).ConfigureAwait(false);
            _log.Add("C: <письмо>");
            Expect(await ReplyAsync(ct).ConfigureAwait(false), [250], "DATA");
            try
            {
                // Письмо уже принято: ошибка на QUIT не считается неудачей.
                await CommandAsync("QUIT", [221], "QUIT", ct).ConfigureAwait(false);
            }
            catch (Exception e) when (e is MailException or IOException or SocketException)
            {
            }
        }
        finally
        {
            transport.Close();
        }
    }

    private async Task<IReadOnlyList<string>> EhloAsync(string hostname, CancellationToken ct)
    {
        var r = await CommandAsync($"EHLO {hostname}", [250], "EHLO", ct).ConfigureAwait(false);
        return [.. r.Lines.Skip(1).Select(l => l.Trim())];
    }

    private async Task AuthenticateAsync(IReadOnlyList<string> caps, string user, string password, CancellationToken ct)
    {
        var line = caps.FirstOrDefault(c => c.StartsWith("AUTH", StringComparison.OrdinalIgnoreCase));
        var methods = line is null
            ? []
            : line.ToUpperInvariant().Replace("AUTH=", "AUTH ", StringComparison.Ordinal).Split(' ', StringSplitOptions.RemoveEmptyEntries).Skip(1).ToList();
        if (methods.Contains("PLAIN"))
        {
            var token = Convert.ToBase64String(Encoding.UTF8.GetBytes($"\0{user}\0{password}"));
            await CommandAsync("AUTH PLAIN " + token, [235], "AUTH", ct, secret: true).ConfigureAwait(false);
        }
        else if (methods.Contains("LOGIN"))
        {
            await CommandAsync("AUTH LOGIN", [334], "AUTH", ct).ConfigureAwait(false);
            await CommandAsync(Convert.ToBase64String(Encoding.UTF8.GetBytes(user)), [334], "AUTH", ct, secret: true).ConfigureAwait(false);
            await CommandAsync(Convert.ToBase64String(Encoding.UTF8.GetBytes(password)), [235], "AUTH", ct, secret: true).ConfigureAwait(false);
        }
        else
        {
            throw MailException.AuthUnsupported();
        }
    }

    private async Task<SmtpReply> CommandAsync(string line, int[] ok, string stage, CancellationToken ct, bool secret = false)
    {
        _log.Add("C: " + (secret ? "<скрыто>" : line));
        await transport.SendAsync(Encoding.UTF8.GetBytes(line + "\r\n"), ct).ConfigureAwait(false);
        var reply = await ReplyAsync(ct).ConfigureAwait(false);
        Expect(reply, ok, stage);
        return reply;
    }

    private static void Expect(SmtpReply reply, int[] ok, string stage)
    {
        if (!ok.Contains(reply.Code))
        {
            throw MailException.ServerError(reply.Code, reply.Text, stage);
        }
    }

    /// <summary>Ответ сервера, возможно многострочный («250-…» … «250 …»).</summary>
    private async Task<SmtpReply> ReplyAsync(CancellationToken ct)
    {
        var lines = new List<string>();
        while (true)
        {
            var line = await ReadLineAsync(ct).ConfigureAwait(false);
            _log.Add("S: " + line);
            if (line.Length < 3 || !int.TryParse(line.AsSpan(0, 3), NumberStyles.None, CultureInfo.InvariantCulture, out var code))
            {
                throw MailException.BadReply(line);
            }

            lines.Add(line.Length > 4 ? line[4..] : "");
            if (line.Length <= 3 || line[3] != '-')
            {
                return new SmtpReply(code, lines);
            }
        }
    }

    private async Task<string> ReadLineAsync(CancellationToken ct)
    {
        while (true)
        {
            var newline = _buffer.IndexOf((byte)'\n');
            if (newline >= 0)
            {
                var bytes = _buffer.GetRange(0, newline).ToArray();
                _buffer.RemoveRange(0, newline + 1);
                return Encoding.UTF8.GetString(bytes).TrimEnd('\r');
            }

            if (_buffer.Count > 64 * 1024)
            {
                throw MailException.BadReply("слишком длинная строка");
            }

            var chunk = await transport.ReceiveAsync(ct).ConfigureAwait(false);
            if (chunk.Length == 0)
            {
                throw MailException.Connection("сервер закрыл соединение");
            }

            _buffer.AddRange(chunk);
        }
    }
}

/// <summary>Настоящее соединение с SMTP-сервером: TcpClient, а поверх него SslStream (сразу или после STARTTLS). Сертификат сервера проверяется.</summary>
public sealed class TcpSmtpTransport : ISmtpTransport
{
    private readonly string _host;
    private readonly TcpClient _client = new();
    private readonly TimeSpan _timeout;
    private readonly bool _implicitTls;
    private readonly int _port;
    private Stream? _stream;

    public TcpSmtpTransport(string host, int port, bool implicitTls, TimeSpan? timeout = null)
    {
        _host = host.Trim();
        _port = port;
        _implicitTls = implicitTls;
        _timeout = timeout ?? TimeSpan.FromSeconds(30);
    }

    private async Task<Stream> StreamAsync(CancellationToken ct)
    {
        if (_stream is not null)
        {
            return _stream;
        }

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);
            await _client.ConnectAsync(_host, _port, cts.Token).ConfigureAwait(false);
            _stream = _client.GetStream();
            if (_implicitTls)
            {
                _stream = await WrapTlsAsync(_stream, cts.Token).ConfigureAwait(false);
            }
        }
        catch (Exception e) when (IsNetwork(e, ct))
        {
            throw MailException.Connection(Describe(e));
        }

        return _stream;
    }

    private async Task<Stream> WrapTlsAsync(Stream inner, CancellationToken ct)
    {
        var tls = new SslStream(inner, leaveInnerStreamOpen: false);
        await tls.AuthenticateAsClientAsync(new SslClientAuthenticationOptions { TargetHost = _host }, ct).ConfigureAwait(false);
        return tls;
    }

    public async Task<byte[]> ReceiveAsync(CancellationToken ct)
    {
        var stream = await StreamAsync(ct).ConfigureAwait(false);
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);
            var buffer = new byte[16 * 1024];
            var read = await stream.ReadAsync(buffer, cts.Token).ConfigureAwait(false);
            return buffer[..read];
        }
        catch (Exception e) when (IsNetwork(e, ct))
        {
            throw MailException.Connection(Describe(e));
        }
    }

    public async Task SendAsync(byte[] data, CancellationToken ct)
    {
        var stream = await StreamAsync(ct).ConfigureAwait(false);
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);
            await stream.WriteAsync(data, cts.Token).ConfigureAwait(false);
            await stream.FlushAsync(cts.Token).ConfigureAwait(false);
        }
        catch (Exception e) when (IsNetwork(e, ct))
        {
            throw MailException.Connection(Describe(e));
        }
    }

    public async Task StartTlsAsync(CancellationToken ct)
    {
        var stream = await StreamAsync(ct).ConfigureAwait(false);
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeout);
            _stream = await WrapTlsAsync(stream, cts.Token).ConfigureAwait(false);
        }
        catch (Exception e) when (IsNetwork(e, ct) || e is System.Security.Authentication.AuthenticationException)
        {
            throw MailException.Connection(Describe(e));
        }
    }

    public void Close()
    {
        try
        {
            _stream?.Dispose();
            _client.Dispose();
        }
        catch (Exception e) when (e is IOException or SocketException or ObjectDisposedException)
        {
        }
    }

    private static bool IsNetwork(Exception e, CancellationToken outer) =>
        e is IOException or SocketException or ObjectDisposedException or System.Security.Authentication.AuthenticationException
        || (e is OperationCanceledException && !outer.IsCancellationRequested);

    private static string Describe(Exception e) => e is OperationCanceledException ? "время ожидания истекло" : e.InnerException?.Message ?? e.Message;
}
