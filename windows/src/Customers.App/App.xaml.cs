using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace Customers.Ui;

public partial class App : Application
{
    private int _recentErrors;
    private DateTimeOffset _errorWindowStart = DateTimeOffset.MinValue;

    public App(StartupOptions options)
    {
        Options = options;
        InitializeComponent();
        UnhandledException += OnUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += (_, e) => RecordCrash(e.ExceptionObject as Exception, "AppDomain");
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Env?.Log.Error("Необработанная ошибка фоновой задачи", e.Exception);
            e.SetObserved();
        };
    }

    public static App Instance => (App)Current;

    public static int ExitCode { get; set; }

    public StartupOptions Options { get; }

    public AppEnvironment Env { get; private set; } = null!;

    public SessionModel Session { get; private set; } = null!;

    public IUiDispatcher Ui { get; private set; } = null!;

    internal Notifier Notifier { get; } = new();

    internal BackgroundHost Background { get; } = new();

    internal UpdateService Updates { get; private set; } = null!;

    /// <summary>Облегчённый режим: включается по режиму экономии энергии Windows или низкому заряду.</summary>
    public LightModeModel LightMode { get; private set; } = null!;

    private PowerWatcher? _power;

    /// <summary>На этом компьютере уже были учётные записи до текущего запуска.</summary>
    internal bool ExistingInstall { get; private set; }

    public MainWindow MainWindow { get; private set; } = null!;

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            Start();
        }
        catch (Exception e)
        {
            // Приложение не смогло даже запуститься: пишем отчёт и говорим об этом человеку, а не исчезаем молча.
            RecordCrash(e, "Запуск");
            NativeMessage.Show("Customers не удалось запустить",
                $"{e.Message}\n\nПодробности записаны в папку журналов:\n{Path.Combine(Options.DataRoot ?? AppPaths.DefaultRoot, "logs")}");
            ExitCode = 1;
            Exit();
        }
    }

    private void Start()
    {
        var root = Options.DataRoot ?? (Options.Smoke ? Path.Combine(Path.GetFullPath(Options.SmokeDirectory!), "data") : AppPaths.DefaultRoot);
        Directory.CreateDirectory(root);
        Ui = new DispatcherUi(DispatcherQueue.GetForCurrentThread());
        var log = new FileLog(AppPaths.Logs(root));
        log.Info($"Запуск Customers {AppBuild.Version}, {System.Runtime.InteropServices.RuntimeInformation.OSDescription}");
        log.Prune();
        var device = new DevicePreferences(Path.Combine(root, "device.json"));
        Env = new AppEnvironment {
            Root = root,
            Secrets = new DpapiSecretStore(AppPaths.Secrets(root)),
            Ui = Ui,
            Log = log,
            Device = device,
            Cloud = CloudSettings.Load(),
            BuiltInOAuth = OAuthBuild.Client,
            OpenBrowser = Launcher.OpenInBrowserAsync,
            LaunchInstaller = UpdateService.LaunchInstaller,
            IsMetered = UpdateService.IsMetered,
        };
        // Данные уже были до этого запуска — значит, это не первая установка (для экрана «Что нового» и мастера).
        ExistingInstall = Directory.Exists(Env.UsersDirectory) && Directory.EnumerateFileSystemEntries(Env.UsersDirectory).Any();
        Updates = new UpdateService(Env);
        LightMode = new LightModeModel(device);
        if (!Options.Smoke)
        {
            _power = new PowerWatcher(LightMode, Ui, log);
            _power.Start();
        }

        Appearance.ApplyAccent(device.Accent);
        Appearance.FollowSystemAccent(device);
        Session = new SessionModel(Env);
        MainWindow = new MainWindow();
        Background.Start();
        // Запуск вместе с Windows (--background): остаёмся в области уведомлений, если окно сейчас не нужно (войти в запись не требуется).
        var hidden = Options.Background && !Options.Smoke && device.StartMinimized && Background.Available && Session.Current is not null;
        if (hidden)
        {
            Env.Log.Info("Запуск в фоне: окно скрыто");
            MainWindow.MarkHiddenAtStart();
        }
        else
        {
            MainWindow.Activate();
        }

        if (!Options.Smoke)
        {
            SingleInstance.Listen(message => Ui.Post(() => OnSecondLaunch(message)));
            Notifier.InitializeSystem();
            if (Options.Link is { } link)
            {
                _ = Session.HandleLinkAsync(link);
            }

            _ = AfterStartAsync();
        }
        else
        {
            _ = new SmokeTest(Options.SmokeDirectory!).RunAsync();
        }
    }

    private void OnSecondLaunch(string message)
    {
        MainWindow.BringToFront();
        if (message.StartsWith("leadgenerator:", StringComparison.OrdinalIgnoreCase))
        {
            _ = Session.HandleLinkAsync(message);
        }
    }

    /// <summary>После запуска: сообщение о прошлом сбое и (по настройке) проверка обновлений.</summary>
    private async Task AfterStartAsync()
    {
        try
        {
            await Task.Delay(800);
            var crashes = Env.Log.PendingCrashReports();
            if (crashes.Count > 0)
            {
                var open = await Dialogs.ConfirmAsync("В прошлый раз приложение завершилось с ошибкой",
                    "Данные в базе защищены: изменения записываются сразу, а база проверяется при открытии. Отчёт об ошибке сохранён в папке журналов, его можно приложить к описанию проблемы.",
                    "Открыть папку журналов", "Закрыть");
                Env.Log.DismissCrashReports();
                if (open)
                {
                    Launcher.OpenFolder(Env.Log.Directory);
                }
            }

            Updates.Start();
        }
        catch (Exception e) when (e is HttpFailure or HttpRequestException or TaskCanceledException or IOException)
        {
            Env.Log.Warn("Начальные действия после запуска не выполнены: " + e.Message);
        }
    }

    private void OnUnhandledException(object sender, Microsoft.UI.Xaml.UnhandledExceptionEventArgs e)
    {
        RecordCrash(e.Exception, "UI");
        var now = DateTimeOffset.UtcNow;
        if (now - _errorWindowStart > TimeSpan.FromMinutes(1))
        {
            _errorWindowStart = now;
            _recentErrors = 0;
        }

        // Одна ошибка в обработчике не должна закрывать приложение. Но если ошибки идут подряд, лучше остановиться.
        if (++_recentErrors <= 5)
        {
            e.Handled = true;
            Notifier.Error("Что-то пошло не так", "Действие не выполнено. Подробности записаны в журнал: Настройки → Данные → Открыть журналы.");
        }
    }

    private void RecordCrash(Exception? e, string context)
    {
        if (e is null)
        {
            return;
        }

        try
        {
            var root = Options.DataRoot ?? AppPaths.DefaultRoot;
            var log = Env?.Log ?? new FileLog(AppPaths.Logs(root));
            log.Error("Необработанная ошибка (" + context + ")", e);
            log.WriteCrash(e, context);
        }
        catch (Exception inner) when (inner is IOException or UnauthorizedAccessException)
        {
            // Нет места для журнала — больше ничего сделать нельзя.
        }
    }
}
