using System.Diagnostics;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
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
        App.Instance.Background.Dispose();
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

        await Step("Мастер первого запуска: шаги, назад, пропуск, готово", () => WelcomeAsync(model, shell));

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

        await Step("«Что нового»: показ, закрытие, повторно не показывается", () => WhatsNewAsync(app));

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
                // Для обратного импорта нужны все поля: с набором по умолчанию нет ID и описания, и лид считается новым.
                model.Export(model.AllLeads.ToList(), format, ExportFields.All.ToList(), path);
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

        await Step("Акцентный цвет меняется без перезапуска", () => AccentLiveAsync(app));
        await Step("Облачные диски: WebDAV, выгрузка копии, отключение", () => DrivesAsync(app, model, shell));
        await Step("Вход через браузер: возврат на localhost", OAuthReturnAsync);
        await Step("Почта: настройки, пароль в DPAPI, ошибка соединения", () => MailAsync(app, model, shell));
        await Step("Звонки: поиск приложения для tel:", async () =>
        {
            shell.OpenSettings(SettingsSection.Calls);
            await Pause(500);
            var handlers = await CallHandlers.FindAsync();
            _log.Add($"note приложений для звонков в системе: {handlers.Count}");
        });
        await Step("Работа в фоне: скрыть и вернуть окно, меню значка, автозапуск", () => BackgroundAsync(app, model, shell));

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

    // MARK: Проверки новых возможностей

    private static Windows.UI.Color? PaintedFill(Button button)
    {
        button.UpdateLayout();
        return Find(button) is { Background: SolidColorBrush brush } ? brush.Color : null;

        static ContentPresenter? Find(DependencyObject parent)
        {
            for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
            {
                var child = VisualTreeHelper.GetChild(parent, i);
                if (child is ContentPresenter { Name: "ContentPresenter" } presenter)
                {
                    return presenter;
                }

                if (Find(child) is { } nested)
                {
                    return nested;
                }
            }

            return null;
        }
    }

    private async Task AccentLiveAsync(App app)
    {
        var host = (Grid)app.MainWindow.RootElement;
        var probe = new Button { Content = "Акцент", Style = UiKit.Style("AccentButtonStyle"), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, 12, 12) };
        host.Children.Add(probe);
        try
        {
            await Pause(300);
            foreach (var theme in new[] { ThemeChoice.Light, ThemeChoice.Dark })
            {
                app.Env.Device.Theme = theme;
                await Pause(400);
                var dark = theme == ThemeChoice.Dark;
                foreach (var hex in new[] { "#C42B1C", "#107C10", "#744DA9" })
                {
                    app.Env.Device.Accent = hex;
                    await Pause(300);
                    var expected = Appearance.Shades(Appearance.ParseColor(hex)!.Value).Fill(dark);
                    var painted = PaintedFill(probe);
                    Require(painted is not null, "акцентная кнопка не нарисована");
                    Require(painted == expected, $"{theme} {hex}: кнопка закрашена {painted}, ожидалось {expected}");
                }

                await Shot("accent-" + theme);
            }

            app.Env.Device.Accent = null;
            await Pause(300);
            var system = PaintedFill(probe);
            Require(system is not null && system != Appearance.Shades(Appearance.ParseColor("#744DA9")!.Value).Fill(true), "после сброса цвет остался прежним");
        }
        finally
        {
            host.Children.Remove(probe);
            app.Env.Device.Accent = null;
            app.Env.Device.Theme = ThemeChoice.System;
        }
    }

    /// <summary>Простейший WebDAV-сервер на этом компьютере: проверяет вход и принимает файл. Нужен, чтобы выгрузка шла по настоящему HTTP.</summary>
    private sealed class FakeDav : IDisposable
    {
        private readonly System.Net.Sockets.TcpListener _listener = new(System.Net.IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();

        public FakeDav()
        {
            _listener.Start();
            Port = ((System.Net.IPEndPoint)_listener.LocalEndpoint).Port;
            _ = Task.Run(AcceptAsync);
        }

        public int Port { get; }

        public List<string> Requests { get; } = [];

        public long UploadedBytes { get; private set; }

        private async Task AcceptAsync()
        {
            try
            {
                while (!_stop.IsCancellationRequested)
                {
                    var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                    _ = Task.Run(() => ServeAsync(client));
                }
            }
            catch (Exception e) when (e is OperationCanceledException or ObjectDisposedException or System.Net.Sockets.SocketException)
            {
            }
        }

        private async Task ServeAsync(System.Net.Sockets.TcpClient client)
        {
            using var _ = client;
            try
            {
                var stream = client.GetStream();
                var head = new List<byte>();
                var one = new byte[1];
                while (!(head.Count >= 4 && head[^4] == 13 && head[^3] == 10 && head[^2] == 13 && head[^1] == 10))
                {
                    if (await stream.ReadAsync(one) == 0)
                    {
                        return;
                    }

                    head.Add(one[0]);
                }

                var lines = System.Text.Encoding.ASCII.GetString([.. head]).Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
                var method = lines[0].Split(' ')[0];
                var path = lines[0].Split(' ')[1];
                var headers = lines.Skip(1).Select(l => l.Split(':', 2)).Where(p => p.Length == 2).ToDictionary(p => p[0].Trim().ToLowerInvariant(), p => p[1].Trim());
                var length = headers.TryGetValue("content-length", out var text) ? long.Parse(text, System.Globalization.CultureInfo.InvariantCulture) : 0;
                var buffer = new byte[16 * 1024];
                for (var left = length; left > 0;)
                {
                    var read = await stream.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, left)));
                    if (read == 0)
                    {
                        break;
                    }

                    left -= read;
                }

                var authorized = headers.GetValueOrDefault("authorization") == DriveUpload.BasicAuth("u", "p");
                lock (Requests)
                {
                    Requests.Add($"{method} {path} {(authorized ? "auth" : "noauth")}");
                }

                var status = !authorized ? "401 Unauthorized" : method == "PROPFIND" ? "207 Multi-Status" : "201 Created";
                if (authorized && method == "PUT")
                {
                    UploadedBytes = length;
                }

                await stream.WriteAsync(System.Text.Encoding.ASCII.GetBytes($"HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
            }
            catch (Exception e) when (e is IOException or System.Net.Sockets.SocketException or ObjectDisposedException)
            {
            }
        }

        public void Dispose()
        {
            _stop.Cancel();
            _listener.Stop();
        }
    }

    private async Task DrivesAsync(App app, AppModel model, ShellView shell)
    {
        using var dav = new FakeDav();
        var drives = model.Drives;
        var address = $"http://127.0.0.1:{dav.Port}/dav";
        Require(!await drives.ConnectWebDavAsync(DriveService.WebDav, address, "u", "wrong"), "неверный пароль принят");
        Require(drives.Error is not null && !drives.IsConnected(DriveService.WebDav), "ошибка входа не показана");
        Require(await drives.ConnectWebDavAsync(DriveService.WebDav, address, "u", "p"), "WebDAV не подключился: " + drives.Error);
        Require(app.Env.Secrets.Get(DriveConnection.SecretName(DriveService.WebDav, model.Username)) is { Length: > 0 }, "подключение не сохранено в DPAPI");
        shell.OpenSettings(SettingsSection.Drives);
        await Pause(500);
        await Shot("drives-connected");
        Require(await model.UploadBackupAsync(DriveService.WebDav), "выгрузка не удалась: " + drives.Error);
        var newest = model.BackupFiles.OrderByDescending(b => b.CreatedAt).First();
        Require(dav.UploadedBytes == new FileInfo(newest.Path).Length && dav.UploadedBytes > 0, $"на сервер ушло {dav.UploadedBytes} байт, копия {newest.Size}");
        string[] expected = ["PROPFIND", "PROPFIND", "MKCOL", "PUT"];
        var got = dav.Requests.Select(r => r.Split(' ')[0]).ToArray();
        Require(got.SequenceEqual(expected), "запросы к серверу: " + string.Join(", ", dav.Requests));
        drives.Disconnect(DriveService.WebDav);
        Require(!drives.IsConnected(DriveService.WebDav) && app.Env.Secrets.Get(DriveConnection.SecretName(DriveService.WebDav, model.Username)) is null, "подключение не удалено");
        shell.OpenSettings(SettingsSection.Drives);
        await Pause(300);
    }

    private async Task WelcomeAsync(AppModel model, ShellView shell)
    {
        for (var i = 0; i < 20 && shell.ActiveWizard is null; i++)
        {
            await Pause(200);
        }

        var wizard = shell.ActiveWizard;
        Require(wizard is not null, "у новой учётной записи не показан мастер первого запуска");
        Require(wizard!.Step == WelcomeStep.Intro && !wizard.CanGoBack, "мастер начинается не с описания");
        var seen = new List<WelcomeStep>();
        while (true)
        {
            seen.Add(wizard.Step);
            await Pause(500);
            await Shot("welcome-" + wizard.Step);
            if (wizard.IsLast)
            {
                break;
            }

            if (wizard.Step == WelcomeStep.Drives)
            {
                wizard.Skip(); // необязательный шаг пропускается
            }
            else
            {
                wizard.Next();
            }
        }

        Require(seen.SequenceEqual(WelcomeSteps.All), "мастер прошёл не все шаги: " + string.Join(", ", seen));
        Require(wizard.StateOf(WelcomeStep.Drives) == WelcomeStepState.Skipped, "пропущенный шаг не отмечен");
        wizard.Back();
        Require(wizard.Step == WelcomeStep.Drives, "«Назад» не вернул на предыдущий шаг");
        await Pause(300);
        wizard.Next();
        // Оформление применяется сразу, прямо в мастере.
        App.Instance.Env.Device.Theme = ThemeChoice.Dark;
        await Pause(400);
        await Shot("welcome-dark");
        App.Instance.Env.Device.Theme = ThemeChoice.System;
        wizard.Finish();
        await Pause(500);
        Require(model.Prefs.WelcomeDone, "мастер не запомнил, что он пройден");
        Require(shell.ActiveWizard is null, "мастер остался на экране");
        Require(model.Section == NavSection.Home, "после мастера не открыта главная страница");
        await Shot("welcome-finished");
    }

    private async Task WhatsNewAsync(App app)
    {
        var stage = new UpdateStage(Path.Combine(app.Env.Root, "updates"));
        var version = UpdateService.Current;
        stage.SaveInstalledNotes(new StagedUpdate(version.ToString(), "Customers " + version, "## Что изменилось\n- **Быстрее** запуск\n- Фоновое скачивание обновлений\n\nОбычный абзац с [ссылкой](https://example.com).", null, "", "", 0, DateTimeOffset.Now));
        app.Env.Device.LastSeenVersion = "0.9.0";
        var model = WhatsNewModel.Create(app.Env, version, hasExistingData: true);
        Require(model is not null, "после обновления экран «Что нового» не создан");
        var shown = WhatsNewDialog.ShowAsync(model!);
        await Pause(900);
        Require(WhatsNewDialog.Current is not null, "окно «Что нового» не показано");
        Require(model!.Lines.Count == 4 && model.Lines.All(l => !l.Text.Contains("**", StringComparison.Ordinal)), "в списке изменений остались служебные символы");
        await Shot("whats-new");
        WhatsNewDialog.Current!.Hide();
        await shown;
        Require(app.Env.Device.LastSeenVersion == version.ToString(), "версия не запомнена после закрытия");
        Require(WhatsNewModel.Create(app.Env, version, hasExistingData: true) is null, "экран показан повторно для той же версии");
    }

    private static async Task OAuthReturnAsync()
    {
        using var listener = new OAuthLoopback(0);
        var wait = listener.WaitForCallbackAsync(CancellationToken.None);
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        // Браузер переходит именно на «localhost»: он может быть и IPv4, и IPv6, сервер должен ответить в обоих случаях.
        using var reply = await http.GetAsync($"http://localhost:{listener.Port}/oauth/callback?code=smoke-code&state=smoke-state");
        Require(reply.IsSuccessStatusCode, "страница возврата ответила " + (int)reply.StatusCode);
        var callback = await wait.WaitAsync(TimeSpan.FromSeconds(10));
        Require(callback.Validated("smoke-state") == "smoke-code", "код авторизации потерян");
    }

    private async Task MailAsync(App app, AppModel model, ShellView shell)
    {
        var mail = model.Mail;
        mail.Account = MailAccount.Preset("smoke@gmail.com", "Smoke");
        mail.Delivery = MailDelivery.Smtp;
        mail.SetPassword("app-password");
        Require(mail.SmtpReady, "почта не готова к отправке");
        Require(app.Env.Secrets.Get(MailModel.PasswordSecret(model.Username)) == "app-password", "пароль не сохранился в DPAPI");
        shell.OpenSettings(SettingsSection.Mail);
        await Pause(500);
        await Shot("mail-smtp");

        // Порт, на котором никто не слушает: проверяем, что настоящее соединение даёт понятную ошибку, а не зависание.
        int closedPort;
        using (var probe = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0))
        {
            probe.Start();
            closedPort = ((System.Net.IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
        }

        mail.Account = mail.Account! with { Host = "127.0.0.1", Port = closedPort };
        Require(!await mail.SendAsync(new OutgoingMail("to@example.com", "Проверка", "Текст")), "письмо «отправилось» в пустоту");
        Require(mail.LastError?.Contains("Не удалось связаться", StringComparison.Ordinal) == true, "ошибка соединения непонятна: " + mail.LastError);
        Require(!mail.Sending, "индикатор отправки завис");

        mail.Forget();
        Require(!mail.HasPassword && mail.Account is null && mail.Delivery == MailDelivery.MailApp, "почта не забыта");
        shell.OpenSettings(SettingsSection.Mail);
        await Pause(300);
    }

    private async Task BackgroundAsync(App app, AppModel model, ShellView shell)
    {
        var window = app.MainWindow;
        window.HideToTray();
        await Pause(300);
        Require(!window.AppWindow.IsVisible, "окно не спряталось");
        window.BringToFront();
        await Pause(300);
        Require(window.AppWindow.IsVisible, "окно не вернулось из области уведомлений");

        var host = app.Background;
        _log.Add($"note значок в области уведомлений создан: {host.Available}");
        var items = host.Items();
        Require(items.Any(i => i.Text.StartsWith("Открыть", StringComparison.Ordinal)) && items.Any(i => i.Text.StartsWith("Выйти", StringComparison.Ordinal)), "в меню значка нет «Открыть» или «Выйти»");
        Require(items.Any(i => i.Text == "Найти сейчас") && items.Any(i => i.Text == $"Новые лиды: {model.NewLeads}"), "меню значка не показывает состояние: " + string.Join(" | ", items.Select(i => i.Text)));
        Require(host.Tip().Contains($"новых лидов: {model.NewLeads}", StringComparison.Ordinal), "подсказка значка: " + host.Tip());

        Require(AutoStart.Set(true, true), "автозапуск не включился");
        try
        {
            Require(AutoStart.IsEnabled(), "автозапуск не виден после включения");
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
            Require(key?.GetValue("Customers") is string command && command.Contains("--background", StringComparison.Ordinal), "в автозапуске нет ключа --background");
        }
        finally
        {
            AutoStart.Set(false, true);
        }

        Require(!AutoStart.IsEnabled(), "автозапуск не выключился");
        shell.OpenSettings(SettingsSection.Background);
        await Pause(500);
        await Shot("background");
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
