using System.Diagnostics;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Graphics.Imaging;

namespace Customers.Ui;

/// <summary>
/// Проверка «приложение живое»: <c>Customers.exe --smoke &lt;папка&gt;</c>. Запускает настоящее окно на чистых данных,
/// создаёт учётную запись, наполняет базу, проходит по всем разделам и страницам настроек, переключает тему,
/// выполняет экспорт, резервную копию и проверку базы, снимает скриншоты и завершается с кодом 0 (всё хорошо) или 1.
/// Используется в GitHub Actions: сборка не считается удачной, если окно не открывается или раздел падает при показе.
/// </summary>
public sealed class SmokeTest
{
    private readonly string _dir;
    private readonly List<string> _log = [];
    private readonly List<string> _failures = [];
    private int _shot;

    public SmokeTest(string directory) => _dir = Path.GetFullPath(directory);

    public async Task RunAsync()
    {
        Directory.CreateDirectory(Path.Combine(_dir, "shots"));
        // Если что-то зависло, проверка не должна держать задание CI до его лимита.
        using var watchdog = new Timer(_ =>
        {
            File.WriteAllText(Path.Combine(_dir, "result.txt"), "FAIL: проверка не уложилась в 3 минуты\n" + string.Join("\n", _log));
            Environment.Exit(2);
        }, null, TimeSpan.FromMinutes(3), Timeout.InfiniteTimeSpan);

        try
        {
            await ExecuteAsync();
        }
        catch (Exception e)
        {
            Fail("Проверка прервана", e);
        }

        var ok = _failures.Count == 0;
        var text = (ok ? "OK" : "FAIL") + $" — шагов: {_log.Count(l => l.StartsWith("ok ", StringComparison.Ordinal))}, ошибок: {_failures.Count}\n"
            + string.Join("\n", _failures.Select(f => "ERROR " + f)) + "\n" + string.Join("\n", _log) + "\n";
        File.WriteAllText(Path.Combine(_dir, "result.txt"), text);
        App.ExitCode = ok ? 0 : 1;
        App.Instance.Exit();
    }

