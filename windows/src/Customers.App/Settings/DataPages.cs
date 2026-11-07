using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

internal sealed class BackupPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    protected override SettingsSection Kind => SettingsSection.Backup;

    protected override string Lead => "Копия базы лидов — обычный файл. Хранится на этом компьютере; чтобы не потерять её вместе с диском, выберите папку на другом диске или в облачном хранилище.";

    protected override void Fill()
    {
        var prefs = Model.Prefs;
        Add(UiKit.SettingRow("Автоматическая копия раз в сутки", "Создаётся при работе приложения, не чаще раза в день.", UiKit.Toggle(prefs.AutoBackup, v => prefs.AutoBackup = v)));
        Add(UiKit.SettingRow("Сколько копий хранить", "Более старые удаляются автоматически.", UiKit.Number(prefs.KeepBackups, 1, 365, v => prefs.KeepBackups = (int)v)));

        var folder = UiKit.Muted(prefs.BackupDirectory);
        folder.IsTextSelectionEnabled = true;
        var change = UiKit.TextButton("Выбрать…", () => Run(async () =>
        {
            if (await Pickers.PickFolderAsync() is { } path)
            {
                prefs.BackupDirectory = path;
                Refresh();
            }
        }));
        var open = UiKit.TextButton("Открыть", () =>
        {
            Directory.CreateDirectory(prefs.BackupDirectory);
            Launcher.OpenFolder(prefs.BackupDirectory);
        });
        Add(UiKit.SettingRow("Папка для копий", null, UiKit.HStack(8, change, open)));
        Add(folder);

        Heading("Копии");
        Add(UiKit.SettingRow("Создать копию сейчас", null, UiKit.TextButton("Создать", () =>
        {
            Model.BackupNow();
            Refresh();
        }, accent: true)));
        Add(UiKit.SettingRow("Восстановить из файла", "Выбрать копию базы, которая лежит в другом месте.", UiKit.TextButton("Выбрать файл…", () => Run(async () =>
        {
            if (await Pickers.OpenFileAsync(".db") is { } path)
            {
                await RestoreAsync(path);
            }
        }))));

        var files = Model.BackupFiles;
        if (files.Count == 0)
        {
            Add(UiKit.Muted("Копий пока нет."));
            return;
        }

        foreach (var file in files)
        {
            var path = file.Path;
            var row = new Grid { ColumnSpacing = 8 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.Children.Add(UiKit.VStack(0, new TextBlock { Text = Fmt.Date(file.CreatedAt) }, UiKit.Muted(Path.GetFileName(path) + " · " + Fmt.Size(file.Size))));
            var actions = UiKit.HStack(6,
                UiKit.TextButton("Восстановить", () => Run(() => RestoreAsync(path))),
                UiKit.IconButton(Glyphs.Folder, "Показать в папке", () => Launcher.Reveal(path)),
                UiKit.IconButton(Glyphs.Delete, "Удалить копию", () => Run(() => DeleteAsync(path))));
            Grid.SetColumn(actions, 1);
            row.Children.Add(actions);
            Add(UiKit.Card(row, 12));
        }
    }

    private async Task RestoreAsync(string path)
    {
        int count;
        try
        {
            count = Model.ProbeBackup(path);
        }
        catch (Exception e) when (e is DatabaseException or IOException or Microsoft.Data.Sqlite.SqliteException)
        {
            Fail("Файл не подходит", e.Message);
            return;
        }

        if (!await Dialogs.ConfirmAsync("Восстановить базу?",
                $"В копии лидов: {count}. Текущая база будет заменена; её предыдущее состояние сохранится рядом как before-restore.db.", "Восстановить"))
        {
            return;
        }

        if (Model.Restore(path))
        {
            Refresh();
        }
    }

    private async Task DeleteAsync(string path)
    {
        if (!await Dialogs.ConfirmAsync("Удалить копию?", Path.GetFileName(path), "Удалить"))
        {
            return;
        }

        try
        {
            File.Delete(path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Fail("Копия не удалена", e.Message);
        }

        Refresh();
    }
}

internal sealed class ExportImportPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    protected override SettingsSection Kind => SettingsSection.ExportImport;

    protected override string Lead => "Выгрузка лидов в таблицу и загрузка обратно. Файлы CSV и JSON совместимы с версией для macOS.";

    protected override void Fill()
    {
        var all = Model.AllLeads.Where(l => !l.Archived && !l.Excluded).ToList();
        Add(UiKit.SettingRow("Экспорт всех лидов", $"Сейчас в базе: {Fmt.Leads(all.Count)} (без архива и исключённых).",
            UiKit.TextButton("Экспортировать…", () => Run(() => ExportFlow.RunAsync(Model, all, "все лиды")), accent: true)));
        var visible = Model.Visible().ToList();
        Add(UiKit.SettingRow("Экспорт того, что видно в списке", $"С учётом выбранного раздела и фильтров: {Fmt.Leads(visible.Count)}.",
            UiKit.TextButton("Экспортировать…", () => Run(() => ExportFlow.RunAsync(Model, visible, "текущий список")))));
        Add(UiKit.SettingRow("Импорт из файла", "CSV или JSON, выгруженные из Customers. Повторный импорт не создаёт дублей.",
            UiKit.TextButton("Импортировать…", () => Run(() => ExportFlow.ImportAsync(Model)))));
        Add(UiKit.SettingRow("Исключения", "Импорт и список исключений — в разделе «Исключения».", UiKit.TextButton("Открыть", () => Shell.OpenSettings(SettingsSection.Exclusions))));
    }
}

