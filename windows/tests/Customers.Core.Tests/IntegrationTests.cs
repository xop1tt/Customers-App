using System.Net.Sockets;
using System.Text;

namespace Customers.Core.Tests;

public class DriveCatalogTests
{
    [Fact]
    public void EveryServiceHasTitleAndAuth()
    {
        foreach (var s in Enum.GetValues<DriveService>())
        {
            Assert.False(string.IsNullOrWhiteSpace(s.Title()));
            Assert.False(string.IsNullOrWhiteSpace(s.Subtitle()));
        }

        Assert.Equal(OAuthProvider.Google, DriveService.GoogleDrive.Auth().OAuth);
        Assert.Null(DriveService.WebDav.Auth().OAuth);
        Assert.Equal("https://webdav.yandex.ru", DriveService.YandexDisk.Auth().DefaultUrl);
        Assert.True(DriveService.Mega.PasswordOptional());
        Assert.False(DriveService.PCloud.PasswordOptional());
    }

    [Fact]
    public void RedirectIsTheSameAsOnMac() => Assert.Equal("http://localhost:47811/oauth/callback", OAuthRedirect.Uri());

    [Theory]
    [InlineData("", false)]
    [InlineData("  ", false)]
    [InlineData("$(GOOGLE)", false)]
    [InlineData("two words", false)]
    [InlineData("abc.apps.googleusercontent.com", true)]
    public void ClientIdIsValidated(string id, bool ok) =>
        Assert.Equal(ok, OAuthClient.Create(OAuthProvider.Dropbox, id) is not null);

    [Fact]
    public void GoogleNeedsSecretOtherProvidersDoNot()
    {
        Assert.Null(OAuthClient.Create(OAuthProvider.Google, "id"));
        Assert.Null(OAuthClient.Create(OAuthProvider.Google, "id", "$(SECRET)"));
        Assert.NotNull(OAuthClient.Create(OAuthProvider.Google, "id", "secret"));
        Assert.NotNull(OAuthClient.Create(OAuthProvider.Microsoft, "id"));
        Assert.Equal("Для Google нужен ещё Client secret", new OAuthKey("id").Problem(OAuthProvider.Google));
        Assert.Null(new OAuthKey("id", "s").Problem(OAuthProvider.Google));
        Assert.Null(new OAuthKey("id").Problem(OAuthProvider.Dropbox));
    }

    [Fact]
    public void BuiltInKeyWinsOverTypedOne()
    {
        var built = OAuthClient.Create(OAuthProvider.Dropbox, "built");
        var stored = new OAuthKey("typed");
        Assert.Equal("built", OAuthClient.Resolve(built, OAuthProvider.Dropbox, stored)!.ClientId);
        Assert.Equal("typed", OAuthClient.Resolve(null, OAuthProvider.Dropbox, stored)!.ClientId);
        Assert.Null(OAuthClient.Resolve(null, OAuthProvider.Dropbox, null));
    }

    [Fact]
    public void KeyAndConnectionSurviveSerialization()
    {
        var key = OAuthKey.Decode(new OAuthKey("id", "secret").Encode());
        Assert.Equal(new OAuthKey("id", "secret"), key);
        Assert.Null(OAuthKey.Decode("not json"));
        Assert.Null(OAuthKey.Decode(null));

        var expires = DateTimeOffset.Parse("2026-11-07T12:00:00Z");
        var conn = new DriveConnection(DriveService.OneDrive, new OAuthToken("a", "r", expires), ConnectedAt: expires);
        var back = DriveConnection.Decode(conn.Encode())!;
        Assert.Equal(DriveService.OneDrive, back.Service);
        Assert.Equal("a", back.Token!.AccessToken);
        Assert.Equal("r", back.Token.RefreshToken);
        Assert.Equal(expires, back.Token.ExpiresAt);

        var dav = DriveConnection.Decode(new DriveConnection(DriveService.WebDav, WebDavUrl: "https://x/", Login: "me", Password: "pw").Encode())!;
        Assert.Equal(("https://x/", "me", "pw"), (dav.WebDavUrl, dav.Login, dav.Password));
        Assert.Null(DriveConnection.Decode("{\"service\":\"nope\"}"));
        Assert.Equal("integration.googledrive.maks", DriveConnection.SecretName(DriveService.GoogleDrive, "Maks"));
    }
}

public class OAuthFlowTests
{
    private static readonly OAuthClient Google = OAuthClient.Create(OAuthProvider.Google, "gid", "gsecret")!;
    private static readonly OAuthClient Dropbox = OAuthClient.Create(OAuthProvider.Dropbox, "dkey")!;
    private static readonly OAuthClient Microsoft = OAuthClient.Create(OAuthProvider.Microsoft, "mid")!;

