using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

internal sealed class IntegrationsPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    private NotionDatabase? _database;
    private string _notionDatabaseText = "";
    private Dictionary<string, ExportField> _mapping = [];

    protected override SettingsSection Kind => SettingsSection.Integrations;

    protected override string Lead => "Передача найденных лидов в вашу CRM. Ключи и адреса вебхуков хранятся в защищённом хранилище Windows и никуда, кроме выбранного сервиса, не отправляются.";

    protected override void Fill()
    {
        if (_notionDatabaseText.Length == 0 && Model.LoadNotionSetup() is { } saved)
        {
            _notionDatabaseText = saved.Database;
            _mapping = new Dictionary<string, ExportField>(saved.Mapping);
        }

        FillBitrix();
        FillWebhook();
        FillNotion();
        Add(UiKit.Muted("Отправить лиды можно из списка: выделите их и выберите «В CRM» в меню действий."));
    }

    private void FillBitrix()
    {
        Heading("Bitrix24");
        var secret = UiKit.Secret(Model.CrmSecret(CrmKind.Bitrix) ?? "", v =>
        {
            Model.SetCrmSecret(CrmKind.Bitrix, v);
            Refresh();
        }, placeholder: "https://ваш-портал.bitrix24.ru/rest/1/ключ/");
        var check = UiKit.TextButton("Проверить подключение", () => Run(() => CheckBitrixAsync(secret.Password)));
        Add(UiKit.Card(UiKit.VStack(10, UiKit.Strong("Адрес входящего вебхука"),
            UiKit.Muted("В Bitrix24: Разработчикам → Другое → Входящий вебхук. Нужно право «CRM». Каждый лид появится в CRM один раз: повторная отправка пропускает уже переданные."),
            UiKit.InputRow(secret, check))));
    }

    private async Task CheckBitrixAsync(string text)
    {
        var value = text.Trim();
        if (value.Length == 0)
        {
            Fail("Bitrix24", "Сначала укажите адрес вебхука.");
            return;
        }

        var http = Model.Environment.CrmHttp();
        try
        {
            await new Bitrix24Destination(value).CheckAsync(http);
            Model.SetCrmSecret(CrmKind.Bitrix, value);
            Ok("Bitrix24 подключён", "Вебхук работает и имеет доступ к CRM.");
        }
        catch (CrmException e)
        {
            Fail("Bitrix24 не подключён", e.Message);
        }
        finally
        {
            (http as IDisposable)?.Dispose();
        }
    }

    private void FillWebhook()
    {
        Heading("Вебхук");
        var secret = UiKit.Secret(Model.CrmSecret(CrmKind.Webhook) ?? "", v =>
        {
            if (v.Trim().Length > 0)
            {
                try
                {
                    _ = WebhookDestination.Normalize(v);
                }
                catch (CrmException e)
                {
                    Fail("Вебхук", e.Message);
                    return;
                }
            }

            Model.SetCrmSecret(CrmKind.Webhook, v);
            Ok(v.Trim().Length == 0 ? "Вебхук удалён" : "Адрес вебхука сохранён");
        }, placeholder: "https://hooks.example.com/…");
        Add(UiKit.Card(UiKit.VStack(10, UiKit.Strong("Адрес вебхука (https)"),
            UiKit.Muted("Для Make, Zapier, n8n и любых своих сервисов: каждый лид уходит отдельным POST-запросом в формате JSON. Адрес секретный, поэтому допускается только https."),
            UiKit.InputRow(secret))));
    }

    private void FillNotion()
    {
        Heading("Notion");
        var token = UiKit.Secret(Model.CrmSecret(CrmKind.Notion) ?? "", v =>
        {
            Model.SetCrmSecret(CrmKind.Notion, v);
            Refresh();
        }, placeholder: "secret_… или ntn_…");
        var database = new TextBox { Text = _notionDatabaseText, PlaceholderText = "ссылка на базу или её номер" };
        database.TextChanged += (_, _) => _notionDatabaseText = database.Text;
        var load = UiKit.TextButton("Загрузить поля базы", () => Run(() => LoadDatabaseAsync(token.Password)));
        var body = UiKit.VStack(10, UiKit.Strong("Внутренняя интеграция Notion"),
            UiKit.Muted("Создайте интеграцию на notion.so/profile/integrations, откройте нужную базу → «…» → «Подключения» и добавьте интеграцию. Токен вставьте ниже."),
            UiKit.InputRow(token), UiKit.InputRow(database, load));
        Add(UiKit.Card(body));

        if (_database is { } db)
        {
            Add(UiKit.Card(MappingEditor(db)));
        }
        else if (_mapping.Count > 0)
        {
            Add(UiKit.Muted($"Сохранённое сопоставление полей: {_mapping.Count}. Нажмите «Загрузить поля базы», чтобы изменить его."));
        }
    }

    private async Task LoadDatabaseAsync(string tokenText)
    {
        var token = tokenText.Trim();
        if (token.Length == 0)
        {
            Fail("Notion", "Сначала укажите токен интеграции.");
            return;
        }

        var http = Model.Environment.CrmHttp();
        try
        {
            var id = NotionDestination.ParseDatabaseId(_notionDatabaseText);
            Model.SetCrmSecret(CrmKind.Notion, token);
            _database = await NotionDestination.FetchDatabaseAsync(token, id, http);
            _notionDatabaseText = id;
            if (_mapping.Count == 0 || !_mapping.Keys.All(k => _database.Properties.Any(p => p.Name == k)))
            {
                _mapping = NotionDestination.AutoMapping(_database.Properties);
            }

            Refresh();
        }
        catch (CrmException e)
        {
            Fail("Notion", e.Message);
        }
        finally
        {
            (http as IDisposable)?.Dispose();
        }
    }

    private UIElement MappingEditor(NotionDatabase db)
    {
        var body = UiKit.VStack(8, UiKit.Strong($"База «{db.Title}»"),
            UiKit.Muted("Какое поле лида писать в каждое свойство базы. Свойства других типов (формулы, связи, файлы) Notion не принимает."));
        var none = ("— не передавать —", (ExportField?)null);
        var options = new List<(string, ExportField?)> { none };
        options.AddRange(ExportFields.All.Select(f => (f.Title(), (ExportField?)f)));
        foreach (var property in db.Properties.Where(p => p.IsWritable))
        {
            var name = property.Name;
            ExportField? current = _mapping.TryGetValue(name, out var f) ? f : null;
            var combo = UiKit.Combo(options, current, v =>
            {
                if (v is { } field)
                {
                    _mapping[name] = field;
                }
                else
                {
                    _mapping.Remove(name);
                }
            }, 220);
            var row = new Grid { ColumnSpacing = 12 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var label = UiKit.VStack(0, new TextBlock { Text = name }, UiKit.Muted(property.TypeTitle));
            row.Children.Add(label);
            Grid.SetColumn(combo, 1);
            row.Children.Add(combo);
            body.Children.Add(row);
        }

        body.Children.Add(UiKit.TextButton("Сохранить настройку", () =>
        {
            if (!_mapping.Values.Contains(ExportField.Title) && !db.Properties.Any(p => p.Type == "title"))
            {
                Fail("Notion", "В базе нет свойства-заголовка.");
                return;
            }

            Model.SaveNotionSetup(new NotionSetup(db.Id, _mapping));
            Ok("Notion настроен", "Теперь лиды можно отправлять в эту базу.");
        }, accent: true));
        return body;
    }
}

