using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>
/// Мастер первого запуска: описание → источники → интеграции → диски → оформление. Шаги используют те же страницы настроек,
/// что и обычные «Настройки», поэтому изменения применяются сразу, а уже подключённое показано как подключённое.
/// </summary>
internal sealed class WelcomeView : UserControl
{
    private static readonly (string Text, int Value)[] AutoSearch =
    [
        ("Выключен", 0), ("Каждые 30 минут", 30), ("Каждый час", 60), ("Каждые 2 часа", 120), ("Каждые 6 часов", 360), ("Раз в сутки", 1440),
    ];

    private readonly WelcomeModel _wizard;
    private readonly AppModel _model;
    private readonly SessionModel _session;
    private readonly ShellView _shell;
    private readonly TextBlock _position = new() { Style = UiKit.Style("CaptionTextBlockStyle") };
    private readonly TextBlock _title = new() { Style = UiKit.Style("TitleTextBlockStyle") };
    private readonly ProgressBar _bar = new() { Minimum = 0, Maximum = 1, Height = 4 };
    private readonly StackPanel _steps = new() { Orientation = Orientation.Horizontal, Spacing = 6 };
    private readonly Grid _body = new();
    private readonly Button _back;
    private readonly Button _skip;
    private readonly Button _next;
    private int _integrationTab;

    public WelcomeView(WelcomeModel wizard, AppModel model, SessionModel session, ShellView shell)
    {
        _wizard = wizard;
        _model = model;
        _session = session;
        _shell = shell;
        _back = UiKit.TextButton("Назад", _wizard.Back);
        _skip = UiKit.TextButton("Пропустить", _wizard.Skip, tip: "Перейти дальше, не настраивая этот шаг. Позже всё можно настроить в «Настройках».");
        _next = UiKit.TextButton("Далее", _wizard.Next, accent: true);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(_bar, "Прогресс первоначальной настройки");

        var close = new HyperlinkButton { Content = "Пропустить всю настройку" };
        ToolTipService.SetToolTip(close, "Закрыть мастер и открыть главную страницу. Всё можно настроить позже в «Настройках».");
        close.Click += (_, _) => _wizard.Finish();

        var header = new Grid { ColumnSpacing = 12 };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var titles = UiKit.VStack(4, _position, _title);
        header.Children.Add(titles);
        Grid.SetColumn(close, 1);
        header.Children.Add(close);

        var footer = new Grid { ColumnSpacing = 8 };
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        footer.Children.Add(_back);
        Grid.SetColumn(_skip, 2);
        footer.Children.Add(_skip);
        Grid.SetColumn(_next, 3);
        footer.Children.Add(_next);

        var column = new Grid { MaxWidth = 960, RowSpacing = 12, Margin = new Thickness(24, 16, 24, 20), HorizontalAlignment = HorizontalAlignment.Stretch };
        column.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        column.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        column.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        column.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        column.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        column.Children.Add(header);
        Grid.SetRow(_steps, 1);
        column.Children.Add(_steps);
        Grid.SetRow(_bar, 2);
        column.Children.Add(_bar);
        Grid.SetRow(_body, 3);
        column.Children.Add(_body);
        Grid.SetRow(footer, 4);
        column.Children.Add(footer);

        Content = new Grid {
            Background = UiKit.ThemeBrush("SolidBackgroundFillColorBaseBrush"),
            Children = { column },
        };
        HorizontalContentAlignment = HorizontalAlignment.Stretch;

        _wizard.PropertyChanged += OnWizardChanged;
        _wizard.Drives.PropertyChanged += OnDrivesChanged;
        Unloaded += (_, _) =>
        {
            _wizard.PropertyChanged -= OnWizardChanged;
            _wizard.Drives.PropertyChanged -= OnDrivesChanged;
        };
        ShowStep();
    }