    [Fact]
    public void ChallengeMatchesRfc7636Example() =>
        Assert.Equal("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", OAuthFlow.Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));

    [Fact]
    public void VerifierIsLongEnoughAndUnreserved()
    {
        foreach (var length in new[] { 10, 43, 64, 500 })
        {
            var v = OAuthFlow.RandomVerifier(length);
            Assert.InRange(v.Length, 43, 128);
            Assert.All(v, c => Assert.True(char.IsAsciiLetterOrDigit(c) || "-._~".Contains(c)));
        }

        Assert.NotEqual(OAuthFlow.RandomVerifier(), OAuthFlow.RandomVerifier());
    }

    [Fact]
    public void AuthorizeUrlCarriesPkceAndProviderExtras()
    {
        var url = OAuthFlow.AuthorizeUrl(Google, "st", "ch").AbsoluteUri;
        Assert.StartsWith("https://accounts.google.com/o/oauth2/v2/auth?", url);
        Assert.Contains("client_id=gid", url);
        Assert.Contains("redirect_uri=http%3A%2F%2Flocalhost%3A47811%2Foauth%2Fcallback", url);
        Assert.Contains("code_challenge=ch&code_challenge_method=S256", url);
        Assert.Contains("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file", url);
        Assert.Contains("access_type=offline", url);

        var dropbox = OAuthFlow.AuthorizeUrl(Dropbox, "st", "ch").AbsoluteUri;
        Assert.DoesNotContain("scope=", dropbox);
        Assert.Contains("token_access_type=offline", dropbox);

        var ms = OAuthFlow.AuthorizeUrl(Microsoft, "st", "ch").AbsoluteUri;
        Assert.Contains("Files.ReadWrite.AppFolder%20offline_access", ms);
    }

    [Fact]
    public void TokenRequestsAreFormEncoded()
    {
        var token = OAuthFlow.TokenRequest(Google, "the code", "ver");
        Assert.Equal("POST", token.Method);
        Assert.Equal("application/x-www-form-urlencoded", token.ContentType);
        var body = Encoding.UTF8.GetString(token.Body!);
        Assert.Contains("grant_type=authorization_code", body);
        Assert.Contains("code=the%20code", body);
        Assert.Contains("code_verifier=ver", body);
        Assert.Contains("client_secret=gsecret", body);
        Assert.DoesNotContain("client_secret", Encoding.UTF8.GetString(OAuthFlow.TokenRequest(Dropbox, "c", "v").Body!));

        var refresh = Encoding.UTF8.GetString(OAuthFlow.RefreshRequest(Microsoft, "rt").Body!);
        Assert.Contains("grant_type=refresh_token", refresh);
        Assert.Contains("scope=", refresh);
        Assert.DoesNotContain("scope=", Encoding.UTF8.GetString(OAuthFlow.RefreshRequest(Dropbox, "rt").Body!));
    }

    [Fact]
    public void ParseTokenReadsExpiryAndKeepsPreviousRefresh()
    {
        var now = DateTimeOffset.Parse("2026-11-07T10:00:00Z");
        var t = OAuthFlow.ParseToken("""{"access_token":"A","refresh_token":"R","expires_in":3600}""", now);
        Assert.Equal(("A", "R", now.AddHours(1)), (t.AccessToken, t.RefreshToken, t.ExpiresAt!.Value));
        var again = OAuthFlow.ParseToken("""{"access_token":"B","expires_in":"30"}""", now, "R");
        Assert.Equal("R", again.RefreshToken);
        Assert.True(again.IsExpired(now));
        Assert.False(t.IsExpired(now));
    }

    [Theory]
    [InlineData("""{"error":"invalid_grant"}""", IntegrationFailure.Reauthorize)]
    [InlineData("""{"error":"access_denied","error_description":"нет"}""", IntegrationFailure.Denied)]
    [InlineData("""{"foo":1}""", IntegrationFailure.BadResponse)]
    [InlineData("<html>", IntegrationFailure.BadResponse)]
    public void ParseTokenRejectsBadAnswers(string json, IntegrationFailure expected) =>
        Assert.Equal(expected, Assert.Throws<IntegrationException>(() => OAuthFlow.ParseToken(json, DateTimeOffset.UtcNow)).Failure);

    [Fact]
    public void CallbackIsParsedAndValidated()
    {
        var cb = OAuthCallback.Parse("GET /oauth/callback?code=abc%20d&state=xyz HTTP/1.1")!;
        Assert.Equal("abc d", cb.Validated("xyz"));
        Assert.Equal(IntegrationFailure.StateMismatch, Assert.Throws<IntegrationException>(() => cb.Validated("other")).Failure);
        Assert.Null(OAuthCallback.Parse("GET /favicon.ico HTTP/1.1"));
        Assert.Null(OAuthCallback.Parse("POST /oauth/callback?code=1 HTTP/1.1"));
        var denied = OAuthCallback.Parse("GET /oauth/callback?error=access_denied&error_description=Nope+thanks&state=x HTTP/1.1")!;
        Assert.Contains("Nope thanks", Assert.Throws<IntegrationException>(() => denied.Validated("x")).Message);
        Assert.Throws<IntegrationException>(() => OAuthCallback.Parse("GET /oauth/callback?state=x HTTP/1.1")!.Validated("x"));
    }
}