internal sealed class CloudPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    protected override SettingsSection Kind => SettingsSection.Cloud;

    protected override string Lead => "Облако нужно только для синхронизации между вашими устройствами (Windows и macOS). Без него приложение работает полностью, просто без обмена данными.";

    protected override void Fill()
    {
        if (!Session.CloudAvailable)
        {
            Add(UiKit.Bar(InfoBarSeverity.Informational, "Облако не настроено в этой сборке", "Эта копия приложения собрана без адреса облачного сервиса. Все остальные возможности работают в обычном режиме, данные хранятся на этом компьютере."));
            return;
        }

        if (!Model.IsCloud || Session.Sync is not { } sync)
        {
            Add(UiKit.Bar(InfoBarSeverity.Informational, "Вы вошли в локальную запись",
                "Синхронизация работает для облачных записей. Выйдите и войдите по электронной почте (или создайте облачную запись), затем перенесите локальные данные в разделе «Учётная запись»."));
            Add(UiKit.SettingRow("Выйти из локальной записи", null, UiKit.TextButton("Выйти", Session.Logout)));
            return;
        }

        Add(UiKit.Card(UiKit.VStack(6,
            new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, Children = { new FontIcon { Glyph = sync.Glyph, FontSize = 18 }, UiKit.Strong(sync.Summary) } },
            UiKit.Muted("Последняя синхронизация: " + Fmt.Date(sync.LastSync)),
            UiKit.Muted("Ждут отправки изменений: " + sync.Pending))));
        if (sync.ErrorText is { Length: > 0 } error)
        {
            Add(UiKit.Bar(InfoBarSeverity.Warning, "Последняя ошибка", error));
        }

        Add(UiKit.SettingRow("Синхронизировать сейчас", "Отправить свои изменения и получить чужие. Обычно это происходит само, через несколько секунд после правки.",
            UiKit.TextButton("Синхронизировать", () => Run(async () =>
            {
                await sync.SyncNow();
                Refresh();
            }), accent: true)));

        var stats = new TextBlock { TextWrapping = TextWrapping.Wrap, Text = "Нажмите «Сверить», чтобы сравнить число записей на этом компьютере и в облаке." };
        var compare = UiKit.TextButton("Сверить", () => Run(async () =>
        {
            var remote = await sync.RemoteStatsAsync();
            var local = Model.AllLeads;
            var localLeads = local.Count;
            stats.Text = $"Лидов здесь: {localLeads}. " + string.Join(" · ", remote.Select(kv => $"{kv.Key}: {kv.Value}"));
        }));
        Add(UiKit.Card(UiKit.VStack(8, UiKit.Strong("Сверка с облаком"), stats, compare)));
        Add(UiKit.Muted("Синхронизируются лиды, заметки, история, избранное, исключения и настройки поиска. Ключи интеграций, токены и пароль остаются только на этом компьютере."));
    }
}
