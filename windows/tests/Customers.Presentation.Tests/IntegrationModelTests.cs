using System.Text;

namespace Customers.Presentation.Tests;

internal sealed class RecordingHttp(Func<HttpRequestSpec, HttpResult> handler) : IHttpTransport
{
    public List<HttpRequestSpec> Requests { get; } = [];

    public Task<HttpResult> SendAsync(HttpRequestSpec request, CancellationToken ct)
    {
        lock (Requests)
        {
            Requests.Add(request);
        }

        return Task.FromResult(handler(request));
    }

    public static HttpResult Json(string body, int status = 200) => new(status, Encoding.UTF8.GetBytes(body), new Dictionary<string, string>(), null);
}

internal sealed class FakeListener : IOAuthListener
{
    public TaskCompletionSource<OAuthCallback> Reply { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public bool Disposed { get; private set; }

    public int Port => 47811;

    public Task<OAuthCallback> WaitForCallbackAsync(CancellationToken ct)
    {
        ct.Register(() => Reply.TrySetCanceled(ct));
        return Reply.Task;
    }

    public void Dispose() => Disposed = true;
}

public class IntegrationsModelTests : IDisposable
{
    private readonly Sandbox _box = new();
    private readonly MemorySecretStore _secrets = new();

    public void Dispose() => _box.Dispose();

    private AppEnvironment Env(IHttpTransport? http = null, FakeListener? listener = null, Func<Uri, Task<bool>>? browser = null, OAuthClient? builtIn = null) =>
        AppEnvironment.ForTests(_box.Root, secrets: _secrets, driveHttp: () => http ?? new RecordingHttp(_ => RecordingHttp.Json("{}", 500)),
            oauthListener: () => listener ?? new FakeListener(), openBrowser: browser,
            builtInOAuth: p => builtIn is not null && builtIn.Provider == p ? builtIn : null);

    private static string Query(Uri url, string name) =>
        url.Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).First(p => p[0] == name)[1];

    [Fact]
    public async Task OAuthSignInStoresConnectionAndSurvivesRestart()
    {
        var http = new RecordingHttp(r => RecordingHttp.Json("""{"access_token":"AT","refresh_token":"RT","expires_in":3600}"""));
        var listener = new FakeListener();
        Uri? opened = null;
        var env = Env(http, listener, url =>
        {
            opened = url;
            listener.Reply.SetResult(new OAuthCallback("the-code", Uri.UnescapeDataString(Query(url, "state")), null));
            return Task.FromResult(true);
        });
        var model = new IntegrationsModel(env, "Maks");
        Assert.False(model.IsAvailable(DriveService.Dropbox));
        Assert.Null(model.SaveKey(OAuthProvider.Dropbox, new OAuthKey(" my-key ")));
        Assert.True(model.IsAvailable(DriveService.Dropbox));

        Assert.True(await model.ConnectOAuthAsync(DriveService.Dropbox));
        Assert.Null(model.Busy);
        Assert.Null(model.Error);
        Assert.True(listener.Disposed);
        Assert.Contains("my-key", opened!.Query);
        var token = Assert.Single(http.Requests);
        var body = Encoding.UTF8.GetString(token.Body!);
        Assert.Contains("code=the-code", body);
        var verifier = body.Split('&').First(p => p.StartsWith("code_verifier=")).Split('=')[1];
        Assert.Equal(OAuthFlow.Challenge(verifier), Uri.UnescapeDataString(Query(opened, "code_challenge")));

        var again = new IntegrationsModel(env, "maks");
        Assert.Equal("AT", again.Connections[DriveService.Dropbox].Token!.AccessToken);
        Assert.Null(new IntegrationsModel(env, "someone-else").Connections.GetValueOrDefault(DriveService.Dropbox));

        again.Disconnect(DriveService.Dropbox);
        Assert.False(new IntegrationsModel(env, "maks").IsConnected(DriveService.Dropbox));
    }

    [Fact]
    public async Task SignInWithoutKeyExplainsWhatToDo()
    {
        var opened = false;
        var model = new IntegrationsModel(Env(browser: _ =>
        {
            opened = true;
            return Task.FromResult(true);
        }), "maks");
        Assert.False(await model.ConnectOAuthAsync(DriveService.GoogleDrive));
        Assert.Contains("GOOGLE_OAUTH_CLIENT_ID", model.Error);
        Assert.False(opened);
    }