    private void OnWizardChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(WelcomeModel.Index))
        {
            ShowStep();
        }
    }

    private void OnDrivesChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (_wizard.Step == WelcomeStep.Drives)
        {
            ShowStep(rebuildBody: false);
        }
    }

    private void ShowStep(bool rebuildBody = true)
    {
        var step = _wizard.Step;
        _position.Text = _wizard.Position;
        _title.Text = step.Title();
        _bar.Value = _wizard.Progress;
        _back.Visibility = Fmt.Vis(_wizard.CanGoBack);
        _skip.Visibility = Fmt.Vis(_wizard.CanSkip && !_wizard.IsLast);
        _next.Content = _wizard.IsLast ? "Готово — открыть главную" : "Далее";
        BuildStepper();
        if (!rebuildBody)
        {
            return;
        }

        _body.Children.Clear();
        _body.RowDefinitions.Clear();
        _body.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _body.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var status = StatusBar(step);
        _body.Children.Add(status);
        FrameworkElement content = step switch {
            WelcomeStep.Intro => BuildIntro(),
            WelcomeStep.Sources => BuildSources(),
            WelcomeStep.Integrations => BuildIntegrations(),
            WelcomeStep.Drives => HostPage(new DrivesPage(_model, _session, _shell)),
            _ => HostPage(new AppearancePage(_model, _session, _shell)),
        };
        Grid.SetRow(content, 1);
        _body.Children.Add(content);
    }

    private static FrameworkElement HostPage(SettingsPage page)
    {
        page.Refresh();
        return page;
    }

    private void BuildStepper()
    {
        _steps.Children.Clear();
        for (var i = 0; i < WelcomeSteps.All.Count; i++)
        {
            var step = WelcomeSteps.All[i];
            var current = i == _wizard.Index;
            var done = i < _wizard.Index;
            var glyph = done ? Glyphs.Check : null;
            var circle = new Border {
                Width = 24,
                Height = 24,
                CornerRadius = new CornerRadius(12),
                Background = current || done ? UiKit.ThemeBrush("AccentFillColorDefaultBrush") : UiKit.ThemeBrush("SubtleFillColorSecondaryBrush"),
                Child = glyph is not null
                    ? new FontIcon { Glyph = glyph, FontSize = 11, Foreground = Fmt.White }
                    : new TextBlock { Text = (i + 1).ToString(System.Globalization.CultureInfo.CurrentCulture), FontSize = 12, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, Foreground = current ? Fmt.White : UiKit.ThemeBrush("TextFillColorSecondaryBrush") },
            };
            var label = new TextBlock { Text = step.Title(), VerticalAlignment = VerticalAlignment.Center, Opacity = current ? 1 : 0.65, TextTrimming = TextTrimming.CharacterEllipsis };
            var item = UiKit.HStack(6, circle, label);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(item, $"Шаг {i + 1}: {step.Title()}" + (current ? ", текущий" : done ? ", пройден" : ""));
            if (i > 0)
            {
                item.Margin = new Thickness(6, 0, 0, 0);
            }

            _steps.Children.Add(item);
        }
    }

    /// <summary>Над шагом: что уже настроено раньше (повторно настраивать не нужно) или что пропущено.</summary>
    private UIElement StatusBar(WelcomeStep step)
    {
        var state = _wizard.StateOf(step);
        string? text = step switch {
            WelcomeStep.Sources when state == WelcomeStepState.Configured => "Источники уже включены. Можно оставить как есть или поменять.",
            WelcomeStep.Integrations when state == WelcomeStepState.Configured => "Одна или несколько интеграций уже подключены. Повторно настраивать их не нужно.",
            WelcomeStep.Drives when state == WelcomeStepState.Configured =>
                "Уже подключено: " + string.Join(", ", _wizard.Drives.Connections.Keys.Select(s => s.Title())) + ". Повторно входить не нужно.",
            _ => null,
        };
        if (text is null)
        {
            return new Grid { Height = 0 };
        }

        var bar = UiKit.Bar(InfoBarSeverity.Success, "Уже настроено", text);
        bar.Margin = new Thickness(0, 0, 0, 8);
        return bar;
    }

    // MARK: Шаги

    private static FrameworkElement Feature(string glyph, string title, string text)
    {
        var icon = new FontIcon { Glyph = glyph, FontSize = 22, VerticalAlignment = VerticalAlignment.Top, Foreground = UiKit.ThemeBrush("AccentTextFillColorPrimaryBrush") };
        var grid = new Grid { ColumnSpacing = 14 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(32) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.Children.Add(icon);
        var texts = UiKit.VStack(2, UiKit.Strong(title), UiKit.Muted(text));
        Grid.SetColumn(texts, 1);
        grid.Children.Add(texts);
        return UiKit.Card(grid, 14);
    }

    private static FrameworkElement BuildIntro()
    {
        var stack = new StackPanel { Spacing = 10 };
        stack.Children.Add(UiKit.SubTitle("Customers находит заказы и потенциальных клиентов в открытых источниках"));
        stack.Children.Add(UiKit.Muted("Пять коротких шагов — и всё готово к работе. Любой шаг можно пропустить, всё это есть и в «Настройках»."));
        stack.Children.Add(Feature("", "Поиск лидов", "Биржи заказов, Telegram-каналы, сообщества и организации на карте: приложение само проверяет источники по расписанию, в том числе в фоне."));
        stack.Children.Add(Feature("", "Оценка и карточки", "Каждому лиду ставится оценка. В карточке — контакты, заметки, история, напоминания о том, что уже сделано."));
        stack.Children.Add(Feature("", "Связь одним нажатием", "Позвонить или написать прямо из карточки, отправить лиды в Bitrix24, Notion или по вебхуку."));
        stack.Children.Add(Feature("", "Облако и диски", "Одна учётная запись на Windows и Mac, резервные копии на Google Диск, Яндекс Диск, Dropbox, OneDrive и WebDAV."));
        stack.Children.Add(Feature("", "Ваше оформление", "Светлая и тёмная тема, цвет акцента, плотность списка. Меняется сразу."));
        return UiKit.Page(stack, 960);
    }

    private FrameworkElement BuildSources()
    {
        var s = _model.SearchSettings;
        var stack = new StackPanel { Spacing = 10 };
        stack.Children.Add(UiKit.Muted("Выберите, где искать. Всё здесь можно пропустить: пока списки пусты, приложение ничего за вас не подставляет. Те же настройки лежат в «Настройки → Источники»."));
        stack.Children.Add(UiKit.SettingRow("Ленты заказов (FL.ru и другие RSS)", "Свежие заказы с бирж фриланса.",
            UiKit.Toggle(s.Rss.Enabled, v => Change(x => x.Rss.Enabled = v))));
        stack.Children.Add(UiKit.SettingRow("Telegram-каналы", "Публичные каналы с заказами, без входа в аккаунт.",
            UiKit.Toggle(s.Telegram.Enabled, v => Change(x => x.Telegram.Enabled = v))));
        stack.Children.Add(UiKit.SettingRow("Организации на карте (OpenStreetMap)", "Компании без сайта или с устаревшим сайтом — потенциальные клиенты.",
            UiKit.Toggle(s.Osm.Enabled, v => Change(x => x.Osm.Enabled = v))));
        stack.Children.Add(SourceFilters.Regions(_model, autoLocate: true));
        stack.Children.Add(SourceFilters.TelegramChannels(_model));
        stack.Children.Add(SourceFilters.TelegramKeywords(_model));
        stack.Children.Add(SourceFilters.Categories(_model, withWeights: false));
        stack.Children.Add(UiKit.SettingRow("Сообщества ВКонтакте", "Нужен бесплатный сервисный ключ VK — его можно добавить позже в «Источниках».",
            UiKit.Toggle(s.Vk.Enabled, v => Change(x => x.Vk.Enabled = v))));
        stack.Children.Add(UiKit.SettingRow("Автоматический поиск", "Пока приложение запущено (в том числе в области уведомлений), источники проверяются по расписанию.",
            UiKit.Combo(AutoSearch, NearestAutoSearch(_model.AutoSearchMinutes), v => _model.AutoSearchMinutes = v, 200)));
        return UiKit.Page(stack, 960);
    }

    private static int NearestAutoSearch(int minutes) => AutoSearch.Any(a => a.Value == minutes) ? minutes : 60;

    private void Change(Action<SearchSettings> change) => _model.UpdateSearchSettings(change);

    private FrameworkElement BuildIntegrations()
    {
        var grid = new Grid { RowSpacing = 8 };
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var tabs = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(24, 0, 24, 0) };
        var host = new ContentControl { HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };

        void Show(int tab)
        {
            _integrationTab = tab;
            host.Content = tab == 0 ? HostPage(new IntegrationsPage(_model, _session, _shell)) : HostPage(new MailPage(_model, _session, _shell));
        }

        var crm = new RadioButton { Content = "CRM и вебхуки", GroupName = "welcome-integrations", IsChecked = _integrationTab == 0 };
        var mail = new RadioButton { Content = "Почта для писем", GroupName = "welcome-integrations", IsChecked = _integrationTab == 1 };
        crm.Checked += (_, _) => Show(0);
        mail.Checked += (_, _) => Show(1);
        tabs.Children.Add(crm);
        tabs.Children.Add(mail);
        grid.Children.Add(tabs);
        Grid.SetRow(host, 1);
        grid.Children.Add(host);
        Show(_integrationTab);
        return grid;
    }
}