public class DriveUploadTests
{
    private static readonly byte[] Data = [1, 2, 3, 4];

    [Theory]
    [InlineData("https://cloud.example.ru/remote.php/dav/files/me", "https://cloud.example.ru/remote.php/dav/files/me/")]
    [InlineData("  http://127.0.0.1:4443/x ", "http://127.0.0.1:4443/x/")]
    [InlineData("http://localhost:4443", "http://localhost:4443/")]
    public void WebDavAddressIsAccepted(string raw, string expected) => Assert.Equal(expected, DriveUpload.WebDavBase(raw).AbsoluteUri);

    [Theory]
    [InlineData("")]
    [InlineData("http://example.com/dav")]
    [InlineData("ftp://example.com")]
    [InlineData("https://user:pw@example.com/")]
    [InlineData("not a url")]
    public void WebDavAddressIsRejected(string raw) =>
        Assert.Equal(IntegrationFailure.InvalidUrl, Assert.Throws<IntegrationException>(() => DriveUpload.WebDavBase(raw)).Failure);

    [Fact]
    public void WebDavCreatesFolderThenPutsFile()
    {
        var c = new DriveConnection(DriveService.WebDav, WebDavUrl: "https://dav.example.ru/root", Login: "me", Password: "pw");
        var requests = DriveUpload.Requests(c, "Customers 2026/11.db", Data);
        Assert.Equal(["MKCOL", "PUT"], requests.Select(r => r.Method));
        Assert.Equal("https://dav.example.ru/root/Customers/", requests[0].Url.AbsoluteUri);
        Assert.Equal("https://dav.example.ru/root/Customers/Customers%202026_11.db", requests[1].Url.AbsoluteUri);
        Assert.Equal(DriveUpload.BasicAuth("me", "pw"), requests[1].Headers["Authorization"]);
        Assert.Equal(Data, requests[1].Body);
    }

    [Fact]
    public void WebDavWithoutLoginSendsNoAuthorization()
    {
        var c = new DriveConnection(DriveService.Mega, WebDavUrl: "http://127.0.0.1:4443/abc/Customers/");
        Assert.All(DriveUpload.Requests(c, "a.db", Data), r => Assert.False(r.Headers.ContainsKey("Authorization")));
    }

    [Fact]
    public void GoogleUploadsMultipartWithBearer()
    {
        var c = new DriveConnection(DriveService.GoogleDrive, new OAuthToken("tok", null, null));
        var r = Assert.Single(DriveUpload.Requests(c, "копия.db", Data));
        Assert.Equal("POST", r.Method);
        Assert.StartsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", r.Url.AbsoluteUri);
        Assert.Equal("Bearer tok", r.Headers["Authorization"]);
        Assert.StartsWith("multipart/related; boundary=", r.ContentType);
        var text = Encoding.UTF8.GetString(r.Body!);
        Assert.Contains("\"name\":\"Customers \\u043A\\u043E\\u043F\\u0438\\u044F.db\"", text);
        Assert.EndsWith("--\r\n", text);
    }

    [Fact]
    public void DropboxPutsArgumentsInAsciiHeader()
    {
        var c = new DriveConnection(DriveService.Dropbox, new OAuthToken("tok", null, null));
        var r = Assert.Single(DriveUpload.Requests(c, "копия.db", Data));
        Assert.Equal("https://content.dropboxapi.com/2/files/upload", r.Url.AbsoluteUri);
        var arg = r.Headers["Dropbox-API-Arg"];
        Assert.All(arg, ch => Assert.True(ch < 0x80));
        Assert.Contains("\"path\":\"/Customers/\\u043a\\u043e\\u043f\\u0438\\u044f.db\"", arg);
        Assert.Equal(Data, r.Body);
    }

    [Fact]
    public void OneDriveUsesAppFolderPath()
    {
        var c = new DriveConnection(DriveService.OneDrive, new OAuthToken("tok", null, null));
        var r = Assert.Single(DriveUpload.Requests(c, "a b.db", Data));
        Assert.Equal("PUT", r.Method);
        Assert.Equal("https://graph.microsoft.com/v1.0/me/drive/special/approot:/Customers/a%20b.db:/content", r.Url.AbsoluteUri);
    }

    [Fact]
    public void OAuthWithoutTokenAsksToReconnect() =>
        Assert.Equal(IntegrationFailure.Reauthorize, Assert.Throws<IntegrationException>(() => DriveUpload.Requests(new DriveConnection(DriveService.Dropbox), "a", Data)).Failure);

    [Fact]
    public void MkcolTreatsExistingFolderAsSuccess()
    {
        var mk = new HttpRequestSpec { Url = new Uri("https://x/"), Method = "MKCOL" };
        var put = new HttpRequestSpec { Url = new Uri("https://x/"), Method = "PUT" };
        Assert.True(DriveUpload.IsSuccess(mk, 405));
        Assert.True(DriveUpload.IsSuccess(mk, 201));
        Assert.False(DriveUpload.IsSuccess(mk, 403));
        Assert.False(DriveUpload.IsSuccess(put, 405));
        Assert.True(DriveUpload.IsSuccess(put, 204));
    }
}

