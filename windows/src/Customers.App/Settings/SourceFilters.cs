using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>
/// Фильтры источников — регионы, каналы, ключевые слова, категории организаций. Одни и те же блоки собирают и мастер первого запуска,
/// и «Настройки → Источники», поэтому правила проверки и вид совпадают. За пользователя ничего не подставляется: списки стартуют пустыми.
/// </summary>
internal static class SourceFilters
{
    public static FrameworkElement Regions(AppModel model, bool autoLocate = false)
    {
        var editor = new ContentControl { HorizontalContentAlignment = HorizontalAlignment.Stretch };
        FrameworkElement BuildEditor() => SettingsPage.ListEditor("Регионы для поиска организаций",
            "Город или область, как они называются на карте. Можно добавить несколько. Пока список пуст, организации на карте не ищутся.",
            () => model.SearchSettings.Osm.Regions, v => model.UpdateSearchSettings(s => s.Osm.Regions = v),
            SourceInput.Region, "например, Казань", "Пустое название");
        editor.Content = BuildEditor();

        var status = UiKit.Muted("");
        status.TextWrapping = TextWrapping.Wrap;
        status.Visibility = Visibility.Collapsed;
        Button? locate = null;
        async Task LocateAsync()
        {
            locate!.IsEnabled = false;
            status.Text = "Определяю…";
            status.Visibility = Visibility.Visible;
            try
            {
                var found = await RegionLocator.LocateAsync(App.Instance.Env.SearchTransport());
                if (found.Region is { } region)
                {
                    if (model.SearchSettings.Osm.Regions.Contains(region, StringComparer.OrdinalIgnoreCase))
                    {
                        status.Text = $"Регион «{region}» уже в списке.";
                    }
                    else
                    {
                        model.UpdateSearchSettings(s => s.Osm.Regions = [.. s.Osm.Regions, region]);
                        status.Text = $"Добавлен регион «{region}». Если это не тот город, удалите его и введите нужный.";
                        editor.Content = BuildEditor(); // список перерисован с найденным регионом
                    }
                }
                else
                {
                    status.Text = found.Problem ?? "Не удалось определить регион. Введите его вручную.";
                }
            }
            finally
            {
                locate.IsEnabled = true;
            }
        }

        locate = UiKit.TextButton("Определить по местоположению", () => _ = LocateAsync(), tip: "Спросит у Windows, где находится компьютер, и предложит ближайший город. Ничего не сохраняется без вашего согласия.");

        var block = UiKit.VStack(8, editor, UiKit.HStack(12, locate), status);
        if (autoLocate && model.SearchSettings.Osm.Regions.Count == 0)
        {
            // Мастер предлагает регион сам, но только если список пуст; результат всегда можно убрать или заменить.
            block.Loaded += (_, _) => _ = LocateAsync();
        }

        return block;
    }

    public static FrameworkElement TelegramChannels(AppModel model) =>
        SettingsPage.ListEditor("Каналы Telegram", "Имя, @имя или ссылка t.me/… Публичные каналы читаются без входа в аккаунт. Список пуст, пока вы сами его не заполните.",
            () => model.SearchSettings.Telegram.Channels, v => model.UpdateSearchSettings(s => s.Telegram.Channels = v),
            SourceInput.TelegramChannel, "@канал", "Не похоже на имя канала");

    public static FrameworkElement TelegramKeywords(AppModel model) =>
        SettingsPage.ListEditor("Ключевые слова для Telegram", "Сообщение попадает в оценку, если в нём есть одно из слов. Пусто — берутся все сообщения.",
            () => model.SearchSettings.Telegram.Keywords, v => model.UpdateSearchSettings(s => s.Telegram.Keywords = v),
            SourceInput.Keyword, "слово или фраза", "Пустое слово");

    public static FrameworkElement FeedKeywords(AppModel model) =>
        SettingsPage.ListEditor("Ключевые слова для лент", "Пусто — берутся все записи ленты.",
            () => model.SearchSettings.Rss.Keywords, v => model.UpdateSearchSettings(s => s.Rss.Keywords = v),
            SourceInput.Keyword, "слово или фраза", "Пустое слово");

    /// <summary>Категории организаций по группам с названиями групп; в одном списке нет повторов, добавленные позже категории выключены.</summary>
    public static FrameworkElement Categories(AppModel model, bool withWeights = true)
    {
        var all = new StackPanel { Spacing = 10 };
        all.Children.Add(UiKit.Muted("Какие виды бизнеса искать на карте. Отмечены только те, что вы включили; остальные можно добавить в любой момент."));
        foreach (var group in model.SearchSettings.Osm.Categories.GroupBy(c => c.Group))
        {
            var title = SearchDefaults.OsmGroupTitles.TryGetValue(group.Key, out var t) ? t : string.IsNullOrEmpty(group.Key) ? "Прочее" : group.Key;
            var enabledCount = group.Count(c => c.Enabled);
            var body = UiKit.VStack(6, UiKit.Strong(enabledCount > 0 ? $"{title} · включено {enabledCount}" : title));
            foreach (var category in group)
            {
                var key = category.Key;
                var enable = new ToggleSwitch { IsOn = category.Enabled, OnContent = "", OffContent = "", MinWidth = 0 };
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(enable, category.Label);
                enable.Toggled += (_, _) => model.UpdateSearchSettings(s => s.Osm.Categories.First(c => c.Key == key).Enabled = enable.IsOn);
                var row = new Grid { ColumnSpacing = 12 };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.Children.Add(enable);
                var label = new TextBlock { Text = category.Label, VerticalAlignment = VerticalAlignment.Center, TextWrapping = TextWrapping.Wrap };
                Grid.SetColumn(label, 1);
                row.Children.Add(label);
                if (withWeights)
                {
                    row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                    var weight = UiKit.Number(category.Weight, 0, 50, v => model.UpdateSearchSettings(s => s.Osm.Categories.First(c => c.Key == key).Weight = v), 1, width: 130);
                    Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(weight, "Вес: " + category.Label);
                    Grid.SetColumn(weight, 2);
                    row.Children.Add(weight);
                }

                body.Children.Add(row);
            }

            all.Children.Add(UiKit.Card(body));
        }

        return all;
    }
}
