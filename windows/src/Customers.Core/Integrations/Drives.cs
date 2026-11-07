using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Customers.Core;

// Облачные диски, к которым приложение подключается само: вход через браузер (OAuth 2.0 с PKCE) или WebDAV с паролем
// приложения. Сюда копии базы выгружаются в папку «Customers». Каталог, адреса, разбор ответов и запросы выгрузки — те же,
// что у macOS-версии, поэтому один и тот же ключ приложения (Client ID) работает в обеих. Здесь нет интерфейса и нет
// привязки к Windows: всё проверяется тестами на любой системе. Сеть — через IHttpTransport, браузер и хранилище секретов — снаружи.

/// <summary>Облачный диск, который подключается из приложения.</summary>
public enum DriveService
{
    GoogleDrive,
    Dropbox,
    OneDrive,
    YandexDisk,
    Mega,
    PCloud,
    WebDav,
}

/// <summary>Как диск подключается: через браузер (OAuth) или по адресу WebDAV.</summary>
public sealed record DriveAuth(OAuthProvider? OAuth, string DefaultUrl = "", Uri? PasswordPage = null)
{
    public bool IsOAuth => OAuth is not null;
}

/// <summary>Поставщик OAuth 2.0 с PKCE. Идентификатор клиента публичный, но свой у каждого зарегистрированного приложения: его создаёт владелец сборки.</summary>
public enum OAuthProvider
{
    Google,
    Dropbox,
    Microsoft,
}

public static class DriveServices
{
    public static string Title(this DriveService s) => s switch {
        DriveService.GoogleDrive => "Google Диск",
        DriveService.Dropbox => "Dropbox",
        DriveService.OneDrive => "OneDrive",
        DriveService.YandexDisk => "Яндекс Диск",
        DriveService.Mega => "MEGA",
        DriveService.PCloud => "pCloud",
        _ => "WebDAV / Nextcloud",
    };

    public static string Subtitle(this DriveService s) => s switch {
        DriveService.GoogleDrive => "Вход через Google, доступ только к файлам приложения",
        DriveService.Dropbox => "Вход через Dropbox, отдельная папка приложения",
        DriveService.OneDrive => "Вход через Microsoft, папка приложения",
        DriveService.YandexDisk => "Логин и пароль приложения Яндекса (WebDAV)",
        DriveService.Mega => "Через MEGAcmd: команда mega-webdav открывает папку по WebDAV",
        DriveService.PCloud => "Логин и пароль pCloud (WebDAV)",
        _ => "Nextcloud, ownCloud, Synology, Keenetic и другие",
    };

    /// <summary>Буква на значке сервиса в списке.</summary>
    public static string Letter(this DriveService s) => s switch {
        DriveService.GoogleDrive => "G",
        DriveService.Dropbox => "D",
        DriveService.OneDrive => "O",
        DriveService.YandexDisk => "Я",
        DriveService.Mega => "M",
        DriveService.PCloud => "p",
        _ => "W",
    };

    public static DriveAuth Auth(this DriveService s) => s switch {
        DriveService.GoogleDrive => new DriveAuth(OAuthProvider.Google),
        DriveService.Dropbox => new DriveAuth(OAuthProvider.Dropbox),
        DriveService.OneDrive => new DriveAuth(OAuthProvider.Microsoft),
        DriveService.YandexDisk => new DriveAuth(null, "https://webdav.yandex.ru", new Uri("https://id.yandex.ru/security/app-passwords")),
        DriveService.Mega => new DriveAuth(null, "http://127.0.0.1:4443/", new Uri("https://mega.io/cmd")),
        DriveService.PCloud => new DriveAuth(null, "https://ewebdav.pcloud.com"),
        _ => new DriveAuth(null),
    };

    /// <summary>MEGAcmd раздаёт WebDAV только на этом компьютере и без пароля.</summary>
    public static bool PasswordOptional(this DriveService s) => s == DriveService.Mega;

    /// <summary>Сервис, который входит через данный OAuth.</summary>
    public static DriveService Service(this OAuthProvider p) => p switch {
        OAuthProvider.Google => DriveService.GoogleDrive,
        OAuthProvider.Dropbox => DriveService.Dropbox,
        _ => DriveService.OneDrive,
    };

    public static string Id(this DriveService s) => s.ToString();
}