    [Fact]
    public async Task ForeignStateIsRejected()
    {
        var listener = new FakeListener();
        var model = new IntegrationsModel(Env(listener: listener, browser: _ =>
        {
            listener.Reply.SetResult(new OAuthCallback("c", "not-my-state", null));
            return Task.FromResult(true);
        }, builtIn: OAuthClient.Create(OAuthProvider.Microsoft, "ms")), "maks");
        Assert.False(await model.ConnectOAuthAsync(DriveService.OneDrive));
        Assert.Contains("не относится к этому входу", model.Error);
        Assert.False(model.IsConnected(DriveService.OneDrive));
    }

    [Fact]
    public async Task UserCanCancelWaitingForTheBrowser()
    {
        var listener = new FakeListener();
        IntegrationsModel? model = null;
        model = new IntegrationsModel(Env(listener: listener, browser: _ =>
        {
            Assert.NotNull(model!.LoginUrl);
            model.CancelLogin();
            return Task.FromResult(true);
        }, builtIn: OAuthClient.Create(OAuthProvider.Dropbox, "k")), "maks");
        Assert.False(await model.ConnectOAuthAsync(DriveService.Dropbox));
        Assert.Equal("Вход отменён", model.Message);
        Assert.Null(model.Error);
        Assert.Null(model.Busy);
        Assert.Null(model.LoginUrl);
        Assert.True(listener.Disposed);
    }

    [Fact]
    public async Task BrowserThatWillNotOpenLeavesTheLinkForManualUse()
    {
        var listener = new FakeListener();
        IntegrationsModel? model = null;
        string? link = null;
        model = new IntegrationsModel(Env(listener: listener, browser: _ =>
        {
            link = model!.LoginUrl;
            model.CancelLogin();
            return Task.FromResult(false);
        }, builtIn: OAuthClient.Create(OAuthProvider.Dropbox, "k")), "maks");
        await model.ConnectOAuthAsync(DriveService.Dropbox);
        Assert.StartsWith("https://www.dropbox.com/oauth2/authorize", link);
    }

    [Fact]
    public async Task OnlyOneOperationAtATime()
    {
        var listener = new FakeListener();
        IntegrationsModel? model = null;
        var second = true;
        model = new IntegrationsModel(Env(listener: listener, browser: async _ =>
        {
            second = await model!.ConnectOAuthAsync(DriveService.Dropbox);
            model.CancelLogin();
            return true;
        }, builtIn: OAuthClient.Create(OAuthProvider.Dropbox, "k")), "maks");
        await model.ConnectOAuthAsync(DriveService.Dropbox);
        Assert.False(second);
    }

    [Fact]
    public void KeysAreValidatedAndBuiltInKeysAreProtected()
    {
        var model = new IntegrationsModel(Env(builtIn: OAuthClient.Create(OAuthProvider.Dropbox, "built")), "maks");
        Assert.True(model.IsBuiltIn(OAuthProvider.Dropbox));
        Assert.False(model.HasOwnKey(OAuthProvider.Dropbox));
        Assert.NotNull(model.SaveKey(OAuthProvider.Google, new OAuthKey("id")));
        Assert.NotNull(model.SaveKey(OAuthProvider.Google, new OAuthKey("with space", "s")));
        Assert.Null(model.SaveKey(OAuthProvider.Google, new OAuthKey("id", "secret")));
        Assert.True(model.HasOwnKey(OAuthProvider.Google));
        Assert.Equal("id", new IntegrationsModel(Env(), "other").Key(OAuthProvider.Google)!.ClientId);
        Assert.Equal("built", model.Client(OAuthProvider.Dropbox)!.ClientId);

        model.RemoveKey(OAuthProvider.Google);
        Assert.Null(new IntegrationsModel(Env(), "other").Key(OAuthProvider.Google));
    }