public class DriveClientTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-11-07T10:00:00Z");

    [Fact]
    public async Task ExpiredTokenIsRefreshedAndKeepsOldRefreshToken()
    {
        var transport = new MockTransport(r => MockTransport.Ok("""{"access_token":"new","expires_in":3600}"""));
        var client = new DriveClient(transport, () => Now);
        var c = new DriveConnection(DriveService.Dropbox, new OAuthToken("old", "refresh", Now.AddSeconds(10)));
        var fresh = await client.EnsureFreshAsync(c, OAuthClient.Create(OAuthProvider.Dropbox, "key"), CancellationToken.None);
        Assert.Equal(("new", "refresh"), (fresh.Token!.AccessToken, fresh.Token.RefreshToken));
        Assert.Single(transport.Requests);
    }

    [Fact]
    public async Task ValidTokenIsNotRefreshed()
    {
        var transport = new MockTransport(_ => throw new InvalidOperationException("no network expected"));
        var c = new DriveConnection(DriveService.Dropbox, new OAuthToken("ok", "r", Now.AddHours(1)));
        Assert.Same(c, await new DriveClient(transport, () => Now).EnsureFreshAsync(c, null, CancellationToken.None));
    }

    [Fact]
    public async Task RefreshWithoutKeyOrRefreshTokenFailsClearly()
    {
        var expired = new DriveConnection(DriveService.Dropbox, new OAuthToken("old", "r", Now.AddSeconds(-5)));
        var client = new DriveClient(new MockTransport(_ => MockTransport.Status(500)), () => Now);
        Assert.Equal(IntegrationFailure.NotConfigured,
            (await Assert.ThrowsAsync<IntegrationException>(() => client.EnsureFreshAsync(expired, null, CancellationToken.None))).Failure);
        var noRefresh = new DriveConnection(DriveService.Dropbox, new OAuthToken("old", null, Now.AddSeconds(-5)));
        Assert.Equal(IntegrationFailure.Reauthorize,
            (await Assert.ThrowsAsync<IntegrationException>(() => client.EnsureFreshAsync(noRefresh, OAuthClient.Create(OAuthProvider.Dropbox, "k"), CancellationToken.None))).Failure);
        var rejected = new DriveClient(new MockTransport(_ => MockTransport.Status(400)), () => Now);
        Assert.Equal(IntegrationFailure.Reauthorize,
            (await Assert.ThrowsAsync<IntegrationException>(() => rejected.EnsureFreshAsync(expired, OAuthClient.Create(OAuthProvider.Dropbox, "k"), CancellationToken.None))).Failure);
    }

    [Fact]
    public async Task UploadSendsEveryRequestAndStopsOnError()
    {
        var c = new DriveConnection(DriveService.WebDav, WebDavUrl: "https://dav.example/", Login: "a", Password: "b");
        var ok = new MockTransport(r => MockTransport.Status(r.Method == "MKCOL" ? 405 : 201));
        await new DriveClient(ok, () => Now).UploadAsync(c, "x.db", [1], CancellationToken.None);
        Assert.Equal(["MKCOL", "PUT"], ok.Requests.Select(r => r.Method));

        var failing = new MockTransport(r => MockTransport.Status(r.Method == "MKCOL" ? 403 : 201));
        var error = await Assert.ThrowsAsync<IntegrationException>(() => new DriveClient(failing, () => Now).UploadAsync(c, "x.db", [1], CancellationToken.None));
        Assert.Equal(403, error.Status);
        Assert.Single(failing.Requests);

        var unauthorized = new MockTransport(_ => MockTransport.Status(401));
        Assert.Equal(IntegrationFailure.Reauthorize,
            (await Assert.ThrowsAsync<IntegrationException>(() => new DriveClient(unauthorized, () => Now).UploadAsync(c, "x.db", [1], CancellationToken.None))).Failure);
    }

    [Fact]
    public async Task ProbeAcceptsMultiStatusAndRejectsWrongPassword()
    {
        var good = new MockTransport(_ => MockTransport.Status(207));
        Assert.Equal("https://dav.example/x/", await new DriveClient(good).ProbeWebDavAsync("https://dav.example/x", "me", "pw", CancellationToken.None));
        Assert.Equal("PROPFIND", good.Requests[0].Method);
        Assert.Equal("0", good.Requests[0].Headers["Depth"]);

        var bad = new DriveClient(new MockTransport(_ => MockTransport.Status(401)));
        var e = await Assert.ThrowsAsync<IntegrationException>(() => bad.ProbeWebDavAsync("https://dav.example/", "me", "x", CancellationToken.None));
        Assert.Contains("неверный логин", e.Message);
        await Assert.ThrowsAsync<IntegrationException>(() => new DriveClient(new MockTransport(_ => MockTransport.Status(404))).ProbeWebDavAsync("https://dav.example/", "", "", CancellationToken.None));
    }

    [Fact]
    public async Task CodeExchangeParsesToken()
    {
        var transport = new MockTransport(_ => MockTransport.Ok("""{"access_token":"A","refresh_token":"R","expires_in":100}"""));
        var token = await new DriveClient(transport, () => Now).ExchangeCodeAsync(OAuthClient.Create(OAuthProvider.Microsoft, "id")!, "code", "ver", 47811, CancellationToken.None);
        Assert.Equal(("A", "R"), (token.AccessToken, token.RefreshToken));
        var failing = new DriveClient(new MockTransport(_ => new HttpResult(400, Encoding.UTF8.GetBytes("bad"), new Dictionary<string, string>(), null)), () => Now);
        await Assert.ThrowsAsync<IntegrationException>(() => failing.ExchangeCodeAsync(OAuthClient.Create(OAuthProvider.Microsoft, "id")!, "c", "v", 47811, CancellationToken.None));
    }
}