public static class OAuthProviders
{
    public static Uri AuthorizeUrl(this OAuthProvider p) => p switch {
        OAuthProvider.Google => new Uri("https://accounts.google.com/o/oauth2/v2/auth"),
        OAuthProvider.Dropbox => new Uri("https://www.dropbox.com/oauth2/authorize"),
        _ => new Uri("https://login.microsoftonline.com/common/oauth2/v2.0/authorize"),
    };

    public static Uri TokenUrl(this OAuthProvider p) => p switch {
        OAuthProvider.Google => new Uri("https://oauth2.googleapis.com/token"),
        OAuthProvider.Dropbox => new Uri("https://api.dropboxapi.com/oauth2/token"),
        _ => new Uri("https://login.microsoftonline.com/common/oauth2/v2.0/token"),
    };

    /// <summary>Права, о которых просит приложение. У Dropbox права задаются в консоли (App folder, files.content.write).</summary>
    public static string? Scope(this OAuthProvider p) => p switch {
        OAuthProvider.Google => "https://www.googleapis.com/auth/drive.file",
        OAuthProvider.Dropbox => null,
        _ => "Files.ReadWrite.AppFolder offline_access",
    };

    /// <summary>Имя переменной репозитория с идентификатором клиента для сборки.</summary>
    public static string BuildVariable(this OAuthProvider p) => p switch {
        OAuthProvider.Google => "GOOGLE_OAUTH_CLIENT_ID",
        OAuthProvider.Dropbox => "DROPBOX_APP_KEY",
        _ => "MICROSOFT_CLIENT_ID",
    };

    /// <summary>Ключ метаданных сборки с идентификатором клиента.</summary>
    public static string MetadataKey(this OAuthProvider p) => p switch {
        OAuthProvider.Google => "GoogleClientId",
        OAuthProvider.Dropbox => "DropboxAppKey",
        _ => "MicrosoftClientId",
    };

    public static Uri ConsolePage(this OAuthProvider p) => p switch {
        OAuthProvider.Google => new Uri("https://console.cloud.google.com/apis/credentials"),
        OAuthProvider.Dropbox => new Uri("https://www.dropbox.com/developers/apps"),
        _ => new Uri("https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"),
    };

    /// <summary>Как называется поле с идентификатором в консоли сервиса.</summary>
    public static string ClientIdLabel(this OAuthProvider p) => p switch {
        OAuthProvider.Google => "Client ID",
        OAuthProvider.Dropbox => "App key",
        _ => "Application (client) ID",
    };

    /// <summary>Имя записи в хранилище секретов с введённым ключом. Общая для всех учётных записей на этом компьютере.</summary>
    public static string SecretName(this OAuthProvider p) => "integration.oauthkey." + p.ToString().ToLowerInvariant();

    /// <summary>Google для приложений «Desktop» требует client_secret даже при PKCE (Google не считает его секретом для установленных приложений).</summary>
    public static bool NeedsClientSecret(this OAuthProvider p) => p == OAuthProvider.Google;

    public static string SecretMetadataKey(this OAuthProvider p) => p == OAuthProvider.Google ? "GoogleClientSecret" : "";

    internal static IReadOnlyList<(string Name, string Value)> ExtraAuthorizeParams(this OAuthProvider p) => p switch {
        OAuthProvider.Google => [("access_type", "offline"), ("prompt", "consent")],
        OAuthProvider.Dropbox => [("token_access_type", "offline")],
        _ => [("prompt", "select_account")],
    };
}

/// <summary>Ключ OAuth-приложения, который пользователь ввёл в приложении («Добавить ключ»). Хранится только в защищённом хранилище.</summary>
public sealed record OAuthKey(string ClientId, string? ClientSecret = null)
{
    /// <summary>Текст ошибки, если ключ не подходит поставщику; null — подходит.</summary>
    public string? Problem(OAuthProvider provider)
    {
        var id = ClientId.Trim();
        if (id.Length == 0)
        {
            return $"Введите {provider.ClientIdLabel()}";
        }

        if (id.Any(char.IsWhiteSpace) || id.StartsWith('$'))
        {
            return $"{provider.ClientIdLabel()} не должен содержать пробелов";
        }

        if (provider.NeedsClientSecret() && string.IsNullOrWhiteSpace(ClientSecret))
        {
            return "Для Google нужен ещё Client secret";
        }

        return null;
    }

    public string Encode() => new JsonObject { ["clientId"] = ClientId, ["clientSecret"] = ClientSecret }.ToJsonString();