    [Fact]
    public async Task RemovingTheKeyDisconnectsItsDrive()
    {
        var env = Env(new RecordingHttp(_ => RecordingHttp.Json("{}")));
        var model = new IntegrationsModel(env, "maks");
        model.SaveKey(OAuthProvider.Dropbox, new OAuthKey("k"));
        _secrets.Set(DriveConnection.SecretName(DriveService.Dropbox, "maks"), new DriveConnection(DriveService.Dropbox, new OAuthToken("a", "r", null)).Encode());
        model.Reload();
        Assert.True(model.IsConnected(DriveService.Dropbox));
        model.RemoveKey(OAuthProvider.Dropbox);
        Assert.False(model.IsConnected(DriveService.Dropbox));
        await Task.CompletedTask;
    }

    [Fact]
    public async Task WebDavIsCheckedBeforeItIsSaved()
    {
        var wrong = new IntegrationsModel(Env(new RecordingHttp(_ => RecordingHttp.Json("", 401))), "maks");
        Assert.False(await wrong.ConnectWebDavAsync(DriveService.PCloud, "https://ewebdav.pcloud.com", "me", "bad"));
        Assert.Contains("неверный логин", wrong.Error);
        Assert.False(wrong.IsConnected(DriveService.PCloud));

        var insecure = new IntegrationsModel(Env(), "maks");
        Assert.False(await insecure.ConnectWebDavAsync(DriveService.WebDav, "http://example.com/dav", "me", "pw"));
        Assert.Contains("Неверный адрес", insecure.Error);

        var http = new RecordingHttp(_ => RecordingHttp.Json("", 207));
        var good = new IntegrationsModel(Env(http), "maks");
        Assert.True(await good.ConnectWebDavAsync(DriveService.WebDav, "https://dav.example.ru/x", " me ", "pw"));
        Assert.Equal("me", good.Connections[DriveService.WebDav].Login);
        Assert.Equal("https://dav.example.ru/x/", good.Connections[DriveService.WebDav].WebDavUrl);
        Assert.True(new IntegrationsModel(Env(), "maks").IsConnected(DriveService.WebDav));
    }

    [Fact]
    public async Task UploadRefreshesExpiredTokenAndSendsTheFile()
    {
        var http = new RecordingHttp(r => r.Url.Host switch
        {
            "api.dropboxapi.com" => RecordingHttp.Json("""{"access_token":"NEW","expires_in":3600}"""),
            _ => RecordingHttp.Json("{}"),
        });
        var env = Env(http, builtIn: OAuthClient.Create(OAuthProvider.Dropbox, "k"));
        _secrets.Set(DriveConnection.SecretName(DriveService.Dropbox, "maks"),
            new DriveConnection(DriveService.Dropbox, new OAuthToken("OLD", "RT", DateTimeOffset.UtcNow.AddMinutes(-5))).Encode());
        var model = new IntegrationsModel(env, "maks");
        var file = Path.Combine(_box.Root, "копия.db");
        Directory.CreateDirectory(_box.Root);
        File.WriteAllBytes(file, [9, 8, 7]);

        Assert.True(await model.UploadAsync(file, DriveService.Dropbox));
        Assert.Equal(["POST", "POST"], http.Requests.Select(r => r.Method));
        Assert.Equal("Bearer NEW", http.Requests[1].Headers["Authorization"]);
        Assert.Equal([9, 8, 7], http.Requests[1].Body);
        Assert.Equal("NEW", new IntegrationsModel(env, "maks").Connections[DriveService.Dropbox].Token!.AccessToken);
        Assert.Equal("RT", new IntegrationsModel(env, "maks").Connections[DriveService.Dropbox].Token!.RefreshToken);
        Assert.Contains("выгружена в Dropbox", model.Message);
    }

    [Fact]
    public async Task UploadErrorsAreReportedNotThrown()
    {
        var env = Env(new RecordingHttp(_ => RecordingHttp.Json("quota", 507)));
        _secrets.Set(DriveConnection.SecretName(DriveService.WebDav, "maks"), new DriveConnection(DriveService.WebDav, WebDavUrl: "https://dav.example/", Login: "a", Password: "b").Encode());
        var model = new IntegrationsModel(env, "maks");
        var file = Path.Combine(_box.Root, "a.db");
        Directory.CreateDirectory(_box.Root);
        File.WriteAllBytes(file, [1]);
        Assert.False(await model.UploadAsync(file, DriveService.WebDav));
        Assert.Contains("507", model.Error);
        Assert.False(await model.UploadAsync(Path.Combine(_box.Root, "missing.db"), DriveService.WebDav));
        Assert.NotNull(model.Error);
        Assert.False(await model.UploadAsync(file, DriveService.Mega)); // не подключён
    }

