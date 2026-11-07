namespace Customers.Presentation;

/// <summary>
/// Подключённые облачные диски пользователя: вход, отключение, выгрузка копии базы. Токены и пароли лежат только
/// в защищённом хранилище (запись на пользователя и сервис), ключи OAuth-приложений — одна запись на этом компьютере.
/// </summary>
public sealed class IntegrationsModel : ObservableObject
{
    /// <summary>Сколько ждать возврата из браузера, прежде чем отменить вход.</summary>
    public static readonly TimeSpan LoginTimeout = TimeSpan.FromMinutes(5);

    private readonly AppEnvironment _env;
    private readonly string _user;
    private readonly Dictionary<DriveService, DriveConnection> _connections = [];
    private readonly Dictionary<OAuthProvider, OAuthKey> _keys = [];
    private CancellationTokenSource? _login;
    private DriveService? _busy;
    private string? _message;
    private string? _error;
    private string? _loginUrl;
    private bool _cancelledByUser;

    public IntegrationsModel(AppEnvironment env, string user)
    {
        _env = env;
        _user = user.ToLowerInvariant();
        Reload();
    }

    public IReadOnlyDictionary<DriveService, DriveConnection> Connections => _connections;

    /// <summary>Сервис, у которого идёт вход или выгрузка.</summary>
    public DriveService? Busy { get => _busy; private set => Set(ref _busy, value); }

    public string? Message { get => _message; private set => Set(ref _message, value); }

    public string? Error { get => _error; private set => Set(ref _error, value); }

    /// <summary>Адрес страницы входа, пока ждём браузер: показывается, чтобы его можно было открыть вручную, если браузер не запустился.</summary>
    public string? LoginUrl { get => _loginUrl; private set => Set(ref _loginUrl, value); }

    public void ReportError(string text) => Error = text;

    public void Reload()
    {
        _connections.Clear();
        foreach (var s in Enum.GetValues<DriveService>())
        {
            if (DriveConnection.Decode(_env.Secrets.Get(DriveConnection.SecretName(s, _user))) is { } c && c.Service == s)
            {
                _connections[s] = c;
            }
        }

        _keys.Clear();
        foreach (var p in Enum.GetValues<OAuthProvider>())
        {
            if (OAuthKey.Decode(_env.Secrets.Get(p.SecretName())) is { } key)
            {
                _keys[p] = key;
            }
        }

        Raise(nameof(Connections));
    }

    // MARK: Ключи приложений

    public OAuthKey? Key(OAuthProvider p) => _keys.GetValueOrDefault(p);

    /// <summary>Клиент OAuth: ключ сборки или введённый вручную.</summary>
    public OAuthClient? Client(OAuthProvider p) => OAuthClient.Resolve(_env.BuiltInOAuth(p), p, Key(p));

    /// <summary>Ключ вшит в сборку: менять и удалять его из приложения нельзя.</summary>
    public bool IsBuiltIn(OAuthProvider p) => _env.BuiltInOAuth(p) is not null;

    /// <summary>Введённый пользователем ключ можно изменить или удалить; вшитый в сборку — нет.</summary>
    public bool HasOwnKey(OAuthProvider p) => _keys.ContainsKey(p) && !IsBuiltIn(p);

    /// <summary>Сохраняет ключ. Возвращает текст ошибки или null.</summary>
    public string? SaveKey(OAuthProvider p, OAuthKey key)
    {
        var clean = new OAuthKey(key.ClientId.Trim(), p.NeedsClientSecret() ? key.ClientSecret?.Trim() : null);
        if (clean.Problem(p) is { } problem)
        {
            return problem;
        }

        _env.Secrets.Set(p.SecretName(), clean.Encode());
        _keys[p] = clean;
        Message = "Ключ сохранён";
        Raise(nameof(Connections));
        return null;
    }

    /// <summary>Удаляет введённый ключ и подключения, сделанные с ним: токены без ключа бесполезны.</summary>
    public void RemoveKey(OAuthProvider p)
    {
        _env.Secrets.Delete(p.SecretName());
        _keys.Remove(p);
        var service = p.Service();
        if (IsConnected(service))
        {
            Disconnect(service);
        }

        Message = "Ключ удалён";
        Raise(nameof(Connections));
    }

    // MARK: Подключения

    public bool IsConnected(DriveService s) => _connections.ContainsKey(s);

    /// <summary>Можно ли подключить сервис в этой сборке (для OAuth нужен ключ приложения).</summary>
    public bool IsAvailable(DriveService s) => s.Auth().OAuth is not { } p || Client(p) is not null;

    private void Save(DriveConnection c)
    {
        _env.Secrets.Set(DriveConnection.SecretName(c.Service, _user), c.Encode());
        _connections[c.Service] = c;
        Raise(nameof(Connections));
    }

    public void Disconnect(DriveService s)
    {
        _env.Secrets.Delete(DriveConnection.SecretName(s, _user));
        _connections.Remove(s);
        Message = $"{s.Title()} отключён";
        Error = null;
        Raise(nameof(Connections));
    }

    /// <summary>Отмена входа: сервер возврата закрывается, порт освобождается.</summary>
    public void CancelLogin()
    {
        _cancelledByUser = true;
        _login?.Cancel();
    }