    public static OAuthKey? Decode(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        try
        {
            return JsonNode.Parse(text) is JsonObject o && o["clientId"]?.GetValue<string>() is { } id ? new OAuthKey(id, o["clientSecret"]?.GetValue<string>()) : null;
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }
}

/// <summary>Порт и адрес возврата из браузера. Порт постоянный: Dropbox сверяет адрес возврата целиком. Тот же адрес, что у macOS-версии.</summary>
public static class OAuthRedirect
{
    public const int Port = 47811;
    public const string Path = "/oauth/callback";

    public static string Uri(int port = Port) => $"http://localhost:{port}{Path}";
}

/// <summary>Данные OAuth-клиента: вшитые при сборке или введённые пользователем.</summary>
public sealed record OAuthClient(OAuthProvider Provider, string ClientId, string? ClientSecret)
{
    /// <summary>Клиент из идентификатора (и секрета). Пустое значение или непрошедшая подстановка переменной сборки — null.</summary>
    public static OAuthClient? Create(OAuthProvider provider, string? clientId, string? clientSecret = null)
    {
        var id = (clientId ?? "").Trim();
        if (id.Length == 0 || id.StartsWith('$') || id.Contains(' '))
        {
            return null;
        }

        var secret = clientSecret?.Trim();
        if (string.IsNullOrEmpty(secret) || secret.StartsWith('$'))
        {
            secret = null;
        }

        return provider.NeedsClientSecret() && secret is null ? null : new OAuthClient(provider, id, secret);
    }

    public static OAuthClient? FromKey(OAuthProvider provider, OAuthKey key) => key.Problem(provider) is null ? Create(provider, key.ClientId, key.ClientSecret) : null;

    /// <summary>Ключ, вшитый при сборке, главнее введённого вручную: владелец сборки отвечает за свой ключ.</summary>
    public static OAuthClient? Resolve(OAuthClient? builtIn, OAuthProvider provider, OAuthKey? stored) =>
        builtIn ?? (stored is null ? null : FromKey(provider, stored));
}

/// <summary>Токены OAuth. Хранятся только в защищённом хранилище.</summary>
public sealed record OAuthToken(string AccessToken, string? RefreshToken, DateTimeOffset? ExpiresAt)
{
    /// <summary>Истёк или истечёт в ближайшую минуту.</summary>
    public bool IsExpired(DateTimeOffset now) => ExpiresAt is { } at && at - now < TimeSpan.FromMinutes(1);
}

public enum IntegrationFailure
{
    NotConfigured,
    Denied,
    StateMismatch,
    BadResponse,
    Http,
    InvalidUrl,
    Reauthorize,
    Busy,
}

public sealed class IntegrationException(IntegrationFailure failure, string message, int? status = null) : Exception(message)
{
    public IntegrationFailure Failure { get; } = failure;

    public int? Status { get; } = status;

    public static IntegrationException NotConfigured(OAuthProvider p) =>
        new(IntegrationFailure.NotConfigured, $"Не задан ключ приложения ({p.BuildVariable()}). Нажмите «Добавить ключ» и введите свой");

    public static IntegrationException Denied(string reason) => new(IntegrationFailure.Denied, "Вход отменён: " + reason);

    public static IntegrationException StateMismatch() =>
        new(IntegrationFailure.StateMismatch, "Ответ браузера не относится к этому входу. Попробуйте ещё раз");

    public static IntegrationException BadResponse(string text) => new(IntegrationFailure.BadResponse, "Непонятный ответ сервиса: " + text);

    public static IntegrationException HttpError(int status, string text) =>
        new(IntegrationFailure.Http, $"Сервис ответил ошибкой {status}{(text.Length == 0 ? "" : ": " + text)}", status);

    public static IntegrationException InvalidUrl() =>
        new(IntegrationFailure.InvalidUrl, "Неверный адрес сервера. Нужен адрес https:// (или http:// только для этого компьютера)");

    public static IntegrationException Reauthorize() => new(IntegrationFailure.Reauthorize, "Доступ к диску истёк. Подключите его заново");
}

public static class OAuthFlow
{
    private const string VerifierAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