internal sealed class NotificationsPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    protected override SettingsSection Kind => SettingsSection.Notifications;

    protected override string Lead => "Системные уведомления Windows приходят, пока приложение работает в фоне. Внутри окна сообщения показываются всегда.";

    protected override void Fill()
    {
        var prefs = Model.Prefs;
        Add(UiKit.SettingRow("Новые лиды", "Сообщать, когда поиск нашёл новые заказы или организации.", UiKit.Toggle(prefs.NotifyNewLeads, v => prefs.NotifyNewLeads = v)));
        Add(UiKit.SettingRow("Ошибки поиска", "Сообщать, если источник не ответил или поиск завершился с ошибками.", UiKit.Toggle(prefs.NotifyErrors, v => prefs.NotifyErrors = v)));
        Add(UiKit.SettingRow("Синхронизация", "Сообщать о проблемах с облаком.", UiKit.Toggle(prefs.NotifySync, v => prefs.NotifySync = v)));
        Add(UiKit.SettingRow("Проверить уведомления", "Покажет тестовое системное уведомление.", UiKit.TextButton("Показать", () =>
        {
            if (!App.Instance.Notifier.Toast("Customers", "Так выглядят уведомления о новых лидах.", force: true))
            {
                Notify(NoticeKind.Warning, "Системные уведомления недоступны", "Проверьте, не выключены ли уведомления для приложения в параметрах Windows.");
            }
        })));
        Add(UiKit.SettingRow("Параметры Windows", "Режим «Не беспокоить» и разрешения настраиваются в системе.",
            UiKit.TextButton("Открыть", () => Run(async () => await Launcher.OpenAsync(new Uri("ms-settings:notifications"))))));
    }
}