    [Fact]
    public async Task BackupOfTheDatabaseCanBeUploadedFromTheAppModel()
    {
        var http = new RecordingHttp(r => RecordingHttp.Json("", 201));
        var env = Env(http);
        var model = new AppModel(env, "maks", "maks", false, Path.Combine(_box.Root, "users", "maks"));
        Data.Seed(model);
        Assert.False(await model.Drives.UploadAsync("x", DriveService.WebDav)); // ещё не подключён
        Assert.True(await model.Drives.ConnectWebDavAsync(DriveService.WebDav, "https://dav.example/root", "u", "p"));
        Assert.True(await model.UploadBackupAsync(DriveService.WebDav));
        var put = http.Requests.Last(r => r.Method == "PUT");
        Assert.Contains("/root/Customers/", put.Url.AbsoluteUri);
        Assert.Equal(File.ReadAllBytes(model.BackupFiles[0].Path), put.Body);
        Assert.Equal(DriveUpload.BasicAuth("u", "p"), put.Headers["Authorization"]);
        model.Shutdown();
    }

    [Fact]
    public void ForgettingAUserRemovesTheirSecrets()
    {
        _secrets.Set(DriveConnection.SecretName(DriveService.Dropbox, "maks"), "x");
        _secrets.Set(MailModel.PasswordSecret("maks"), "pw");
        _secrets.Set(DriveConnection.SecretName(DriveService.Dropbox, "other"), "y");
        IntegrationsModel.ForgetUser(_secrets, "Maks");
        Assert.Null(_secrets.Get(DriveConnection.SecretName(DriveService.Dropbox, "maks")));
        Assert.Null(_secrets.Get(MailModel.PasswordSecret("maks")));
        Assert.Equal("y", _secrets.Get(DriveConnection.SecretName(DriveService.Dropbox, "other")));
    }
}

public class MailModelTests : IDisposable
{
    private readonly Sandbox _box = new();
    private readonly MemorySecretStore _secrets = new();

    public void Dispose() => _box.Dispose();

    private sealed class Script : ISmtpTransport
    {
        private readonly Queue<byte[]> _in = new();
        private bool _data;

        public Script(Func<string, string> reply)
        {
            Reply = reply;
            _in.Enqueue(Encoding.UTF8.GetBytes("220 hi\r\n"));
        }

        public Func<string, string> Reply { get; }

        public List<string> Lines { get; } = [];

        public Task<byte[]> ReceiveAsync(CancellationToken ct) => Task.FromResult(_in.Count > 0 ? _in.Dequeue() : []);

        public Task SendAsync(byte[] data, CancellationToken ct)
        {
            var text = Encoding.UTF8.GetString(data);
            if (_data)
            {
                if (text.EndsWith("\r\n.\r\n", StringComparison.Ordinal))
                {
                    _data = false;
                    _in.Enqueue(Encoding.UTF8.GetBytes("250 ok\r\n"));
                }

                return Task.CompletedTask;
            }

            foreach (var line in text.Split("\r\n", StringSplitOptions.RemoveEmptyEntries))
            {
                Lines.Add(line);
                _data = line == "DATA";
                _in.Enqueue(Encoding.UTF8.GetBytes(Reply(line)));
            }

            return Task.CompletedTask;
        }

        public Task StartTlsAsync(CancellationToken ct) => Task.CompletedTask;

        public void Close()
        {
        }
    }

    private static string Server(string line) => line switch {
        _ when line.StartsWith("EHLO") => "250-x\r\n250 AUTH PLAIN\r\n",
        _ when line.StartsWith("AUTH") => "235 ok\r\n",
        "DATA" => "354 go\r\n",
        "QUIT" => "221 bye\r\n",
        _ => "250 ok\r\n",
    };

