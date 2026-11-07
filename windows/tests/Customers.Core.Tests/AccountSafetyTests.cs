using System.Text.Json.Nodes;

namespace Customers.Core.Tests;

/// <summary>Подтверждение пароля перед опасными действиями и устойчивость входа в облако.</summary>
public sealed class AccountSafetyTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void ConfirmPasswordAcceptsRightAndRejectsWrongPassword()
    {
        using var auth = new LocalAccounts(_dir.Path);
        auth.Register("maksim", "Хороший-пароль-1");
        auth.ConfirmPassword("maksim", "Хороший-пароль-1");
        auth.ConfirmPassword("MAKSIM", "Хороший-пароль-1");
        var e = Assert.Throws<AuthException>(() => auth.ConfirmPassword("maksim", "не тот"));
        Assert.Equal(AuthFailure.WrongCredentials, e.Kind);
        Assert.Throws<AuthException>(() => auth.ConfirmPassword("nobody", "Хороший-пароль-1"));
    }

    [Fact]
    public void ConfirmPasswordIsThrottledLikeLogin()
    {
        using var auth = new LocalAccounts(_dir.Path);
        auth.Register("maksim", "Хороший-пароль-1");
        for (var i = 0; i < 5; i++)
        {
            Assert.Throws<AuthException>(() => auth.ConfirmPassword("maksim", "нет"));
        }

        var blocked = Assert.Throws<AuthException>(() => auth.ConfirmPassword("maksim", "Хороший-пароль-1"));
        Assert.Equal(AuthFailure.TooManyAttempts, blocked.Kind);
    }

    [Fact]
    public void ConfirmPasswordDoesNotTouchLastLogin()
    {
        using var auth = new LocalAccounts(_dir.Path);
        auth.Register("maksim", "Хороший-пароль-1");
        var before = auth.Account("maksim")!.LastLoginAt;
        auth.ConfirmPassword("maksim", "Хороший-пароль-1");
        Assert.Equal(before, auth.Account("maksim")!.LastLoginAt);
    }

    private sealed class BrokenStore : ISessionStore
    {
        public CloudSession? Load() => null;

        public void Save(CloudSession? session) => throw new IOException("диск недоступен");
    }

    [Fact]
    public async Task SignInSucceedsEvenWhenSessionCannotBeSavedToDisk()
    {
        var cloud = new MockCloud((req, _) => req.RequestUri!.AbsolutePath.EndsWith("/auth/v1/token", StringComparison.Ordinal) ? (200, CloudFixtures.Token()) : (404, "{}"));
        var auth = new CloudAuth(CloudFixtures.Config, cloud, new BrokenStore(), "dev");
        var session = await auth.SignInAsync("U@Example.com", "Хороший-пароль-1");
        Assert.Equal("u@example.com", session.User.Email);
        Assert.NotNull(auth.Session);
        Assert.Contains("диск", auth.PersistError);
    }

    [Fact]
    public async Task CheckPasswordKeepsSessionAndRejectsWrongPassword()
    {
        var wrong = false;
        var cloud = new MockCloud((req, _) =>
        {
            if (!req.RequestUri!.AbsolutePath.EndsWith("/auth/v1/token", StringComparison.Ordinal))
            {
                return (404, "{}");
            }

            return wrong ? (400, new JsonObject { ["error_code"] = "invalid_credentials", ["msg"] = "x" }.ToJsonString()) : (200, CloudFixtures.Token(access: wrong ? "z" : "a1"));
        });
        var auth = new CloudAuth(CloudFixtures.Config, cloud, new MemorySessionStore(), "dev");
        await auth.SignInAsync("u@example.com", "Хороший-пароль-1");
        var before = auth.Session;
        await auth.CheckPasswordAsync("Хороший-пароль-1");
        Assert.Same(before, auth.Session);
        wrong = true;
        var e = await Assert.ThrowsAsync<CloudException>(() => auth.CheckPasswordAsync("не тот"));
        Assert.Equal(CloudErrorKind.InvalidCredentials, e.Kind);
        var empty = await Assert.ThrowsAsync<CloudException>(() => auth.CheckPasswordAsync(""));
        Assert.Equal(CloudErrorKind.InvalidCredentials, empty.Kind);
        Assert.Same(before, auth.Session);
    }

    [Fact]
    public async Task CheckPasswordNeedsSession()
    {
        var auth = new CloudAuth(CloudFixtures.Config, new MockCloud((_, _) => (200, "{}")), new MemorySessionStore(), "dev");
        var e = await Assert.ThrowsAsync<CloudException>(() => auth.CheckPasswordAsync("x"));
        Assert.Equal(CloudErrorKind.SessionExpired, e.Kind);
    }
}