internal sealed class DataPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    protected override SettingsSection Kind => SettingsSection.Data;

    protected override string Lead => "Где лежат данные, их проверка и очистка.";

    protected override void Fill()
    {
        var path = Model.DatabasePath;
        var info = UiKit.VStack(4, UiKit.Strong("База лидов"), UiKit.Body(path, selectable: true),
            UiKit.Muted($"Размер: {Fmt.Size(Model.DatabaseSize)} · лидов: {Model.AllLeads.Count} · база зашифрована ключом, привязанным к вашей учётной записи Windows"));
        Add(UiKit.Card(info));
        Add(UiKit.SettingRow("Открыть папку с базой", null, UiKit.TextButton("Открыть", () => Launcher.OpenFolder(Path.GetDirectoryName(path)!))));
        Add(UiKit.SettingRow("Перенести базу", "Переместить файл базы в другую папку (например, на другой диск). Поиск на время переноса должен быть остановлен.",
            UiKit.TextButton("Выбрать папку…", () => Run(async () =>
            {
                if (await Pickers.PickFolderAsync() is { } folder && Model.MoveDatabase(folder))
                {
                    Refresh();
                }
            }))));
        if (Model.Prefs.DataPath is not null)
        {
            Add(UiKit.SettingRow("Вернуть базу на место", "Вернуть в папку по умолчанию.", UiKit.TextButton("Вернуть", () =>
            {
                if (Model.MoveDatabase(Model.DataDirectory))
                {
                    Model.Prefs.DataPath = null;
                    Refresh();
                }
            })));
        }

        Heading("Проверка");
        Add(UiKit.SettingRow("Проверить целостность базы", "Ищет повреждения файла. Проблемы записываются в журнал.", UiKit.TextButton("Проверить", () => Run(CheckAsync))));

        Heading("Журнал и диагностика");
        var logs = App.Instance.Env.Log.Directory;
        Add(UiKit.SettingRow("Папка журналов", logs, UiKit.TextButton("Открыть", () =>
        {
            Directory.CreateDirectory(logs);
            Launcher.OpenFolder(logs);
        })));
        Add(UiKit.SettingRow("Скопировать сведения для поддержки", "Версия, система и состояние базы. Пароли, ключи и содержимое лидов не включаются.",
            UiKit.TextButton("Скопировать", () =>
            {
                Launcher.Copy(Diagnostics());
                Ok("Сведения скопированы");
            })));

        Heading("Опасная зона");
        Add(UiKit.SettingRow("Удалить все лиды", "Нужен пароль учётной записи. Перед удалением сохраняется копия базы. Настройки, исключения и учётная запись остаются.",
            DangerButton("Удалить все лиды…", () => Run(DeleteAllAsync))));
    }

    private async Task CheckAsync()
    {
        var problems = await Task.Run(() => Model.CheckIntegrity());
        if (problems.Count == 0)
        {
            Ok("База в порядке", "Проверка целостности не нашла проблем.");
        }
        else
        {
            await Dialogs.InfoAsync("Найдены проблемы в базе", string.Join("\n", problems.Take(20)) + "\n\nВосстановите базу из резервной копии (Настройки → Резервные копии).");
        }
    }

    /// <summary>Красная кнопка опасного действия.</summary>
    private static Button DangerButton(string text, Action action)
    {
        var button = UiKit.TextButton(text, action);
        button.Background = UiKit.ThemeBrush("SystemFillColorCriticalBrush");
        button.Foreground = new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.White);
        // Подсветка при наведении и нажатии остаётся красной: переопределяем ресурсы кнопки, иначе тема вернёт серый.
        foreach (var key in new[] { "ButtonBackgroundPointerOver", "ButtonBackgroundPressed" })
        {
            button.Resources[key] = UiKit.ThemeBrush("SystemFillColorCriticalBrush");
        }

        foreach (var key in new[] { "ButtonForegroundPointerOver", "ButtonForegroundPressed", "ButtonBorderBrushPointerOver", "ButtonBorderBrushPressed" })
        {
            button.Resources[key] = new Microsoft.UI.Xaml.Media.SolidColorBrush(Microsoft.UI.Colors.White);
        }

        button.BorderBrush = UiKit.ThemeBrush("SystemFillColorCriticalBrush");
        return button;
    }

    private async Task DeleteAllAsync()
    {
        var count = Model.AllLeads.Count;
        if (count == 0)
        {
            Notify(NoticeKind.Info, "Лидов нет");
            return;
        }

        var password = await Dialogs.PromptAsync("Удалить все лиды?",
            $"Будет удалено лидов: {count}. Сначала сохранится резервная копия, из которой их можно вернуть. Для подтверждения введите пароль своей учётной записи.",
            "Пароль учётной записи", password: true, primary: "Удалить все лиды");
        if (password is null)
        {
            return;
        }

        if (await Session.DeleteAllLeadsAsync(password) is { } problem)
        {
            Fail("Лиды не удалены", problem);
            return;
        }

        Ok("Все лиды удалены", "Резервная копия сохранена: её можно вернуть в разделе «Резервные копии».");
        Refresh();
    }

    private string Diagnostics()
    {
        var text = new System.Text.StringBuilder();
        text.AppendLine("Customers " + AppBuild.Version);
        text.AppendLine("Windows: " + Environment.OSVersion.VersionString);
        text.AppendLine(".NET: " + Environment.Version);
        text.AppendLine("Учётная запись: " + (Model.IsCloud ? "облачная" : "локальная"));
        text.AppendLine($"База: {Fmt.Size(Model.DatabaseSize)}, лидов {Model.AllLeads.Count}");
        text.AppendLine("Поиск: " + (Model.LastReport?.Summary ?? "не запускался"));
        text.AppendLine("Облако: " + (Session.Sync?.Summary ?? "не используется"));
        return text.ToString();
    }
}

