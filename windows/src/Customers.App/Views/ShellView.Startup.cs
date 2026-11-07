using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>Экраны, которые показываются поверх рабочего окна один раз: мастер первого запуска и «Что нового».</summary>
public sealed partial class ShellView
{
    private bool _startupPresented;
    private ContentControl? _overlay;

    /// <summary>Открытый сейчас мастер первого запуска (для проверки в smoke-тесте) или null.</summary>
    internal WelcomeModel? ActiveWizard { get; private set; }

    /// <summary>
    /// Вызывается, когда окно готово и видно. Если запуск был в фоне (окно в области уведомлений), экраны ждут первого показа окна.
    /// Сначала мастер (для новой учётной записи), иначе — «Что нового» (после обновления).
    /// </summary>
    internal void TryPresentStartupScreens()
    {
        if (_startupPresented || _detached || XamlRoot is null || App.Instance.MainWindow.IsHiddenToTray)
        {
            return;
        }

        _startupPresented = true;
        _ = PresentStartupScreensAsync();
    }

    private async Task PresentStartupScreensAsync()
    {
        try
        {
            WelcomeModel.MarkLegacyAccount(Model);
            if (WelcomeModel.IsNeeded(Model))
            {
                // Новая установка: версию запоминаем сразу, «Что нового» после неё не нужно.
                _device.LastSeenVersion = UpdateService.Current.ToString();
                ShowWelcome();
                return;
            }

            if (WhatsNewModel.Create(App.Instance.Env, UpdateService.Current, App.Instance.ExistingInstall) is { } whatsNew)
            {
                await Task.Delay(400);
                await WhatsNewDialog.ShowAsync(whatsNew);
            }
        }
        catch (Exception e) when (e is IOException or InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            App.Instance.Env.Log.Warn("Начальные экраны не показаны: " + e.Message);
        }
    }

    private void ShowWelcome()
    {
        var wizard = new WelcomeModel(Model, new IntegrationsModel(App.Instance.Env, Model.Username));
        ActiveWizard = wizard;
        _overlay = new ContentControl { HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch, IsTabStop = false };
        _overlay.Content = new WelcomeView(wizard, Model, _session, this);
        Layout.Children.Add(_overlay);
        wizard.Completed += () =>
        {
            Layout.Children.Remove(_overlay);
            _overlay = null;
            ActiveWizard = null;
            Navigate(NavSection.Home);
        };
    }
}