public class OAuthLoopbackTests
{
    private static async Task<string> GetAsync(int port, string path)
    {
        using var http = new HttpClient();
        using var reply = await http.GetAsync($"http://127.0.0.1:{port}{path}");
        return $"{(int)reply.StatusCode} {await reply.Content.ReadAsStringAsync()}";
    }

    [Fact]
    public async Task ReturnsCallbackAndShowsFriendlyPage()
    {
        using var server = new OAuthLoopback(0);
        var wait = server.WaitForCallbackAsync(CancellationToken.None);
        var stray = await GetAsync(server.Port, "/favicon.ico");
        Assert.StartsWith("404", stray);
        Assert.False(wait.IsCompleted);
        var page = await GetAsync(server.Port, "/oauth/callback?code=C&state=S");
        Assert.StartsWith("200", page);
        Assert.Contains("Вход выполнен", page);
        var callback = await wait.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("C", callback.Validated("S"));
    }

    [Fact]
    public async Task CancellationStopsWaitingAndFreesThePort()
    {
        var server = new OAuthLoopback(0);
        var port = server.Port;
        using var cts = new CancellationTokenSource();
        var wait = server.WaitForCallbackAsync(cts.Token);
        await cts.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => wait.WaitAsync(TimeSpan.FromSeconds(10)));
        server.Dispose();
        using var again = new OAuthLoopback(port);
        Assert.Equal(port, again.Port);
    }

    [Fact]
    public void BusyPortGivesClearMessage()
    {
        using var first = new OAuthLoopback(0);
        var e = Assert.Throws<IntegrationException>(() => new OAuthLoopback(first.Port));
        Assert.Equal(IntegrationFailure.Busy, e.Failure);
        Assert.Contains("занят", e.Message);
    }

    [Fact]
    public async Task SilentClientDoesNotBlockTheRealOne()
    {
        using var server = new OAuthLoopback(0);
        var wait = server.WaitForCallbackAsync(CancellationToken.None);
        using var silent = new TcpClient();
        await silent.ConnectAsync("127.0.0.1", server.Port);
        _ = await GetAsync(server.Port, "/oauth/callback?code=1&state=2");
        Assert.Equal("1", (await wait.WaitAsync(TimeSpan.FromSeconds(15))).Code);
    }
}

public class MailTests
{
    private static readonly MailAccount Account = MailAccount.Preset("me@example.ru", "Максим") with { Host = "smtp.example.ru" };
    private static readonly DateTimeOffset Date = new(2026, 11, 7, 10, 30, 0, TimeSpan.FromHours(3));

    [Theory]
    [InlineData("a@gmail.com", MailProvider.Gmail)]
    [InlineData("a@GoogleMail.com", MailProvider.Gmail)]
    [InlineData("a@ya.ru", MailProvider.Yandex)]
    [InlineData("a@bk.ru", MailProvider.MailRu)]
    [InlineData("a@me.com", MailProvider.ICloud)]
    [InlineData("a@company.ru", MailProvider.Custom)]
    [InlineData("nonsense", MailProvider.Custom)]
    public void ProviderIsDetectedByDomain(string email, MailProvider expected) => Assert.Equal(expected, MailProviders.Detect(email));

    [Fact]
    public void PresetsMatchProviders()
    {
        var gmail = MailAccount.Preset("a@gmail.com");
        Assert.Equal(("smtp.gmail.com", 465, MailSecurity.Tls), (gmail.Host, gmail.Port, gmail.Security));
        var icloud = MailAccount.Preset("a@icloud.com");
        Assert.Equal((587, MailSecurity.StartTls), (icloud.Port, icloud.Security));
        Assert.NotNull(MailProvider.Gmail.AppPasswordPage());
        Assert.Null(MailProvider.Custom.AppPasswordPage());
    }

    [Fact]
    public void AccountProblemsAreReported()
    {
        Assert.Null(Account.Problem);
        Assert.NotNull((Account with { Host = "" }).Problem);
        Assert.NotNull((Account with { Host = "smtp.x.ru:465" }).Problem);
        Assert.NotNull((Account with { Port = 0 }).Problem);
        Assert.NotNull((Account with { Username = " " }).Problem);
        Assert.NotNull((Account with { FromAddress = "bad" }).Problem);
        Assert.NotNull((Account with { FromName = "a\nBcc: x@y.z" }).Problem);
    }

