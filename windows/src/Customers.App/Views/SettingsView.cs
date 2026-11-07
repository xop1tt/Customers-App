using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>Настройки: слева список разделов, справа выбранный раздел. Раздел собирается заново при каждом открытии, чтобы данные были свежими.</summary>
public sealed class SettingsView : UserControl, IDetachable
{
    private readonly AppModel _model;
    private readonly SessionModel _session;
    private readonly ShellView _shell;
    private readonly ListView _list = new() { SelectionMode = ListViewSelectionMode.Single, Width = ExpandedWidth, Padding = new Thickness(8, 0, 8, 8) };
    private readonly ContentControl _host = new() { HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
    private SettingsSection _current = SettingsSection.Appearance;
    private const double ExpandedWidth = 232;
    private const double CompactWidth = 60;
    private readonly List<TextBlock> _titles = [];
    private readonly TextBlock _header;
    private bool _syncing;
    private bool _compact;

    public SettingsView(AppModel model, SessionModel session, ShellView shell)
    {
        _model = model;
        _session = session;
        _shell = shell;
        foreach (var section in Enum.GetValues<SettingsSection>())
        {
            var title = new TextBlock { Text = section.Title(), VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
            _titles.Add(title);
            var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
            row.Children.Add(new FontIcon { Glyph = section.Glyph(), FontSize = 16, Width = 20 });
            row.Children.Add(title);
            var item = new ListViewItem { Content = row, Tag = section, MinHeight = 40, HorizontalContentAlignment = HorizontalAlignment.Left };
            ToolTipService.SetToolTip(item, section.Title());
            _list.Items.Add(item);
        }

        _list.SelectionChanged += (_, _) =>
        {
            if (!_syncing && (_list.SelectedItem as ListViewItem)?.Tag is SettingsSection section)
            {
                Show(section);
            }
        };

        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        _header = new TextBlock { Text = "Настройки", Style = UiKit.Style("TitleTextBlockStyle"), Margin = new Thickness(24, 8, 12, 12) };
        var left = new Grid();
        left.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        left.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        left.Children.Add(_header);
        Grid.SetRow(_list, 1);
        left.Children.Add(_list);
        grid.Children.Add(left);
        Grid.SetColumn(_host, 1);
        grid.Children.Add(_host);
        Content = grid;
        // В узком окне (и при крупном масштабе Windows) список разделов сжимается до значков, чтобы не отнимать место у страницы.
        grid.SizeChanged += (_, e) => SetCompact(e.NewSize.Width < 760);
        Select(_current);
    }

    public void Detach() => _host.Content = null;

    private void SetCompact(bool compact)
    {
        if (compact == _compact)
        {
            return;
        }

        _compact = compact;
        _list.Width = compact ? CompactWidth : ExpandedWidth;
        _header.Visibility = compact ? Visibility.Collapsed : Visibility.Visible;
        foreach (var title in _titles)
        {
            title.Visibility = compact ? Visibility.Collapsed : Visibility.Visible;
        }
    }

    public void Select(SettingsSection section)
    {
        _syncing = true;
        _list.SelectedIndex = (int)section;
        _syncing = false;
        Show(section);
    }

    private void Show(SettingsSection section)
    {
        _current = section;
        SettingsPage page = section switch {
            SettingsSection.Appearance => new AppearancePage(_model, _session, _shell),
            SettingsSection.Background => new BackgroundPage(_model, _session, _shell),
            SettingsSection.Account => new AccountPage(_model, _session, _shell),
            SettingsSection.Search => new SearchPage(_model, _session, _shell),
            SettingsSection.Sources => new SourcesSettingsPage(_model, _session, _shell),
            SettingsSection.Filters => new FiltersPage(_model, _session, _shell),
            SettingsSection.Exclusions => new ExclusionsPage(_model, _session, _shell),
            SettingsSection.Integrations => new IntegrationsPage(_model, _session, _shell),
            SettingsSection.Drives => new DrivesPage(_model, _session, _shell),
            SettingsSection.Mail => new MailPage(_model, _session, _shell),
            SettingsSection.Calls => new CallsPage(_model, _session, _shell),
            SettingsSection.Cloud => new CloudPage(_model, _session, _shell),
            SettingsSection.Backup => new BackupPage(_model, _session, _shell),
            SettingsSection.ExportImport => new ExportImportPage(_model, _session, _shell),
            SettingsSection.Notifications => new NotificationsPage(_model, _session, _shell),
            SettingsSection.Data => new DataPage(_model, _session, _shell),
            _ => new AboutPage(_model, _session, _shell),
        };
        page.Refresh();
        _host.Content = page;
    }
}