    /// <summary>Адрес страницы входа с PKCE (S256). challenge = base64url(SHA-256(verifier)).</summary>
    public static Uri AuthorizeUrl(OAuthClient client, string state, string codeChallenge, int port = OAuthRedirect.Port)
    {
        var items = new List<(string, string)> {
            ("client_id", client.ClientId),
            ("redirect_uri", OAuthRedirect.Uri(port)),
            ("response_type", "code"),
            ("state", state),
            ("code_challenge", codeChallenge),
            ("code_challenge_method", "S256"),
        };
        if (client.Provider.Scope() is { } scope)
        {
            items.Add(("scope", scope));
        }

        items.AddRange(client.Provider.ExtraAuthorizeParams().Select(p => (p.Name, p.Value)));
        return new Uri(client.Provider.AuthorizeUrl() + "?" + Query(items));
    }

    /// <summary>Случайная строка для verifier и state: 43–128 символов из [A-Za-z0-9-._~] (RFC 7636).</summary>
    public static string RandomVerifier(int length = 64)
    {
        var n = Math.Max(43, Math.Min(length, 128));
        return string.Create(n, 0, (span, _) =>
        {
            for (var i = 0; i < span.Length; i++)
            {
                span[i] = VerifierAlphabet[RandomNumberGenerator.GetInt32(VerifierAlphabet.Length)];
            }
        });
    }

    public static string Base64Url(byte[] data) => Convert.ToBase64String(data).Replace('+', '-').Replace('/', '_').TrimEnd('=');

    public static string Challenge(string verifier) => Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

    public static HttpRequestSpec TokenRequest(OAuthClient client, string code, string verifier, int port = OAuthRedirect.Port)
    {
        var fields = new List<(string, string)> {
            ("grant_type", "authorization_code"), ("code", code), ("redirect_uri", OAuthRedirect.Uri(port)),
            ("client_id", client.ClientId), ("code_verifier", verifier),
        };
        if (client.ClientSecret is { } secret)
        {
            fields.Add(("client_secret", secret));
        }

        return Form(client.Provider.TokenUrl(), fields);
    }

    public static HttpRequestSpec RefreshRequest(OAuthClient client, string refreshToken)
    {
        var fields = new List<(string, string)> { ("grant_type", "refresh_token"), ("refresh_token", refreshToken), ("client_id", client.ClientId) };
        if (client.ClientSecret is { } secret)
        {
            fields.Add(("client_secret", secret));
        }

        if (client.Provider == OAuthProvider.Microsoft && client.Provider.Scope() is { } scope)
        {
            fields.Add(("scope", scope));
        }

        return Form(client.Provider.TokenUrl(), fields);
    }

    /// <summary>Ответ сервера токенов. refresh_token при обновлении может не прийти — тогда остаётся прежний.</summary>
    public static OAuthToken ParseToken(string json, DateTimeOffset now, string? previousRefresh = null)
    {
        JsonObject obj;
        try
        {
            obj = JsonNode.Parse(json) as JsonObject ?? throw new JsonException();
        }
        catch (JsonException)
        {
            throw IntegrationException.BadResponse(json.Length > 200 ? json[..200] : json);
        }

        if (obj["error"] is { } err)
        {
            var code = err.ToString();
            if (code == "invalid_grant")
            {
                throw IntegrationException.Reauthorize();
            }

            throw IntegrationException.Denied(obj["error_description"]?.ToString() ?? code);
        }

        var access = obj["access_token"]?.ToString();
        if (string.IsNullOrEmpty(access))
        {
            throw IntegrationException.BadResponse("нет access_token");
        }

        DateTimeOffset? expires = null;
        if (obj["expires_in"] is JsonValue v && double.TryParse(v.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var seconds))
        {
            expires = now.AddSeconds(seconds);
        }

        return new OAuthToken(access, obj["refresh_token"]?.ToString() ?? previousRefresh, expires);
    }

    private static HttpRequestSpec Form(Uri url, IEnumerable<(string, string)> fields)
    {
        var spec = new HttpRequestSpec {
            Url = url,
            Method = "POST",
            Body = Encoding.UTF8.GetBytes(Query(fields)),
            ContentType = "application/x-www-form-urlencoded",
        };
        spec.Headers["Accept"] = "application/json";
        return spec;
    }

    internal static string Query(IEnumerable<(string Name, string Value)> items) =>
        string.Join('&', items.Select(i => Uri.EscapeDataString(i.Name) + "=" + Uri.EscapeDataString(i.Value)));
}

/// <summary>Возврат из браузера на http://localhost:47811/oauth/callback?code=…&amp;state=….</summary>
public sealed record OAuthCallback(string? Code, string? State, string? Error)
{
    /// <summary>Разбирает первую строку HTTP-запроса («GET /oauth/callback?… HTTP/1.1»). Чужой путь — null.</summary>
    public static OAuthCallback? Parse(string requestLine)
    {
        var parts = requestLine.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2 || parts[0] != "GET" || !Uri.TryCreate("http://localhost" + parts[1], UriKind.Absolute, out var uri) || uri.AbsolutePath != OAuthRedirect.Path)
        {
            return null;
        }