    [Fact]
    public void AccountSurvivesSerialization()
    {
        var back = MailAccount.Decode(Account.Encode());
        Assert.Equal(Account, back);
        Assert.Null(MailAccount.Decode("nope"));
        Assert.Null(MailAccount.Decode(null));
    }

    [Fact]
    public void MessageHasEncodedHeadersAndBase64Body()
    {
        var text = MimeMessage.Build(new OutgoingMail("to@example.com", "Тема письма", "Привет,\nмир"), Account, Date, "id1");
        Assert.Contains("From: =?UTF-8?B?" + Convert.ToBase64String(Encoding.UTF8.GetBytes("Максим")) + "?= <me@example.ru>", text);
        Assert.Contains("To: <to@example.com>", text);
        Assert.Contains("Subject: =?UTF-8?B?", text);
        Assert.Contains("Date: Sat, 07 Nov 2026 10:30:00 +0300", text);
        Assert.Contains("Message-ID: <id1@example.ru>", text);
        Assert.Contains("Content-Transfer-Encoding: base64", text);
        var body = text[(text.IndexOf("\r\n\r\n", StringComparison.Ordinal) + 4)..].Replace("\r\n", "");
        Assert.Equal("Привет,\r\nмир", Encoding.UTF8.GetString(Convert.FromBase64String(body)));
        Assert.All(text.Split("\r\n"), line => Assert.True(line.Length <= 78));
        Assert.DoesNotContain("\n", text.Replace("\r\n", ""));
    }

    [Fact]
    public void AsciiSubjectStaysReadableAndLongOnesAreSplit()
    {
        Assert.Equal("Hello world", MimeMessage.EncodedWord("Hello world"));
        var long_ = MimeMessage.EncodedWord(string.Concat(Enumerable.Repeat("Длинная тема ", 20)));
        var words = long_.Split("\r\n ");
        Assert.True(words.Length > 1);
        Assert.All(words, w => Assert.True(w.Length <= 75, w));
        var decoded = string.Concat(words.Select(w => Encoding.UTF8.GetString(Convert.FromBase64String(w[10..^2]))));
        Assert.Equal(string.Concat(Enumerable.Repeat("Длинная тема ", 20)), decoded);
    }

    [Fact]
    public void HeaderInjectionIsImpossible()
    {
        var text = MimeMessage.Build(new OutgoingMail("to@example.com", "Hi\r\nBcc: evil@example.com", "x"), Account, Date, "i");
        Assert.DoesNotContain("\r\nBcc:", text);
        Assert.Throws<MailException>(() => MimeMessage.Build(new OutgoingMail("a@b.ru\r\nBcc: x@y.z", "s", "b"), Account, Date, "i"));
        Assert.Equal(MailFailure.EmptyMessage, Assert.Throws<MailException>(() => MimeMessage.Build(new OutgoingMail("a@b.ru", " ", " "), Account, Date, "i")).Failure);
        Assert.Equal(MailFailure.InvalidAccount, Assert.Throws<MailException>(() => MimeMessage.Build(new OutgoingMail("a@b.ru", "s", "b"), Account with { Host = "" }, Date, "i")).Failure);
    }

    [Fact]
    public void DotStuffingDoublesLeadingDots() =>
        Assert.Equal("a\r\n..b\r\n...\r\nc", MimeMessage.DotStuffed("a\r\n.b\r\n..\r\nc"));

    // MARK: SMTP с поддельным сервером

    private sealed class FakeServer : ISmtpTransport
    {
        private readonly Queue<byte[]> _incoming = new();
        private readonly Func<string, string> _reply;
        private readonly StringBuilder _data = new();
        private bool _inData;

        public FakeServer(Func<string, string> reply, string greeting = "220 hello\r\n")
        {
            _reply = reply;
            _incoming.Enqueue(Encoding.UTF8.GetBytes(greeting));
        }

        public List<string> Commands { get; } = [];

        public string Message => _data.ToString();

        public bool TlsStarted { get; private set; }

        public bool Closed { get; private set; }

        public Task<byte[]> ReceiveAsync(CancellationToken ct) => Task.FromResult(_incoming.Count > 0 ? _incoming.Dequeue() : []);

        public Task SendAsync(byte[] data, CancellationToken ct)
        {
            var text = Encoding.UTF8.GetString(data);
            if (_inData)
            {
                _data.Append(text);
                if (text.EndsWith("\r\n.\r\n", StringComparison.Ordinal))
                {
                    _inData = false;
                    _incoming.Enqueue(Encoding.UTF8.GetBytes("250 queued\r\n"));
                }

                return Task.CompletedTask;
            }

            foreach (var line in text.Split("\r\n", StringSplitOptions.RemoveEmptyEntries))
            {
                Commands.Add(line);
                var answer = _reply(line);
                if (line == "DATA")
                {
                    _inData = true;
                }

                _incoming.Enqueue(Encoding.UTF8.GetBytes(answer));
            }

            return Task.CompletedTask;
        }

