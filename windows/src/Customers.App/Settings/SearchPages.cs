using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

internal sealed class SearchPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    private static readonly (string Text, int Value)[] Intervals =
    [
        ("Выключен", 0), ("Каждые 15 минут", 15), ("Каждые 30 минут", 30), ("Каждый час", 60),
        ("Каждые 2 часа", 120), ("Каждые 6 часов", 360), ("Каждые 12 часов", 720), ("Раз в сутки", 1440),
    ];

    protected override SettingsSection Kind => SettingsSection.Search;

    protected override string Lead => "Поиск идёт в фоне и не мешает работе. Каждый источник проверяется не чаще своего интервала.";

    protected override void Fill()
    {
        var current = Model.AutoSearchMinutes;
        var items = Intervals.ToList();
        if (items.All(i => i.Value != current))
        {
            items.Add(($"Каждые {current} мин.", current));
        }

        Add(UiKit.SettingRow("Автоматический поиск", "Пока приложение открыто, искать новые заказы и организации по расписанию.",
            UiKit.Combo(items, current, v => Model.AutoSearchMinutes = v, 200)));

        Heading("Запуск вручную");
        var status = Model.Searching ? Model.SearchProgress ?? "Идёт поиск…" : Model.LastReport?.Summary ?? "Поиск ещё не запускался в этом сеансе.";
        var run = UiKit.TextButton(Model.Searching ? "Остановить" : "Найти сейчас", () =>
        {
            if (Model.Searching)
            {
                Model.StopSearch();
            }
            else
            {
                _ = Model.RunSearchAsync();
            }

            Refresh();
        }, accent: !Model.Searching);
        Add(UiKit.SettingRow("Найти сейчас", status, run));
        Add(UiKit.SettingRow("Подробности по источникам", "Состояние, ошибки и сброс памяти источника — в разделе «Источники».",
            UiKit.TextButton("Открыть источники", () => Shell.Navigate(NavSection.Sources))));
    }
}

internal sealed class SourcesSettingsPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    protected override SettingsSection Kind => SettingsSection.Sources;

    protected override string Lead => "Что именно искать в каждом источнике. Изменения сохраняются сразу и попадают в облако, если оно подключено.";

    private SearchSettings S => Model.SearchSettings;

    private void Change(Action<SearchSettings> change) => Model.UpdateSearchSettings(change);

    protected override void Fill()
    {
        // RSS / Atom
        Heading("RSS и Atom");
        Add(UiKit.SettingRow("Ленты заказов", null, UiKit.Toggle(S.Rss.Enabled, v => Change(s => s.Rss.Enabled = v))));
        Add(IntervalRow(S.Rss.IntervalHours, v => Change(s => s.Rss.IntervalHours = v)));
        Add(ListEditor("Адреса лент", "Любая публичная лента заказов или вакансий.", () => S.Rss.Feeds, v => Change(s => s.Rss.Feeds = v),
            SourceInput.FeedUrl, "https://example.com/rss.xml", "Не похоже на публичный адрес ленты"));
        Add(ListEditor("Ключевые слова", "Пусто — берутся все записи ленты.", () => S.Rss.Keywords, v => Change(s => s.Rss.Keywords = v),
            SourceInput.Keyword, "слово или фраза", "Пустое слово"));

        // Telegram
        Heading("Telegram");
        Add(UiKit.SettingRow("Публичные каналы", "Читаются через открытую веб-страницу t.me/s/…, без входа в аккаунт.", UiKit.Toggle(S.Telegram.Enabled, v => Change(s => s.Telegram.Enabled = v))));
        Add(IntervalRow(S.Telegram.IntervalHours, v => Change(s => s.Telegram.IntervalHours = v)));
        Add(UiKit.SettingRow("Страниц на канал", "Сколько страниц истории читать за один запуск.", UiKit.Number(S.Telegram.MaxPages, 1, 10, v => Change(s => s.Telegram.MaxPages = (int)v))));
        Add(ListEditor("Каналы", "Имя, @имя или ссылка t.me/…", () => S.Telegram.Channels, v => Change(s => s.Telegram.Channels = v),
            SourceInput.TelegramChannel, "@канал", "Не похоже на имя канала"));
        Add(ListEditor("Ключевые слова", "Сообщение попадает в оценку, если в нём есть одно из слов.", () => S.Telegram.Keywords, v => Change(s => s.Telegram.Keywords = v),
            SourceInput.Keyword, "слово или фраза", "Пустое слово"));

        // VK
        Heading("ВКонтакте");
        Add(UiKit.SettingRow("Открытые сообщества", "Нужен бесплатный сервисный ключ доступа приложения VK.", UiKit.Toggle(S.Vk.Enabled, v => Change(s => s.Vk.Enabled = v))));
        Add(IntervalRow(S.Vk.IntervalHours, v => Change(s => s.Vk.IntervalHours = v)));
        var token = UiKit.Secret(Model.VkToken, v => Model.VkToken = v.Trim(), width: 280, placeholder: "сервисный ключ");
        Add(UiKit.SettingRow("Сервисный ключ", Model.HasVkToken ? "Ключ сохранён в защищённом хранилище Windows." : "Ключа нет — источник не будет работать.", token));
        Add(UiKit.SettingRow("Записей на страницу", null, UiKit.Number(S.Vk.PageSize, 10, 100, v => Change(s => s.Vk.PageSize = (int)v), 10)));
        Add(UiKit.SettingRow("Страниц на сообщество", null, UiKit.Number(S.Vk.MaxPages, 1, 10, v => Change(s => s.Vk.MaxPages = (int)v))));
        Add(ListEditor("Сообщества", "Короткое имя или ссылка vk.com/…", () => S.Vk.Communities, v => Change(s => s.Vk.Communities = v),
            SourceInput.VkCommunity, "vk.com/сообщество", "Не похоже на имя сообщества"));
        Add(ListEditor("Ключевые слова", null, () => S.Vk.Keywords, v => Change(s => s.Vk.Keywords = v), SourceInput.Keyword, "слово или фраза", "Пустое слово"));

        // OSM
        Heading("OpenStreetMap");
        Add(UiKit.SettingRow("Организации по регионам", "Компании без сайта или с неработающим сайтом — потенциальные клиенты.", UiKit.Toggle(S.Osm.Enabled, v => Change(s => s.Osm.Enabled = v))));
        Add(IntervalRow(S.Osm.IntervalHours, v => Change(s => s.Osm.IntervalHours = v)));
        Add(ListEditor("Регионы", "Город или область, как они называются на карте.", () => S.Osm.Regions, v => Change(s => s.Osm.Regions = v),
            SourceInput.Region, "Ереван", "Пустое название"));
        Add(UiKit.SettingRow("Проверять сайты организаций", "Открывать сайт и оценивать, насколько он устарел или не работает.", UiKit.Toggle(S.Osm.CheckWebsites, v => Change(s => s.Osm.CheckWebsites = v))));
        Add(UiKit.SettingRow("Новых за один запуск", "Ограничение, чтобы не перегружать общедоступный сервер.", UiKit.Number(S.Osm.MaxNewPerRun, 1, 500, v => Change(s => s.Osm.MaxNewPerRun = (int)v), 10)));
        Add(UiKit.SettingRow("Обновлять запрос не чаще, дней", null, UiKit.Number(S.Osm.RefreshDays, 1, 90, v => Change(s => s.Osm.RefreshDays = v))));
        Add(UiKit.SettingRow("Перепроверять организацию через, дней", null, UiKit.Number(S.Osm.RecheckDays, 1, 365, v => Change(s => s.Osm.RecheckDays = v), 5)));
        var endpoint = UiKit.Text(S.Osm.Endpoint, v =>
        {
            var url = SourceInput.FeedUrl(v);
            if (url is null)
            {
                Fail("Адрес сервера", "Нужен публичный адрес http или https.");
                Refresh();
                return;
            }

            Change(s => s.Osm.Endpoint = url);
        }, width: 320);
        Add(UiKit.SettingRow("Сервер Overpass", "Общедоступный сервер OpenStreetMap; можно указать зеркало.", endpoint));
        Add(UiKit.SettingRow("Значения по умолчанию", "Вернуть источники к исходным настройкам.", UiKit.TextButton("Сбросить всё…", () => Run(ResetAsync))));
    }

    private static Border IntervalRow(double hours, Action<double> set) =>
        UiKit.SettingRow("Интервал, часов", "Как часто этот источник можно проверять.", UiKit.Number(hours, 0.25, 720, set, 0.25));

    private async Task ResetAsync()
    {
        if (await Dialogs.ConfirmAsync("Сбросить настройки источников?", "Списки, ключевые слова и интервалы вернутся к значениям по умолчанию. Найденные лиды не затрагиваются.", "Сбросить"))
        {
            var fresh = new SearchSettings();
            Change(s =>
            {
                s.Rss = fresh.Rss;
                s.Telegram = fresh.Telegram;
                s.Vk = fresh.Vk;
                s.Osm = fresh.Osm;
            });
            Refresh();
        }
    }
}