        var query = new Dictionary<string, string>();
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = pair.Split('=', 2);
            query[Uri.UnescapeDataString(kv[0].Replace('+', ' '))] = kv.Length > 1 ? Uri.UnescapeDataString(kv[1].Replace('+', ' ')) : "";
        }

        string? Q(string name) => query.GetValueOrDefault(name);
        return new OAuthCallback(Q("code"), Q("state"), Q("error_description") ?? Q("error"));
    }

    /// <summary>Код, если вход разрешён и state совпал.</summary>
    public string Validated(string expectedState)
    {
        if (Error is { } error)
        {
            throw IntegrationException.Denied(error);
        }

        if (State != expectedState)
        {
            throw IntegrationException.StateMismatch();
        }

        return !string.IsNullOrEmpty(Code) ? Code : throw IntegrationException.BadResponse("нет кода авторизации");
    }
}

/// <summary>Сохранённое подключение диска (целиком в защищённом хранилище).</summary>
public sealed record DriveConnection(DriveService Service, OAuthToken? Token = null, string? WebDavUrl = null, string? Login = null,
    string? Password = null, DateTimeOffset? ConnectedAt = null)
{
    public string Encode()
    {
        var o = new JsonObject {
            ["service"] = Service.ToString(),
            ["webdavUrl"] = WebDavUrl,
            ["login"] = Login,
            ["password"] = Password,
            ["connectedAt"] = (ConnectedAt ?? DateTimeOffset.UtcNow).ToString("o", System.Globalization.CultureInfo.InvariantCulture),
        };
        if (Token is { } t)
        {
            o["token"] = new JsonObject {
                ["accessToken"] = t.AccessToken,
                ["refreshToken"] = t.RefreshToken,
                ["expiresAt"] = t.ExpiresAt?.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
            };
        }

        return o.ToJsonString();
    }

    public static DriveConnection? Decode(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        try
        {
            if (JsonNode.Parse(text) is not JsonObject o || !Enum.TryParse<DriveService>(o["service"]?.ToString(), out var service))
            {
                return null;
            }

            OAuthToken? token = null;
            if (o["token"] is JsonObject t && t["accessToken"]?.ToString() is { Length: > 0 } access)
            {
                token = new OAuthToken(access, t["refreshToken"]?.ToString(), DateTimeOffset.TryParse(t["expiresAt"]?.ToString(),
                    System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out var at) ? at : null);
            }

            return new DriveConnection(service, token, o["webdavUrl"]?.ToString(), o["login"]?.ToString(), o["password"]?.ToString(),
                DateTimeOffset.TryParse(o["connectedAt"]?.ToString(), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind, out var c) ? c : null);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    /// <summary>Имя записи в хранилище секретов: своё для каждого пользователя приложения и сервиса.</summary>
    public static string SecretName(DriveService service, string user) => $"integration.{service.Id().ToLowerInvariant()}.{user.ToLowerInvariant()}";
}

/// <summary>Запросы выгрузки файла. Папка на диске — «Customers».</summary>
public static class DriveUpload
{
    public const string Folder = "Customers";

    /// <summary>Проверка адреса WebDAV: https, либо http только на этом компьютере (MEGAcmd).</summary>
    public static Uri WebDavBase(string raw)
    {
        var s = raw.Trim();
        if (!s.EndsWith('/'))
        {
            s += "/";
        }

        if (!Uri.TryCreate(s, UriKind.Absolute, out var uri) || uri.Host.Length == 0 || uri.UserInfo.Length > 0)
        {
            throw IntegrationException.InvalidUrl();
        }

        var loopback = uri.IsLoopback;
        if (!(uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && loopback)))
        {
            throw IntegrationException.InvalidUrl();
        }

        return uri;
    }

    public static string BasicAuth(string login, string password) => "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes($"{login}:{password}"));

    /// <summary>Запросы по порядку: для WebDAV сначала MKCOL папки (405 — папка уже есть), потом PUT файла.</summary>
    public static IReadOnlyList<HttpRequestSpec> Requests(DriveConnection c, string fileName, byte[] data)
    {
        var name = fileName.Replace('/', '_').Replace('\\', '_');
        var auth = c.Service.Auth();
        if (auth.OAuth is not { } provider)
        {
            var dir = new Uri(WebDavBase(c.WebDavUrl ?? ""), Folder + "/");
            var mkcol = new HttpRequestSpec { Url = dir, Method = "MKCOL" };
            var put = new HttpRequestSpec {
                Url = new Uri(dir, Uri.EscapeDataString(name)),
                Method = "PUT",
                Body = data,
                ContentType = "application/octet-stream",
            };
            if (!string.IsNullOrEmpty(c.Login))
            {
                var header = BasicAuth(c.Login, c.Password ?? "");
                mkcol.Headers["Authorization"] = header;
                put.Headers["Authorization"] = header;
            }

            return [mkcol, put];
        }

        var token = c.Token ?? throw IntegrationException.Reauthorize();
        HttpRequestSpec request;
        switch (provider)
        {
            case OAuthProvider.Google:
                var boundary = "lg-" + Guid.NewGuid().ToString("N");
                var meta = new JsonObject { ["name"] = $"{Folder} {name}" }.ToJsonString();
                using (var body = new MemoryStream())
                {
                    void Write(string text) => body.Write(Encoding.UTF8.GetBytes(text));
                    Write($"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n");
                    body.Write(data);
                    Write($"\r\n--{boundary}--\r\n");
                    request = new HttpRequestSpec {
                        Url = new Uri("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"),
                        Method = "POST",
                        Body = body.ToArray(),
                        ContentType = "multipart/related; boundary=" + boundary,
                    };
                }

                break;
            case OAuthProvider.Dropbox:
                request = new HttpRequestSpec {
                    Url = new Uri("https://content.dropboxapi.com/2/files/upload"),
                    Method = "POST",
                    Body = data,
                    ContentType = "application/octet-stream",
                };
                request.Headers["Dropbox-API-Arg"] = AsciiJson(new JsonObject { ["autorename"] = true, ["mode"] = "add", ["path"] = $"/{Folder}/{name}" });
                break;
            default:
                var path = string.Join('/', $"{Folder}/{name}".Split('/').Select(Uri.EscapeDataString));
                request = new HttpRequestSpec {
                    Url = new Uri($"https://graph.microsoft.com/v1.0/me/drive/special/approot:/{path}:/content"),
                    Method = "PUT",
                    Body = data,
                    ContentType = "application/octet-stream",
                };
                break;
        }

        request.Headers["Authorization"] = "Bearer " + token.AccessToken;
        return [request];
    }

    /// <summary>Ответ на запрос выгрузки — успех? MKCOL: 405/301 значат «папка уже есть».</summary>
    public static bool IsSuccess(HttpRequestSpec request, int status) =>
        request.Method == "MKCOL" ? status is >= 200 and < 300 or 405 or 301 : status is >= 200 and < 300;

    /// <summary>JSON только из ASCII: Dropbox требует экранировать не-ASCII символы в заголовке (\uXXXX).</summary>
    public static string AsciiJson(JsonObject o)
    {
        var text = o.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        var sb = new StringBuilder();
        foreach (var ch in text)
        {
            if (ch < 0x80)
            {
                sb.Append(ch);
            }
            else
            {
                sb.Append("\\u").Append(((int)ch).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
            }
        }

        return sb.ToString();
    }
}

/// <summary>Сетевая часть дисков: обмен кода на токены, обновление токена, проверка WebDAV и выгрузка файла.</summary>
public sealed class DriveClient(IHttpTransport http, Func<DateTimeOffset>? clock = null)
{
    private readonly Func<DateTimeOffset> _now = clock ?? (() => DateTimeOffset.UtcNow);

    public async Task<OAuthToken> ExchangeCodeAsync(OAuthClient client, string code, string verifier, int port, CancellationToken ct)
    {
        var reply = await http.SendAsync(OAuthFlow.TokenRequest(client, code, verifier, port), ct).ConfigureAwait(false);
        Check(reply);
        return OAuthFlow.ParseToken(reply.Text, _now());
    }

    /// <summary>Подключение с токеном, который действует хотя бы минуту: при необходимости обновляется. Возвращает то же подключение, если обновлять не нужно.</summary>
    public async Task<DriveConnection> EnsureFreshAsync(DriveConnection c, OAuthClient? client, CancellationToken ct)
    {
        if (c.Token is not { } token || !token.IsExpired(_now()))
        {
            return c;
        }

        var provider = c.Service.Auth().OAuth ?? throw IntegrationException.Reauthorize();
        if (client is null)
        {
            throw IntegrationException.NotConfigured(provider);
        }

        var refresh = token.RefreshToken ?? throw IntegrationException.Reauthorize();
        var reply = await http.SendAsync(OAuthFlow.RefreshRequest(client, refresh), ct).ConfigureAwait(false);
        if (reply.Status is 400 or 401)
        {
            throw IntegrationException.Reauthorize();
        }

        Check(reply);
        return c with { Token = OAuthFlow.ParseToken(reply.Text, _now(), refresh) };
    }

    /// <summary>Проверяет адрес и пароль запросом PROPFIND.</summary>
    public async Task<string> ProbeWebDavAsync(string url, string login, string password, CancellationToken ct)
    {
        var baseUrl = DriveUpload.WebDavBase(url);
        var request = new HttpRequestSpec { Url = baseUrl, Method = "PROPFIND", Timeout = TimeSpan.FromSeconds(20) };
        request.Headers["Depth"] = "0";
        if (login.Length > 0)
        {
            request.Headers["Authorization"] = DriveUpload.BasicAuth(login, password);
        }

        var reply = await http.SendAsync(request, ct).ConfigureAwait(false);
        if (reply.Status is 401 or 403)
        {
            throw IntegrationException.HttpError(reply.Status, "неверный логин или пароль приложения");
        }

        if (reply.Status is not (>= 200 and < 300 or 207))
        {
            Check(reply);
        }

        return baseUrl.AbsoluteUri;
    }

    public async Task UploadAsync(DriveConnection c, string fileName, byte[] data, CancellationToken ct)
    {
        foreach (var request in DriveUpload.Requests(c, fileName, data))
        {
            request.Timeout = TimeSpan.FromMinutes(5);
            var reply = await http.SendAsync(request, ct).ConfigureAwait(false);
            if (reply.Status == 401)
            {
                throw IntegrationException.Reauthorize();
            }

            if (!DriveUpload.IsSuccess(request, reply.Status))
            {
                throw IntegrationException.HttpError(reply.Status, Shorten(reply.Text));
            }
        }
    }

    private static void Check(HttpResult reply)
    {
        if (reply.Status is < 200 or >= 300)
        {
            throw IntegrationException.HttpError(reply.Status, Shorten(reply.Text));
        }
    }

    private static string Shorten(string text)
    {
        var t = text.Trim();
        return t.Length > 200 ? t[..200] : t;
    }
}

/// <summary>
/// HttpClient без ограничений на перенаправления и адреса: для облачных дисков, где адрес вводит сам пользователь
/// (в том числе 127.0.0.1 для MEGAcmd). Ответ с любым кодом возвращается как есть. Поисковым источникам этот транспорт не нужен.
/// </summary>
public sealed class DirectHttpTransport : IHttpTransport, IDisposable
{
    private readonly HttpClient _client = new(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = Timeout.InfiniteTimeSpan };

    public void Dispose() => _client.Dispose();

    public async Task<HttpResult> SendAsync(HttpRequestSpec request, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(request.Timeout);
        using var msg = new HttpRequestMessage(new HttpMethod(request.Method), request.Url);
        foreach (var (k, v) in request.Headers)
        {
            msg.Headers.TryAddWithoutValidation(k, v);
        }

        if (request.Body is not null)
        {
            msg.Content = new ByteArrayContent(request.Body);
            if (request.ContentType is not null)
            {
                msg.Content.Headers.TryAddWithoutValidation("Content-Type", request.ContentType);
            }
        }

        try
        {
            using var resp = await _client.SendAsync(msg, HttpCompletionOption.ResponseContentRead, cts.Token).ConfigureAwait(false);
            var data = await resp.Content.ReadAsByteArrayAsync(cts.Token).ConfigureAwait(false);
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var h in resp.Headers)
            {
                headers[h.Key] = string.Join(", ", h.Value);
            }

            return new HttpResult((int)resp.StatusCode, data, headers, request.Url);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new HttpFailure("таймаут запроса", null, transient: true);
        }
        catch (HttpRequestException e)
        {
            throw new HttpFailure(e.Message, null, transient: true);
        }
    }
}