        public Task StartTlsAsync(CancellationToken ct)
        {
            TlsStarted = true;
            return Task.CompletedTask;
        }

        public void Close() => Closed = true;
    }

    private static string Standard(string line, string caps = "250-mail\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n") => line switch {
        _ when line.StartsWith("EHLO") => caps,
        "STARTTLS" => "220 go\r\n",
        _ when line.StartsWith("AUTH PLAIN") => "235 ok\r\n",
        _ when line.StartsWith("MAIL FROM") || line.StartsWith("RCPT TO") => "250 ok\r\n",
        "DATA" => "354 go ahead\r\n",
        "QUIT" => "221 bye\r\n",
        _ => "500 what\r\n",
    };

    [Fact]
    public async Task SendsOverTlsWithPlainAuthAndCopyToSelf()
    {
        var server = new FakeServer(l => Standard(l));
        var client = new SmtpClient(server);
        await client.SendAsync(new OutgoingMail("to@example.com", "Тема", "Текст\r\n.точка"), Account, "secret", CancellationToken.None, date: Date);
        Assert.False(server.TlsStarted);
        Assert.True(server.Closed);
        var plain = Convert.ToBase64String(Encoding.UTF8.GetBytes("\0me@example.ru\0secret"));
        Assert.Equal(["EHLO localhost", "AUTH PLAIN " + plain, "MAIL FROM:<me@example.ru>", "RCPT TO:<to@example.com>", "RCPT TO:<me@example.ru>", "DATA", "QUIT"], server.Commands);
        Assert.EndsWith("\r\n.\r\n", server.Message);
        Assert.DoesNotContain("secret", string.Join('\n', client.Log));
        Assert.Contains("C: <скрыто>", client.Log);
    }

    [Fact]
    public async Task NoCopyWhenDisabledOrSendingToSelf()
    {
        var off = new FakeServer(l => Standard(l));
        await new SmtpClient(off).SendAsync(new OutgoingMail("to@example.com", "s", "b"), Account with { CopyToSelf = false }, "p", CancellationToken.None);
        Assert.Single(off.Commands, c => c.StartsWith("RCPT"));
        var self = new FakeServer(l => Standard(l));
        await new SmtpClient(self).SendAsync(new OutgoingMail("ME@example.ru", "s", "b"), Account, "p", CancellationToken.None);
        Assert.Single(self.Commands, c => c.StartsWith("RCPT"));
    }

    [Fact]
    public async Task StartTlsIsRequiredAndUpgradesBeforeAuth()
    {
        var account = Account with { Security = MailSecurity.StartTls, Port = 587 };
        FakeServer? server = null;
        server = new FakeServer(l => Standard(l, !server!.TlsStarted ? "250-mail\r\n250 STARTTLS\r\n" : "250-mail\r\n250 AUTH PLAIN\r\n"));
        await new SmtpClient(server).SendAsync(new OutgoingMail("to@example.com", "s", "b"), account, "p", CancellationToken.None);
        Assert.True(server.TlsStarted);
        Assert.Equal(["EHLO localhost", "STARTTLS", "EHLO localhost"], server.Commands.Take(3));
        Assert.StartsWith("AUTH PLAIN", server.Commands[3]);

        var plainOnly = new FakeServer(l => Standard(l));
        var e = await Assert.ThrowsAsync<MailException>(() => new SmtpClient(plainOnly).SendAsync(new OutgoingMail("to@example.com", "s", "b"), account, "p", CancellationToken.None));
        Assert.Equal(MailFailure.TlsUnavailable, e.Failure);
        Assert.DoesNotContain(plainOnly.Commands, c => c.StartsWith("AUTH"));
        Assert.True(plainOnly.Closed);
    }

    [Fact]
    public async Task FallsBackToAuthLogin()
    {
        var user = Convert.ToBase64String(Encoding.UTF8.GetBytes("me@example.ru"));
        var password = Convert.ToBase64String(Encoding.UTF8.GetBytes("pw"));
        var server = new FakeServer(l =>
        {
            if (l.StartsWith("EHLO", StringComparison.Ordinal))
            {
                return "250-mail\r\n250 AUTH LOGIN\r\n";
            }

            if (l == "AUTH LOGIN")
            {
                return "334 VXNlcm5hbWU6\r\n";
            }

            if (l == user)
            {
                return "334 UGFzc3dvcmQ6\r\n";
            }

            return l == password ? "235 ok\r\n" : Standard(l);
        });
        await new SmtpClient(server).SendAsync(new OutgoingMail("to@example.com", "s", "b"), Account, "pw", CancellationToken.None);
        Assert.Contains("DATA", server.Commands);
    }

    [Fact]
    public async Task ServerWithoutAuthIsRejected()
    {
        var server = new FakeServer(l => Standard(l, "250 mail\r\n"));
        var e = await Assert.ThrowsAsync<MailException>(() => new SmtpClient(server).SendAsync(new OutgoingMail("to@example.com", "s", "b"), Account, "p", CancellationToken.None));
        Assert.Equal(MailFailure.AuthUnsupported, e.Failure);
    }

