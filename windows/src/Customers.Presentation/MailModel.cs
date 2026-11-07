namespace Customers.Presentation;

/// <summary>
/// Почта пользователя: настройки ящика (в файле настроек учётной записи), пароль приложения (защищённое хранилище), отправка по SMTP.
/// Письма уходят по одному, по кнопке: массовой рассылки нет.
/// </summary>
public sealed class MailModel : ObservableObject
{
    private readonly AppEnvironment _env;
    private readonly AccountPreferences _prefs;
    private readonly string _user;
    private bool _hasPassword;
    private bool _sending;
    private string? _lastResult;
    private string? _lastError;

    public MailModel(AppEnvironment env, AccountPreferences prefs, string user)
    {
        _env = env;
        _prefs = prefs;
        _user = user.ToLowerInvariant();
        _hasPassword = !string.IsNullOrEmpty(env.Secrets.Get(PasswordSecret(_user)));
    }

    public static string PasswordSecret(string user) => "mail.password." + user.ToLowerInvariant();

    public MailAccount? Account
    {
        get => MailAccount.Decode(_prefs.MailAccount);
        set
        {
            _prefs.MailAccount = value?.Encode() ?? "";
            Raise();
            Raise(nameof(SmtpReady));
        }
    }

    public MailDelivery Delivery
    {
        get => _prefs.MailDelivery;
        set
        {
            _prefs.MailDelivery = value;
            Raise();
            Raise(nameof(SmtpReady));
        }
    }

    /// <summary>Есть ли пароль в хранилище. Сам пароль в памяти не держим.</summary>
    public bool HasPassword { get => _hasPassword; private set => Set(ref _hasPassword, value); }

    public bool Sending { get => _sending; private set => Set(ref _sending, value); }

    public string? LastResult { get => _lastResult; private set => Set(ref _lastResult, value); }

    public string? LastError { get => _lastError; private set => Set(ref _lastError, value); }

    /// <summary>Отправка из приложения настроена полностью.</summary>
    public bool SmtpReady => Delivery == MailDelivery.Smtp && Account is { Problem: null } && HasPassword;

    public void SetPassword(string value)
    {
        if (value.Length == 0)
        {
            _env.Secrets.Delete(PasswordSecret(_user));
        }
        else
        {
            _env.Secrets.Set(PasswordSecret(_user), value);
        }

        HasPassword = value.Length > 0;
        Raise(nameof(SmtpReady));
    }

    public void Forget()
    {
        SetPassword("");
        Account = null;
        Delivery = MailDelivery.MailApp;
        LastError = null;
        LastResult = null;
    }

    /// <summary>Отправка по SMTP. Возвращает true, если сервер принял письмо.</summary>
    public async Task<bool> SendAsync(OutgoingMail mail, CancellationToken ct = default)
    {
        LastResult = null;
        if (Account is not { } account)
        {
            LastError = "Почта не настроена: Настройки → Почта";
            return false;
        }

        if (_env.Secrets.Get(PasswordSecret(_user)) is not { Length: > 0 } password)
        {
            LastError = MailException.NoPassword().Message;
            return false;
        }

        Sending = true;
        LastError = null;
        try
        {
            var transport = _env.SmtpTransport(account.Host.Trim(), account.Port, account.Security == MailSecurity.Tls);
            await new SmtpClient(transport).SendAsync(mail, account, password, ct).ConfigureAwait(true);
            LastResult = $"Письмо отправлено на {mail.To.Trim()}";
            _env.Log.Info("Письмо отправлено: " + Describe(account));
            return true;
        }
        catch (MailException e)
        {
            LastError = e.Message;
            _env.Log.Warn($"Письмо не отправлено ({Describe(account)}): {e.Message}");
            return false;
        }
        finally
        {
            Sending = false;
        }
    }

    /// <summary>Проверочное письмо самому себе.</summary>
    public async Task<bool> SendTestAsync()
    {
        if (Account is not { } account)
        {
            return false;
        }

        if (!await SendAsync(new OutgoingMail(account.FromAddress, "Проверка почты Customers", "Это проверочное письмо: отправка из Customers настроена.")).ConfigureAwait(true))
        {
            return false;
        }

        LastResult = $"Проверочное письмо отправлено на {account.FromAddress}";
        return true;
    }

    // В журнал попадает только сервер: ни адресов получателей, ни паролей.
    private static string Describe(MailAccount a) => $"{a.Host}:{a.Port}";
}