    private (AppModel Model, List<(string Host, int Port, bool Tls)> Connections, Script Script) Open(Func<string, string>? server = null)
    {
        var script = new Script(server ?? Server);
        var connections = new List<(string, int, bool)>();
        var env = AppEnvironment.ForTests(_box.Root, secrets: _secrets, smtp: (h, p, t) =>
        {
            connections.Add((h, p, t));
            return script;
        });
        return (new AppModel(env, "maks", "maks", false, Path.Combine(_box.Root, "users", "maks")), connections, script);
    }

    [Fact]
    public async Task SettingsPasswordAndSendingWorkTogether()
    {
        var (model, connections, script) = Open();
        var mail = model.Mail;
        Assert.Equal(MailDelivery.MailApp, mail.Delivery);
        Assert.False(mail.SmtpReady);
        Assert.False(await mail.SendAsync(new OutgoingMail("a@b.ru", "s", "b")));
        Assert.Contains("не настроена", mail.LastError);

        mail.Account = MailAccount.Preset("me@gmail.com", "Максим");
        mail.Delivery = MailDelivery.Smtp;
        Assert.False(mail.SmtpReady);
        Assert.False(await mail.SendAsync(new OutgoingMail("a@b.ru", "s", "b")));
        Assert.Contains("пароль приложения", mail.LastError);

        mail.SetPassword("app-password");
        Assert.True(mail.SmtpReady);
        Assert.True(await mail.SendAsync(new OutgoingMail("a@b.ru", "Тема", "Текст")));
        Assert.Equal("Письмо отправлено на a@b.ru", mail.LastResult);
        Assert.Equal(("smtp.gmail.com", 465, true), connections.Single());
        Assert.Contains("RCPT TO:<a@b.ru>", script.Lines);
        Assert.False(mail.Sending);

        // Настройки и пароль переживают перезапуск; пароль не попадает в файл настроек.
        model.Shutdown();
        var reopened = new AppModel(AppEnvironment.ForTests(_box.Root, secrets: _secrets), "maks", "maks", false, Path.Combine(_box.Root, "users", "maks"));
        Assert.True(reopened.Mail.SmtpReady);
        Assert.Equal("me@gmail.com", reopened.Mail.Account!.FromAddress);
        Assert.DoesNotContain("app-password", File.ReadAllText(Path.Combine(_box.Root, "users", "maks", "prefs.json")));
        reopened.Mail.Forget();
        Assert.False(reopened.Mail.HasPassword);
        Assert.Null(reopened.Mail.Account);
        Assert.Equal(MailDelivery.MailApp, reopened.Mail.Delivery);
        reopened.Shutdown();
    }

    [Fact]
    public async Task ServerErrorsBecomeReadableMessages()
    {
        var (model, _, _) = Open(l => l.StartsWith("AUTH") ? "535 bad\r\n" : Server(l));
        model.Mail.Account = MailAccount.Preset("me@yandex.ru");
        model.Mail.SetPassword("wrong");
        Assert.False(await model.Mail.SendAsync(new OutgoingMail("a@b.ru", "s", "b")));
        Assert.Contains("пароль приложения", model.Mail.LastError);
        Assert.False(model.Mail.Sending);
        model.Shutdown();
    }

    [Fact]
    public async Task TestMessageGoesToTheOwnAddress()
    {
        var (model, _, script) = Open();
        model.Mail.Account = MailAccount.Preset("me@mail.ru");
        model.Mail.SetPassword("pw");
        Assert.True(await model.Mail.SendTestAsync());
        Assert.Contains("RCPT TO:<me@mail.ru>", script.Lines);
        Assert.Equal("Проверочное письмо отправлено на me@mail.ru", model.Mail.LastResult);
        model.Shutdown();
    }

    [Fact]
    public void ChangingTheMailDoesNotRestartTheAutoSearchClock()
    {
        var (model, _, _) = Open();
        model.Prefs.PropertyChanged += (_, _) => { };
        model.Mail.Delivery = MailDelivery.Smtp;
        model.Prefs.ConfirmCalls = true;
        Assert.True(File.ReadAllText(Path.Combine(_box.Root, "users", "maks", "prefs.json")).Contains("\"confirmCalls\": true", StringComparison.Ordinal));
        model.Shutdown();
    }
}
