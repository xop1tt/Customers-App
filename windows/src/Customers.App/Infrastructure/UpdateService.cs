using System.Diagnostics;
using System.Globalization;

namespace Customers.Ui;

/// <summary>
/// Обновление приложения для окна: связывает модель обновлений (Customers.Presentation.UpdateModel) с Windows —
/// запуск установщика, определение платного подключения, фоновый таймер, сообщения пользователю.
/// Установка никогда не начинается сама: только по нажатию «Установить и перезапустить».
/// </summary>
internal sealed class UpdateService
{
    private readonly AppEnvironment _env;
    private System.Threading.Timer? _timer;
    private int _running;

    public UpdateService(AppEnvironment env)
    {
        _env = env;
        Model = new UpdateModel(env, Current);
        Model.UpdateReady += OnReady;
    }

    public static AppVersion Current => AppVersion.Parse(AppBuild.Version) ?? AppVersion.Parse("1.0.0")!;

    public UpdateModel Model { get; }

    /// <summary>Тихая установка поверх. Параметр RELAUNCH сообщает установщику, что приложение нужно открыть снова.</summary>
    public static bool LaunchInstaller(string path)
    {
        using var process = Process.Start(new ProcessStartInfo(path, "/SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /RELAUNCH=1") { UseShellExecute = true });
        return process is not null;
    }

    /// <summary>Подключение с лимитом трафика или в роуминге: большие загрузки в фоне там откладываются.</summary>
    public static bool IsMetered()
    {
        try
        {
            var cost = Windows.Networking.Connectivity.NetworkInformation.GetInternetConnectionProfile()?.GetConnectionCost();
            return cost is not null && cost.NetworkCostType != Windows.Networking.Connectivity.NetworkCostType.Unrestricted
                && cost.NetworkCostType != Windows.Networking.Connectivity.NetworkCostType.Unknown;
        }
        catch (Exception e) when (e is System.Runtime.InteropServices.COMException or InvalidOperationException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>Запускает фоновую работу: первая проверка через несколько секунд после старта, дальше раз в 10 минут смотрим, не пора ли.</summary>
    public void Start()
    {
        _timer = new System.Threading.Timer(_ => _ = TickAsync(), null, TimeSpan.FromSeconds(8), TimeSpan.FromMinutes(10));
    }

    public void Stop()
    {
        _timer?.Dispose();
        _timer = null;
    }

    private async Task TickAsync()
    {
        if (Interlocked.Exchange(ref _running, 1) == 1)
        {
            return;
        }

        try
        {
            await Model.RunScheduledAsync().ConfigureAwait(false);
        }
        catch (Exception e) when (e is HttpFailure or HttpRequestException or IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            _env.Log.Warn("Фоновое обновление не удалось: " + e.Message);
        }
        finally
        {
            Volatile.Write(ref _running, 0);
        }
    }

    /// <summary>Скачивание закончено: сообщаем, но ничего не перезапускаем и не устанавливаем.</summary>
    private void OnReady(StagedUpdate staged)
    {
        var text = $"Версия {staged.Version} скачана и проверена. Установить можно в любой момент: приложение перезапустится, данные сохранятся.";
        App.Instance.Notifier.Post(new Notice(NoticeKind.Info, $"Готово обновление {staged.Version}", text, "Установить и перезапустить", () => _ = InstallAsync()));
        App.Instance.Notifier.Toast($"Готово обновление {staged.Version}", "Откройте Customers → Настройки → О программе, чтобы установить.");
    }

    /// <summary>Установка по согласию: подтверждение, запуск установщика и выход из приложения.</summary>
    public async Task InstallAsync()
    {
        if (Model.Staged is not { } staged)
        {
            return;
        }

        var ok = await Dialogs.ConfirmAsync($"Установить версию {staged.Version}?",
            "Приложение закроется, установится обновление и откроется снова. Лиды, учётные записи и настройки сохранятся.",
            "Установить и перезапустить", "Позже");
        if (!ok)
        {
            return;
        }

        try
        {
            if (await Model.InstallAsync().ConfigureAwait(true))
            {
                App.Instance.Background.Quit();
                return;
            }
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or IOException or UnauthorizedAccessException)
        {
            _env.Log.Error("Обновление не установлено", e);
        }

        App.Instance.Notifier.Error("Не удалось обновиться", Model.Error ?? "Установщик не запустился. Приложение осталось прежним.");
    }

    public static string FormatSize(long? bytes) => bytes is { } b ? (b / 1048576.0).ToString("0.#", CultureInfo.CurrentCulture) + " МБ" : "";
}
