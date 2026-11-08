namespace Customers.Presentation;

/// <summary>Переход в поток интерфейса. В приложении — DispatcherQueue окна, в тестах — немедленное выполнение.</summary>
public interface IUiDispatcher
{
    void Post(Action action);
}

public sealed class ImmediateDispatcher : IUiDispatcher
{
    public void Post(Action action) => action();
}

/// <summary>Всё общее для приложения: папки, хранилище секретов, сеть, журнал, настройки этого компьютера.</summary>
public sealed class AppEnvironment
{
    public required string Root { get; init; }
    public required ISecretStore Secrets { get; init; }
    public required IUiDispatcher Ui { get; init; }
    public required FileLog Log { get; init; }
    public required DevicePreferences Device { get; init; }
    public CloudConfig? Cloud { get; init; }
    public Func<IHttpTransport> SearchTransport { get; init; } = () => new HttpClientTransport();
    public Func<ICloudTransport> CloudTransport { get; init; } = () => new HttpCloudTransport();
    public Func<ICrmHttp> CrmHttp { get; init; } = () => new CrmHttp();
    /// <summary>Папка копий по умолчанию для учётной записи (в тестах — внутри временной папки).</summary>
    public Func<string, string> DefaultBackups { get; init; } = AppPaths.DefaultBackups;


    /// <summary>Сеть для облачных дисков: адрес вводит сам пользователь, поэтому без ограничений поискового транспорта.</summary>
    public Func<IHttpTransport> DriveHttp { get; init; } = () => new DirectHttpTransport();

    /// <summary>Сервер возврата после входа через браузер. В тестах подменяется.</summary>
    public Func<IOAuthListener> OAuthListener { get; init; } = () => new OAuthLoopback();

    /// <summary>Открывает адрес в браузере по умолчанию. В приложении — Windows, в тестах — подмена.</summary>
    public Func<Uri, Task<bool>> OpenBrowser { get; init; } = _ => Task.FromResult(false);

    /// <summary>Ключ OAuth-приложения, вшитый при сборке, или null.</summary>
    public Func<OAuthProvider, OAuthClient?> BuiltInOAuth { get; init; } = _ => null;

    /// <summary>Соединение с SMTP-сервером: узел, порт, шифрование с первого байта.</summary>
    public Func<string, int, bool, ISmtpTransport> SmtpTransport { get; init; } = (host, port, tls) => new TcpSmtpTransport(host, port, tls);

    /// <summary>Скачивание больших файлов (установщик обновления) на диск с докачкой.</summary>
    public Func<IFileDownloader> Downloader { get; init; } = () => new HttpFileDownloader();

    /// <summary>Свободное место на диске, где лежит указанная папка, в байтах.</summary>
    public Func<string, long> FreeSpace { get; init; } = path =>
    {
        try
        {
            return new DriveInfo(Path.GetPathRoot(Path.GetFullPath(path))!).AvailableFreeSpace;
        }
        catch (Exception e) when (e is IOException or ArgumentException or UnauthorizedAccessException)
        {
            return long.MaxValue; // не удалось узнать — не мешаем, ошибка записи будет понятна и так
        }
    };

    /// <summary>Запускает установщик обновления. true — запущен, приложение должно закрыться.</summary>
    public Func<string, bool> LaunchInstaller { get; init; } = _ => false;

    /// <summary>Подключение с оплатой за трафик: фоновые загрузки в нём откладываются.</summary>
    public Func<bool> IsMetered { get; init; } = () => false;

    public Func<DateTimeOffset> Now { get; init; } = () => DateTimeOffset.Now;

    public Func<bool> IsOnline { get; init; } = () => System.Net.NetworkInformation.NetworkInterface.GetIsNetworkAvailable();

    /// <summary>Случайный идентификатор этого компьютера для лимитов писем. Хранится в защищённом хранилище.</summary>
    public string DeviceId
    {
        get
        {
            if (Secrets.Get("cloud.device") is { Length: > 0 } existing)
            {
                return existing;
            }

            var fresh = Guid.NewGuid().ToString();
            Secrets.Set("cloud.device", fresh);
            return fresh;
        }
    }

    public string UsersDirectory => Path.Combine(Root, "users");

    /// <summary>Окружение для тестов: временная папка, секреты в памяти, без сети.</summary>
    public static AppEnvironment ForTests(string root, CloudConfig? cloud = null, ICloudTransport? cloudTransport = null,
        Func<IHttpTransport>? search = null, ISecretStore? secrets = null, Func<IHttpTransport>? driveHttp = null,
        Func<IOAuthListener>? oauthListener = null, Func<Uri, Task<bool>>? openBrowser = null,
        Func<OAuthProvider, OAuthClient?>? builtInOAuth = null, Func<string, int, bool, ISmtpTransport>? smtp = null,
        IFileDownloader? downloader = null, Func<string, long>? freeSpace = null, Func<string, bool>? launchInstaller = null,
        Func<bool>? isMetered = null, Func<DateTimeOffset>? now = null, bool online = true) => new() {
            Root = root,
            Secrets = secrets ?? new MemorySecretStore(),
            Ui = new ImmediateDispatcher(),
            Log = new FileLog(Path.Combine(root, "logs")),
            Device = new DevicePreferences(Path.Combine(root, "device.json")),
            Cloud = cloud,
            SearchTransport = search ?? (() => new HttpClientTransport()),
            CloudTransport = cloudTransport is null ? () => new HttpCloudTransport() : () => cloudTransport,
            IsOnline = () => online,
            DriveHttp = driveHttp ?? (() => new DirectHttpTransport()),
            OAuthListener = oauthListener ?? (() => new OAuthLoopback(0)),
            OpenBrowser = openBrowser ?? (_ => Task.FromResult(true)),
            BuiltInOAuth = builtInOAuth ?? (_ => null),
            SmtpTransport = smtp ?? ((_, _, _) => throw new InvalidOperationException("SMTP в тесте не настроен")),
            DefaultBackups = username => Path.Combine(root, "default-backups", username),
            Downloader = downloader is null ? () => new HttpFileDownloader() : () => downloader,
            FreeSpace = freeSpace ?? (_ => long.MaxValue),
            LaunchInstaller = launchInstaller ?? (_ => true),
            IsMetered = isMetered ?? (() => false),
            Now = now ?? (() => DateTimeOffset.Now),
        };
}
