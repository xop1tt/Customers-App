using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>Экран на случай, когда база лидов не открывается: понятная причина, повторная попытка и восстановление из резервной копии.</summary>
public sealed class DatabaseErrorView : UserControl
{
    private readonly SessionModel _session;

    public DatabaseErrorView(AppModel model, SessionModel session)
    {
        Model = model;
        _session = session;
        Content = UiKit.Page(Build(), 760);
    }

    public AppModel Model { get; }

    private StackPanel Build()
    {
        var root = new StackPanel { Spacing = 12, Padding = new Thickness(24, 40, 24, 32) };
        root.Children.Add(UiKit.PageTitle("База данных не открывается"));
        root.Children.Add(UiKit.Bar(InfoBarSeverity.Error, "Что случилось", Model.StartupError ?? "Неизвестная ошибка."));
        root.Children.Add(UiKit.Body("Ваши данные не удалены. Файл базы остался на месте и при восстановлении не стирается, а откладывается рядом. Можно повторить попытку (например, если файл был занят другой программой) или вернуть базу из резервной копии."));
        root.Children.Add(UiKit.Muted("Файл: " + Model.DatabasePath));

        var actions = UiKit.HStack(8,
            UiKit.TextButton("Повторить", _session.Reopen, accent: true),
            UiKit.TextButton("Открыть папку с базой", () => Launcher.OpenFolder(Path.GetDirectoryName(Model.DatabasePath)!)),
            UiKit.TextButton("Журнал", () =>
            {
                Directory.CreateDirectory(App.Instance.Env.Log.Directory);
                Launcher.OpenFolder(App.Instance.Env.Log.Directory);
            }),
            UiKit.TextButton("Выйти из записи", _session.Logout));
        root.Children.Add(actions);

        root.Children.Add(new TextBlock { Text = "Восстановить из копии", Style = UiKit.Style("SectionTitleStyle"), Margin = new Thickness(0, 12, 0, 0) });
        var folder = Model.Prefs.BackupDirectory;
        var files = Directory.Exists(folder)
            ? Directory.EnumerateFiles(folder, "Customers-*.db").Select(f => new FileInfo(f)).OrderByDescending(f => f.Name, StringComparer.Ordinal).ToList()
            : [];
        if (files.Count == 0)
        {
            root.Children.Add(UiKit.Muted("В папке копий (" + folder + ") ничего не найдено."));
        }

        foreach (var file in files.Take(15))
        {
            var path = file.FullName;
            var row = new Grid { ColumnSpacing = 8 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.Children.Add(UiKit.VStack(0, new TextBlock { Text = Fmt.Date(file.LastWriteTime) }, UiKit.Muted(file.Name + " · " + Fmt.Size(file.Length))));
            var restore = UiKit.TextButton("Восстановить", () => Restore(path));
            Grid.SetColumn(restore, 1);
            row.Children.Add(restore);
            root.Children.Add(UiKit.Card(row, 12));
        }

        root.Children.Add(UiKit.TextButton("Выбрать другой файл копии…", async () =>
        {
            if (await Pickers.OpenFileAsync(".db") is { } path)
            {
                Restore(path);
            }
        }));
        return root;
    }

    private async void Restore(string backup)
    {
        try
        {
            if (!await Dialogs.ConfirmAsync("Восстановить базу?",
                    $"Текущий файл базы будет отложен рядом (leads.broken-…), а на его место встанет копия «{Path.GetFileName(backup)}».", "Восстановить"))
            {
                return;
            }

            var broken = AppModel.RecoverDatabase(Model.DatabasePath, backup);
            App.Instance.Env.Log.Info("База восстановлена из копии; прежний файл: " + broken);
            _session.Reopen();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            App.Instance.Env.Log.Error("Восстановление не удалось", e);
            App.Instance.Notifier.Error("Восстановление не удалось", e.Message);
        }
    }
}
