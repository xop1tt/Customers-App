using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>Окно «Что нового в версии X.Y.Z?» после обновления: список изменений именно этой версии, закрывается кнопкой.</summary>
internal static class WhatsNewDialog
{
    /// <summary>Открытое сейчас окно (проверка в smoke-тесте закрывает его программно).</summary>
    internal static ContentDialog? Current { get; private set; }

    public static async Task ShowAsync(WhatsNewModel model)
    {
        var body = new StackPanel { Spacing = 6, MinWidth = 380 };
        var loading = new ProgressRing { IsActive = true, Width = 24, Height = 24, HorizontalAlignment = HorizontalAlignment.Left };
        body.Children.Add(loading);
        var dialog = new ContentDialog {
            Title = model.Title,
            Content = new ScrollViewer { MaxHeight = 460, Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto },
            CloseButtonText = "Закрыть",
            SecondaryButtonText = "Все версии на GitHub",
            DefaultButton = ContentDialogButton.Close,
        };
        _ = FillAsync(model, body);
        Current = dialog;
        ContentDialogResult result;
        try
        {
            result = await Dialogs.ShowAsync(dialog);
        }
        finally
        {
            Current = null;
        }

        model.Dismiss(); // и «Закрыть», и Esc: больше для этой версии не показываем
        if (result == ContentDialogResult.Secondary)
        {
            await Launcher.OpenWebAsync(model.ReleasesPage.AbsoluteUri);
        }
    }

    private static async Task FillAsync(WhatsNewModel model, StackPanel body)
    {
        try
        {
            await model.LoadAsync();
        }
        catch (Exception e) when (e is IOException or HttpFailure or HttpRequestException)
        {
            App.Instance.Env.Log.Warn("Описание версии не загружено: " + e.Message);
        }

        body.Children.Clear();
        if (model.Unavailable)
        {
            body.Children.Add(UiKit.Body("Список изменений сейчас недоступен: нет подключения к интернету. Его можно прочитать на странице версий на GitHub."));
            return;
        }

        foreach (var line in model.Lines)
        {
            switch (line.Kind)
            {
                case NoteKind.Heading:
                    body.Children.Add(new TextBlock { Text = line.Text, Style = UiKit.Style("BodyStrongTextBlockStyle"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) });
                    break;
                case NoteKind.Bullet:
                    var row = new Grid { ColumnSpacing = 8 };
                    row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(14) });
                    row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                    row.Children.Add(new TextBlock { Text = "•" });
                    var text = new TextBlock { Text = line.Text, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
                    Grid.SetColumn(text, 1);
                    row.Children.Add(text);
                    body.Children.Add(row);
                    break;
                default:
                    body.Children.Add(UiKit.Body(line.Text, selectable: true));
                    break;
            }
        }
    }
}