internal sealed class AboutPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    private const string Repository = "https://github.com/xop1tt/Customers-App";

    protected override SettingsSection Kind => SettingsSection.About;

    protected override void Fill()
    {
        Add(UiKit.Card(UiKit.VStack(4, UiKit.SubTitle("Customers"), UiKit.Muted("Поиск заказов и потенциальных клиентов по публичным источникам"),
            UiKit.Muted("Версия " + AppBuild.Version))));

        Heading("Обновления");
        var updates = App.Instance.Updates;
        var status = updates.Offer is { } offer ? $"Доступна версия {offer.Version}" : updates.CheckedAt is null ? "Проверка ещё не выполнялась" : "Установлена последняя версия";
        var check = UiKit.TextButton("Проверить сейчас", () => Run(async () =>
        {
            await updates.CheckAsync();
            Refresh();
        }));
        Add(UiKit.SettingRow("Проверка обновлений", status, check));
        if (updates.Offer is { } available)
        {
            Add(UiKit.SettingRow($"Обновить до {available.Version}", "Установщик скачивается и проверяется по контрольной сумме. Данные и настройки сохраняются.",
                UiKit.TextButton("Установить и перезапустить", () => Run(() => App.Instance.MainWindow.InstallUpdateAsync(available)), accent: true)));
        }

        Add(UiKit.SettingRow("Проверять автоматически", "Сверяться с последним выпуском на GitHub. Больше ничего не отправляется. Установка всегда только с вашего согласия.",
            UiKit.Toggle(Device.CheckUpdates, v =>
            {
                Device.CheckUpdates = v;
                Refresh();
            })));
        var frequency = UiKit.Combo(UpdateSchedule.Choices.Select(c => (c.Title, c.Hours)), Device.UpdateCheckHours, v => Device.UpdateCheckHours = v, 220);
        frequency.IsEnabled = Device.CheckUpdates;
        Add(UiKit.SettingRow("Как часто проверять", Device.LastUpdateCheck is { } last ? "Последняя проверка: " + Fmt.Date(last) : "Проверок ещё не было.", frequency));

        Heading("О проекте");
        Add(UiKit.SettingRow("Лицензия", "PIBUL 1.0 — свободное использование и изменение, без гарантий.", null));
        Add(UiKit.SettingRow("Исходный код и страница выпусков", Repository, UiKit.TextButton("Открыть", () => Run(() => Launcher.OpenWebAsync(Repository)))));
    }
}
