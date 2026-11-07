using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

internal sealed class ExclusionsPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    protected override SettingsSection Kind => SettingsSection.Exclusions;

    protected override string Lead => "Домены, телефоны, адреса почты и названия, которые не нужно показывать. Подходящие лиды уходят из списков и не возвращаются при новых поисках.";

    protected override void Fill()
    {
        var kind = new ComboBox { Width = 160, ItemsSource = Enum.GetValues<ExclusionKind>().Select(k => k.Title()).ToList(), SelectedIndex = 0 };
        var value = new TextBox { PlaceholderText = "значение", MinWidth = 220, HorizontalAlignment = HorizontalAlignment.Stretch };
        void AddNew()
        {
            var text = value.Text.Trim();
            if (text.Length == 0)
            {
                return;
            }

            Model.Exclude(Enum.GetValues<ExclusionKind>()[Math.Max(0, kind.SelectedIndex)], text);
            Refresh();
        }

        value.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Enter)
            {
                AddNew();
            }
        };
        var entry = new Grid { ColumnSpacing = 8 };
        entry.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        entry.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        entry.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        entry.Children.Add(kind);
        Grid.SetColumn(value, 1);
        entry.Children.Add(value);
        var add = UiKit.TextButton("Добавить", AddNew, accent: true);
        Grid.SetColumn(add, 2);
        entry.Children.Add(add);
        Add(UiKit.Card(entry));

        Add(UiKit.SettingRow("Импорт из файла", "Текстовый или CSV-файл: домены, адреса почты и телефоны (тип определяется сам), по одному в ячейке или строке.",
            UiKit.TextButton("Выбрать файл…", () => Run(ImportAsync))));

        Heading($"В списке: {Model.Exclusions.Count}");
        if (Model.Exclusions.Count == 0)
        {
            Add(UiKit.Muted("Исключений пока нет."));
            return;
        }

        foreach (var item in Model.Exclusions)
        {
            var id = item.Id;
            var row = new Grid { ColumnSpacing = 12 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(120) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.Children.Add(UiKit.Muted(item.Kind.Title()));
            var text = new TextBlock { Text = item.Value, TextTrimming = TextTrimming.CharacterEllipsis, IsTextSelectionEnabled = true };
            Grid.SetColumn(text, 1);
            row.Children.Add(text);
            var remove = UiKit.IconButton(Glyphs.Delete, "Убрать из исключений", () =>
            {
                Model.RemoveExclusion(id);
                Refresh();
            });
            Grid.SetColumn(remove, 2);
            row.Children.Add(remove);
            Add(UiKit.Card(row, 10));
        }
    }

    private async Task ImportAsync()
    {
        if (await Pickers.OpenFileAsync(".csv", ".txt") is not { } path)
        {
            return;
        }

        Model.ImportExclusionsFile(path);
        Refresh();
    }
}