internal sealed class FiltersPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    protected override SettingsSection Kind => SettingsSection.Filters;

    protected override string Lead => "Как отбираются организации и что показывается в списке лидов.";

    protected override void Fill()
    {
        Heading("Список лидов");
        Add(UiKit.SettingRow("Минимальная оценка", "Лиды с меньшей оценкой (0–100) скрыты. Работает как фильтр над списком, данные не удаляются.",
            UiKit.Number(Model.MinScore, 0, 100, v => Model.MinScore = v, 5)));
        Add(UiKit.SettingRow("Скрывать неподходящие", "Не показывать лиды, оценённые как неинтересные.", UiKit.Toggle(Model.HideRejected, v => Model.HideRejected = v)));
        Add(UiKit.SettingRow("Сбросить фильтры", "Убрать поиск, тип, источник, регион и минимальную оценку.", UiKit.TextButton("Сбросить", () =>
        {
            Model.ResetFilters();
            Refresh();
        })));

        Heading("Категории организаций");
        Add(UiKit.Muted("Какие виды бизнеса искать в OpenStreetMap и насколько важен каждый: вес добавляется к оценке лида."));
        var groups = Model.SearchSettings.Osm.Categories.GroupBy(c => c.Group);
        foreach (var group in groups)
        {
            var body = UiKit.VStack(6, UiKit.Strong(string.IsNullOrEmpty(group.Key) ? "Прочее" : group.Key));
            foreach (var category in group)
            {
                var key = category.Key;
                var enable = new ToggleSwitch { IsOn = category.Enabled, OnContent = "", OffContent = "", MinWidth = 0 };
                enable.Toggled += (_, _) => Model.UpdateSearchSettings(s => s.Osm.Categories.First(c => c.Key == key).Enabled = enable.IsOn);
                var weight = UiKit.Number(category.Weight, 0, 50, v => Model.UpdateSearchSettings(s => s.Osm.Categories.First(c => c.Key == key).Weight = v), 1, width: 130);
                var row = new Grid { ColumnSpacing = 12 };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.Children.Add(enable);
                var label = new TextBlock { Text = category.Label, VerticalAlignment = VerticalAlignment.Center };
                Grid.SetColumn(label, 1);
                row.Children.Add(label);
                Grid.SetColumn(weight, 2);
                row.Children.Add(weight);
                body.Children.Add(row);
            }

            Add(UiKit.Card(body));
        }
    }
}