    /// <summary>Забывает все записи пользователя при удалении учётной записи.</summary>
    public static void ForgetUser(ISecretStore secrets, string user)
    {
        foreach (var s in Enum.GetValues<DriveService>())
        {
            secrets.Delete(DriveConnection.SecretName(s, user));
        }

        secrets.Delete(MailModel.PasswordSecret(user));
    }

    // MARK: Вход через браузер (OAuth + PKCE)

    public async Task<bool> ConnectOAuthAsync(DriveService s)
    {
        if (s.Auth().OAuth is not { } provider || Busy is not null)
        {
            return false;
        }

        if (Client(provider) is not { } client)
        {
            Error = IntegrationException.NotConfigured(provider).Message;
            return false;
        }

        Busy = s;
        Error = null;
        Message = null;
        _cancelledByUser = false;
        using var cts = new CancellationTokenSource(LoginTimeout);
        _login = cts;
        try
        {
            using var listener = _env.OAuthListener();
            var verifier = OAuthFlow.RandomVerifier();
            var state = OAuthFlow.RandomVerifier(43);
            var wait = listener.WaitForCallbackAsync(cts.Token);
            var url = OAuthFlow.AuthorizeUrl(client, state, OAuthFlow.Challenge(verifier), listener.Port);
            LoginUrl = url.AbsoluteUri;
            if (!await _env.OpenBrowser(url).ConfigureAwait(true))
            {
                Message = "Браузер не открылся сам. Скопируйте ссылку для входа и откройте её вручную.";
            }

            var callback = await wait.ConfigureAwait(true);
            var code = callback.Validated(state);
            using var http = Disposable(_env.DriveHttp());
            var token = await new DriveClient(http.Value).ExchangeCodeAsync(client, code, verifier, listener.Port, cts.Token).ConfigureAwait(true);
            Save(new DriveConnection(s, token, ConnectedAt: DateTimeOffset.UtcNow));
            Message = $"{s.Title()} подключён";
            return true;
        }
        catch (OperationCanceledException)
        {
            Message = _cancelledByUser ? "Вход отменён" : null;
            Error = _cancelledByUser ? null : $"{s.Title()}: время ожидания входа ({(int)LoginTimeout.TotalMinutes} мин) истекло";
            return false;
        }
        catch (Exception e) when (e is IntegrationException or HttpFailure or IOException)
        {
            Error = $"{s.Title()}: {e.Message}";
            return false;
        }
        finally
        {
            _login = null;
            LoginUrl = null;
            Busy = null;
        }
    }

    // MARK: WebDAV

    /// <summary>Проверяет адрес и пароль запросом PROPFIND и сохраняет подключение.</summary>
    public async Task<bool> ConnectWebDavAsync(DriveService s, string url, string login, string password)
    {
        if (Busy is not null)
        {
            return false;
        }

        Busy = s;
        Error = null;
        Message = null;
        try
        {
            using var http = Disposable(_env.DriveHttp());
            var normalized = await new DriveClient(http.Value).ProbeWebDavAsync(url, login.Trim(), password, CancellationToken.None).ConfigureAwait(true);
            Save(new DriveConnection(s, WebDavUrl: normalized, Login: login.Trim(), Password: password, ConnectedAt: DateTimeOffset.UtcNow));
            Message = $"{s.Title()} подключён";
            return true;
        }
        catch (Exception e) when (e is IntegrationException or HttpFailure)
        {
            Error = $"{s.Title()}: {e.Message}";
            return false;
        }
        finally
        {
            Busy = null;
        }
    }

    // MARK: Выгрузка

    /// <summary>Выгружает файл (копию базы) на диск. OAuth-токен при необходимости обновляется.</summary>
    public async Task<bool> UploadAsync(string file, DriveService s)
    {
        if (!_connections.TryGetValue(s, out var connection) || Busy is not null)
        {
            return false;
        }

        Busy = s;
        Error = null;
        Message = null;
        try
        {
            var data = await File.ReadAllBytesAsync(file).ConfigureAwait(true);
            using var http = Disposable(_env.DriveHttp());
            var client = new DriveClient(http.Value);
            var provider = s.Auth().OAuth;
            var fresh = await client.EnsureFreshAsync(connection, provider is { } p ? Client(p) : null, CancellationToken.None).ConfigureAwait(true);
            if (!ReferenceEquals(fresh, connection))
            {
                Save(fresh);
            }

            await client.UploadAsync(fresh, Path.GetFileName(file), data, CancellationToken.None).ConfigureAwait(true);
            Message = $"Копия «{Path.GetFileName(file)}» выгружена в {s.Title()}";
            return true;
        }
        catch (IntegrationException e) when (e.Failure == IntegrationFailure.Reauthorize)
        {
            Error = $"{s.Title()}: {e.Message}";
            return false;
        }
        catch (Exception e) when (e is IntegrationException or HttpFailure or IOException or UnauthorizedAccessException)
        {
            Error = $"{s.Title()}: {e.Message}";
            return false;
        }
        finally
        {
            Busy = null;
        }
    }

    private static Held<IHttpTransport> Disposable(IHttpTransport transport) => new(transport);

    private readonly struct Held<T>(T value) : IDisposable
        where T : class
    {
        public T Value => value;

        public void Dispose() => (value as IDisposable)?.Dispose();
    }
}