    private async Task ExecuteAsync()
    {
        var app = App.Instance;
        app.Env.Device.Animations = false;
        await Pause(800);
        await Step("Экран входа показан", async () =>
        {
            Require(app.MainWindow.RootElement.XamlRoot is not null, "окно не показано");
            await Shot("auth");
        });

        await Step("Регистрация локальной записи", async () =>
        {
            await app.Session.RegisterAsync("smoke", "Smoke-Test-1234", "Smoke-Test-1234", false);
            Require(app.Session.Error is null, "ошибка регистрации: " + app.Session.Error);
            Require(app.Session.Current is not null, "запись не открыта");
            await Pause(600);
            Require(app.MainWindow.Shell is not null, "основной экран не показан");
        });

        var model = app.Session.Current;
        var shell = app.MainWindow.Shell;
        if (model is null || shell is null)
        {
            return;
        }

        await Step("База: запись и чтение лидов", async () =>
        {
            Require(model.StartupError is null, "база не открылась: " + model.StartupError);
            Seed(model);
            Require(model.AllLeads.Count == 5, $"ожидалось 5 лидов, найдено {model.AllLeads.Count}");
            await Pause(300);
        });

        foreach (var section in new[] { NavSection.Home, NavSection.All, NavSection.New, NavSection.Favorites, NavSection.Archive, NavSection.Excluded, NavSection.Sources, NavSection.Runs })
        {
            await Step("Раздел «" + section + "»", async () =>
            {
                shell.Navigate(section);
                await Pause(450);
                Require(model.Section == section, "раздел не переключился");
                await Shot("section-" + section);
            });
        }

        await Step("Лид выбран, показана карточка", async () =>
        {
            shell.Navigate(NavSection.All);
            await Pause(300);
            var first = model.Rows.FirstOrDefault();
            Require(first is not null, "список пуст");
            model.SetSelection([first!.Id]);
            await Pause(500);
            Require(model.SelectedLead is not null, "лид не выбран");
            await Shot("lead-selected");
        });

        await Step("Избранное, заметка, архив", async () =>
        {
            var id = model.SelectedLead!.Id;
            model.ToggleFavorite([id]);
            model.SetNote(id, "Проверочная заметка");
            Require(model.Lead(id)!.Favorite, "избранное не сохранилось");
            Require(model.Lead(id)!.Note == "Проверочная заметка", "заметка не сохранилась");
            model.SetArchived([id], true);
            model.SetArchived([id], false);
            await Pause(300);
        });

        await Step("Поиск по тексту и фильтры", async () =>
        {
            model.SearchText = "Лаванда";
            await Pause(300);
            Require(model.VisibleCount == 1, $"поиск по тексту: найдено {model.VisibleCount}");
            await Shot("search-text");
            model.ResetFilters();
        });

        foreach (var section in Enum.GetValues<SettingsSection>())
        {
            await Step("Настройки: " + section.Title(), async () =>
            {
                shell.OpenSettings(section);
                await Pause(450);
                await Shot("settings-" + section);
            });
        }

        await Step("Тёмная и светлая тема, материалы окна", async () =>
        {
            foreach (var backdrop in Enum.GetValues<BackdropChoice>())
            {
                app.Env.Device.Backdrop = backdrop;
                await Pause(250);
            }

            app.Env.Device.Backdrop = BackdropChoice.Mica;
            app.Env.Device.Theme = ThemeChoice.Dark;
            await Pause(400);
            shell.Navigate(NavSection.All);
            await Pause(400);
            await Shot("dark");
            app.Env.Device.Theme = ThemeChoice.Light;
            await Pause(400);
            await Shot("light");
            app.Env.Device.Theme = ThemeChoice.System;
        });

        await Step("Панели: скрыть и показать", async () =>
        {
            app.Env.Device.NavHidden = true;
            await Pause(300);
            app.Env.Device.NavHidden = false;
            app.Env.Device.InspectorShown = false;
            await Pause(300);
            app.Env.Device.InspectorShown = true;
            await Pause(300);
        });

        await Step("Экспорт и импорт CSV и JSON", () =>
        {
            foreach (var format in Enum.GetValues<ExportFormat>())
            {
                var path = Path.Combine(_dir, "export." + format.Extension());
                model.Export(model.AllLeads.ToList(), format, ExportFields.Defaults.ToList(), path);
                Require(File.Exists(path) && new FileInfo(path).Length > 20, "файл экспорта пуст: " + format);
                var result = model.ImportLeads(path);
                Require(result is not null && result.Problems.Count == 0, "импорт вернул замечания: " + string.Join("; ", result?.Problems ?? []));
            }

            Require(model.AllLeads.Count == 5, $"после повторного импорта лидов {model.AllLeads.Count}, ожидалось 5 (без дублей)");
            return Task.CompletedTask;
        });

        await Step("Резервная копия, проверка и восстановление", () =>
        {
            var backup = model.BackupNow();
            Require(backup is not null && File.Exists(backup), "копия не создана: " + model.LastError);
            Require(model.ProbeBackup(backup!) == 5, "в копии не то число лидов");
            Require(model.CheckIntegrity().Count == 0, "проверка целостности нашла проблемы");
            Require(model.Restore(backup!), "восстановление не удалось: " + model.LastError);
            Require(model.AllLeads.Count == 5, "после восстановления лидов " + model.AllLeads.Count);
            return Task.CompletedTask;
        });

        await Step("Исключения", async () =>
        {
            model.Exclude(ExclusionKind.Domain, "example.org");
            Require(model.Exclusions.Count == 1, "исключение не добавлено");
            model.RemoveExclusion(model.Exclusions[0].Id);
            Require(model.Exclusions.Count == 0, "исключение не удалено");
            await Pause(100);
        });

        await Step("Локальная запись: смена пароля и выход", async () =>
        {
            var error = await app.Session.ChangePasswordAsync("Smoke-Test-1234", "Smoke-Test-5678", "Smoke-Test-5678");
            Require(error is null, "смена пароля: " + error);
            app.Session.Logout();
            await Pause(500);
            Require(app.Session.Current is null, "выход не выполнен");
            await app.Session.LoginAsync("smoke", "Smoke-Test-5678", false);
            Require(app.Session.Current is not null, "повторный вход не удался: " + app.Session.Error);
            await Pause(500);
            Require(app.Session.Current!.AllLeads.Count == 5, "после входа данные не на месте");
        });

        await Step("Нет необработанных сбоев в журнале", () =>
        {
            Require(app.Env.Log.PendingCrashReports().Count == 0, "приложение записало отчёты о сбоях: " + string.Join(", ", app.Env.Log.PendingCrashReports()));
            return Task.CompletedTask;
        });
    }

