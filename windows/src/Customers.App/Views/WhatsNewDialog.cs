using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>Окно «Что нового в версии X.Y.Z?» после обновления: коротко и только про Windows, с картинками, показывающими новые возможности. Без полного списка и ссылок на GitHub.</summary>
internal static class WhatsNewDialog
{
    /// <summary>Открытое сейчас окно (проверка в smoke-тесте закрывает его программно).</summary>
    internal static ContentDialog? Current { get; private set; }

    public static async Task ShowAsync(WhatsNewModel model)
    {
        var body = new StackPanel { Spacing = 10, MinWidth = 380 };
        var loading = new ProgressRing { IsActive = true, Width = 24, Height = 24, HorizontalAlignment = HorizontalAlignment.Left };
        body.Children.Add(loading);
        var dialog = new ContentDialog {
            Title = model.Title,
            Content = new ScrollViewer { MaxHeight = 460, Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto },
            CloseButtonText = "Закрыть",
            DefaultButton = ContentDialogButton.Close,
        };
        _ = FillAsync(model, body);
        Current = dialog;
        try
        {
            await Dialogs.ShowAsync(dialog);
        }
        finally
        {
            Current = null;
        }

        model.Dismiss(); // и «Закрыть», и Esc: больше для этой версии не показываем
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
            body.Children.Add(UiKit.Body("Список изменений сейчас недоступен: нет подключения к интернету. Он появится здесь, когда подключение вернётся."));
            return;
        }

        var animate = App.Instance.Env.Device.Animations && !App.Instance.LightMode.Active;
        if (model.Features.Count == 0)
        {
            body.Children.Add(UiKit.Body("В этой версии мы улучшили стабильность и скорость работы."));
            return;
        }

        foreach (var feature in model.Features)
        {
            body.Children.Add(FeatureCard(feature, animate));
        }
    }

    /// <summary>Тема, её пункты и картинка, показывающая возможность в действии.</summary>
    private static Border FeatureCard(WhatsNewFeature feature, bool animate)
    {
        var text = new StackPanel { Spacing = 6, VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = feature.Title, Style = UiKit.Style("BodyStrongTextBlockStyle"), TextWrapping = TextWrapping.Wrap });
        foreach (var item in feature.Items)
        {
            var row = new Grid { ColumnSpacing = 8 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(14) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.Children.Add(new TextBlock { Text = "•" });
            var line = new TextBlock { Text = item, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
            Grid.SetColumn(line, 1);
            row.Children.Add(line);
            text.Children.Add(row);
        }

        var grid = new Grid { ColumnSpacing = 16, RowSpacing = 10 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        if (feature.Preview is { } preview)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(230) });
            var picture = WhatsNewPreviews.Create(preview, animate);
            Grid.SetColumn(picture, 1);
            grid.Children.Add(text);
            grid.Children.Add(picture);
        }
        else
        {
            grid.Children.Add(text);
        }

        return UiKit.Card(grid, 14);
    }
}