    [Fact]
    public async Task WrongPasswordGivesHelpfulMessage()
    {
        var server = new FakeServer(l => l.StartsWith("AUTH") ? "535 5.7.8 Bad credentials\r\n" : Standard(l));
        var e = await Assert.ThrowsAsync<MailException>(() => new SmtpClient(server).SendAsync(new OutgoingMail("to@example.com", "s", "b"), Account, "bad", CancellationToken.None));
        Assert.Equal(535, e.Code);
        Assert.Contains("пароль приложения", e.Message);
        Assert.True(server.Closed);
    }

    [Fact]
    public async Task RejectedRecipientIsExplained()
    {
        var server = new FakeServer(l => l.StartsWith("RCPT") ? "550 no such user\r\n" : Standard(l));
        var e = await Assert.ThrowsAsync<MailException>(() => new SmtpClient(server).SendAsync(new OutgoingMail("to@example.com", "s", "b"), Account, "p", CancellationToken.None));
        Assert.Contains("адрес получателя", e.Message);
        Assert.Equal("RCPT", e.Stage);
    }

    [Fact]
    public async Task ErrorAfterAcceptanceOnQuitIsNotAFailure()
    {
        var server = new FakeServer(l => l == "QUIT" ? "421 bye now\r\n" : Standard(l));
        await new SmtpClient(server).SendAsync(new OutgoingMail("to@example.com", "s", "b"), Account, "p", CancellationToken.None);
    }

    [Fact]
    public async Task EmptyPasswordAndClosedConnectionAreReported()
    {
        var e = await Assert.ThrowsAsync<MailException>(() => new SmtpClient(new FakeServer(l => Standard(l))).SendAsync(new OutgoingMail("to@example.com", "s", "b"), Account, "", CancellationToken.None));
        Assert.Equal(MailFailure.NoPassword, e.Failure);
        var closed = new FakeServer(l => Standard(l), greeting: "");
        var c = await Assert.ThrowsAsync<MailException>(() => new SmtpClient(closed).SendAsync(new OutgoingMail("to@example.com", "s", "b"), Account, "p", CancellationToken.None));
        Assert.Equal(MailFailure.Connection, c.Failure);
        var garbage = new FakeServer(l => Standard(l), greeting: "hello there\r\n");
        Assert.Equal(MailFailure.BadReply, (await Assert.ThrowsAsync<MailException>(() => new SmtpClient(garbage).SendAsync(new OutgoingMail("to@example.com", "s", "b"), Account, "p", CancellationToken.None))).Failure);
    }

    [Fact]
    public async Task TcpTransportReportsUnreachableServer()
    {
        using var free = new TcpListener(System.Net.IPAddress.Loopback, 0);
        free.Start();
        var closedPort = ((System.Net.IPEndPoint)free.LocalEndpoint).Port;
        free.Stop();
        var transport = new TcpSmtpTransport("127.0.0.1", closedPort, implicitTls: false, TimeSpan.FromSeconds(5));
        var e = await Assert.ThrowsAsync<MailException>(() => new SmtpClient(transport).SendAsync(new OutgoingMail("to@example.com", "s", "b"), Account, "p", CancellationToken.None));
        Assert.Equal(MailFailure.Connection, e.Failure);
    }

    [Fact]
    public async Task TcpTransportTalksToARealSocket()
    {
        using var listener = new TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        var server = Task.Run(async () =>
        {
            using var peer = await listener.AcceptTcpClientAsync();
            var stream = peer.GetStream();
            var buffer = new byte[1024];
            async Task Say(string s) => await stream.WriteAsync(Encoding.UTF8.GetBytes(s));
            await Say("220 hi\r\n");
            var seen = new StringBuilder();
            while (true)
            {
                var n = await stream.ReadAsync(buffer);
                if (n == 0)
                {
                    break;
                }

                var chunk = Encoding.UTF8.GetString(buffer, 0, n);
                seen.Append(chunk);
                foreach (var line in chunk.Split("\r\n", StringSplitOptions.RemoveEmptyEntries))
                {
                    await Say(line.StartsWith("EHLO") ? "250 plain\r\n" : "221 bye\r\n");
                }
            }

            return seen.ToString();
        });

        var transport = new TcpSmtpTransport("127.0.0.1", port, implicitTls: false, TimeSpan.FromSeconds(5));
        var greeting = Encoding.UTF8.GetString(await transport.ReceiveAsync(CancellationToken.None));
        Assert.StartsWith("220", greeting);
        await transport.SendAsync(Encoding.UTF8.GetBytes("EHLO test\r\n"), CancellationToken.None);
        Assert.StartsWith("250", Encoding.UTF8.GetString(await transport.ReceiveAsync(CancellationToken.None)));
        transport.Close();
        Assert.Contains("EHLO test", await server.WaitAsync(TimeSpan.FromSeconds(10)));
    }
}
