namespace Customers.Ui;

/// <summary>Параметры командной строки. Для обычного запуска их не нужно: они нужны проверкам и сопровождению.</summary>
public sealed class StartupOptions
{
    /// <summary>--smoke &lt;папка&gt;: открыть окно, пройти по всем разделам, сохранить снимки и результат в папку и выйти (проверка в CI).</summary>
    public string? SmokeDirectory { get; private init; }

    /// <summary>--data &lt;папка&gt;: хранить данные в другой папке (по умолчанию %LOCALAPPDATA%\Customers).</summary>
    public string? DataRoot { get; private init; }

    /// <summary>Ссылка leadgenerator://… из письма, если приложение запущено по ней.</summary>
    public string? Link { get; private init; }

    /// <summary>--after-pid &lt;номер&gt;: подождать завершения этого процесса (так приложение перезапускает само себя).</summary>
    public int? AfterProcess { get; private init; }

    /// <summary>--background: запуск вместе с Windows; окно не показывается, приложение остаётся в области уведомлений.</summary>
    public bool Background { get; private init; }

    public bool Smoke => SmokeDirectory is not null;

    public static StartupOptions Parse(string[] args)
    {
        string? smoke = null;
        string? data = null;
        string? link = null;
        int? after = null;
        var background = false;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--smoke" when i + 1 < args.Length:
                    smoke = args[++i];
                    break;
                case "--data" when i + 1 < args.Length:
                    data = args[++i];
                    break;
                case "--after-pid" when i + 1 < args.Length && int.TryParse(args[i + 1], out var pid):
                    after = pid;
                    i++;
                    break;
                case "--background":
                    background = true;
                    break;
                default:
                    if (args[i].StartsWith("leadgenerator:", StringComparison.OrdinalIgnoreCase))
                    {
                        link = args[i];
                    }

                    break;
            }
        }

        return new StartupOptions { SmokeDirectory = smoke, DataRoot = data, Link = link, AfterProcess = after, Background = background };
    }
}