    private static void Seed(AppModel model)
    {
        var store = model.Store!;
        LeadData Order(string title, double score, Relevance relevance, string ext) => new() {
            Kind = LeadKind.Order,
            Source = "fl_ru",
            ExternalId = ext,
            Title = title,
            Url = "https://example.com/p/" + ext,
            Description = "Нужен " + title,
            DiscoveredAt = DateTimeOffset.Now.AddHours(-int.Parse(ext, System.Globalization.CultureInfo.InvariantCulture)),
            Score = score,
            Relevance = relevance,
            ScoreReasons = ["Подходит по ключевым словам"],
        };
        Save(store, Order("Сайт для салона красоты", 82, Relevance.High, "1"));
        Save(store, Order("Telegram-бот для кофейни", 64, Relevance.Medium, "2"));
        Save(store, Order("Мобильное приложение для доставки", 71, Relevance.Medium, "3"));
        Save(store, Order("Мусорный заказ", 8, Relevance.Rejected, "4"));
        Save(store, new LeadData {
            Kind = LeadKind.Organization,
            Source = "osm_organizations",
            ExternalId = "n/1",
            Title = "Лаванда",
            Region = "Ереван",
            Category = "Салоны красоты",
            Phone = "+374 10 000000",
            DiscoveredAt = DateTimeOffset.Now,
            Score = 55,
            Relevance = Relevance.Medium,
        });
        model.Reload();
    }

    // Идентификатор и отпечаток считаются так же, как при настоящем поиске и импорте.
    private static void Save(LeadStore store, LeadData data) =>
        store.Save(data, SearchText.LeadId(data.Source, data.ExternalId), SearchText.Fingerprint(data));

    private async Task Step(string name, Func<Task> work)
    {
        var timer = Stopwatch.StartNew();
        try
        {
            await work();
            _log.Add($"ok   {name} ({timer.ElapsedMilliseconds} мс)");
        }
        catch (Exception e)
        {
            Fail(name, e);
        }
    }

    private void Fail(string name, Exception e)
    {
        _failures.Add($"{name}: {e.Message}");
        _log.Add($"FAIL {name}: {e}");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private static Task Pause(int milliseconds) => Task.Delay(milliseconds);

    /// <summary>Снимок окна в PNG. Если снять не получилось, проверка не падает: скриншоты нужны для просмотра, а не как критерий.</summary>
    private async Task Shot(string name)
    {
        try
        {
            var element = App.Instance.MainWindow.RootElement;
            var bitmap = new RenderTargetBitmap();
            await bitmap.RenderAsync(element);
            var pixels = await bitmap.GetPixelsAsync();
            var path = Path.Combine(_dir, "shots", $"{++_shot:00}-{name}.png");
            using var file = File.Create(path);
            using var stream = file.AsRandomAccessStream();
            var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
            encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied, (uint)bitmap.PixelWidth, (uint)bitmap.PixelHeight, 96, 96, pixels.ToArray());
            await encoder.FlushAsync();
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            _log.Add($"note снимок «{name}» не сохранён: {e.Message}");
        }
    }
}
