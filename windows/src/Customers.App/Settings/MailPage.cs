using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

/// <summary>«Настройки → Почта»: как отправлять письма из карточки лида — через почтовую программу Windows или прямо из приложения по SMTP.</summary>
internal sealed class MailPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    protected override SettingsSection Kind => SettingsSection.Mail;

    protected override string Lead => "Письма уходят по одному, по вашей кнопке: массовой рассылки нет. Соединение всегда зашифровано (TLS или STARTTLS), пароль хранится только в защищённом хранилище Windows.";

    private MailModel Mail => Model.Mail;

    protected override void Fill()
    {
        var delivery = new RadioButtons();
        delivery.Items.Add(new RadioButton { Content = MailDelivery.MailApp.Title(), Tag = MailDelivery.MailApp });
        delivery.Items.Add(new RadioButton { Content = MailDelivery.Smtp.Title(), Tag = MailDelivery.Smtp });
        delivery.SelectedIndex = Mail.Delivery == MailDelivery.Smtp ? 1 : 0;
        delivery.SelectionChanged += (_, _) =>
        {
            if (delivery.SelectedItem is RadioButton { Tag: MailDelivery chosen } && chosen != Mail.Delivery)
            {
                Mail.Delivery = chosen;
                Refresh();
            }
        };
        Add(UiKit.Card(UiKit.VStack(8, UiKit.Strong("Как отправлять письма"), delivery)));

        if (Mail.Delivery == MailDelivery.MailApp)
        {
            Add(UiKit.Card(UiKit.VStack(6,
                UiKit.Strong("Почтовая программа Windows"),
                UiKit.Body("Кнопка «Написать письмо» создаёт готовое письмо с черновиком в программе, выбранной в Windows по умолчанию (Почта, Outlook, Thunderbird…). Отправленные письма хранятся там же."),
                UiKit.TextButton("Выбрать программу по умолчанию", () => _ = Windows.System.Launcher.LaunchUriAsync(new Uri("ms-settings:defaultapps"))))));
            return;
        }

        BuildSmtpForm();
    }

    private void BuildSmtpForm()
    {
        var saved = Mail.Account ?? new MailAccount();
        var provider = saved.Provider;
        var address = new TextBox { Header = "Ваш адрес", PlaceholderText = "name@gmail.com", Text = saved.FromAddress };
        var name = new TextBox { Header = "Имя отправителя", PlaceholderText = "Максим", Text = saved.FromName };
        var host = new TextBox { Header = "SMTP-сервер", PlaceholderText = "smtp.example.ru", Text = saved.Host };
        var security = UiKit.Combo([(MailSecurity.Tls.Title(), MailSecurity.Tls), (MailSecurity.StartTls.Title(), MailSecurity.StartTls)], saved.Security, _ => { });
        security.Header = "Шифрование";
        var port = new NumberBox { Header = "Порт", Value = saved.Port, Minimum = 1, Maximum = 65535, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Hidden, Width = 120 };
        var login = new TextBox { Header = "Логин", PlaceholderText = "обычно весь адрес", Text = saved.Username };
        var password = new PasswordBox { Header = "Пароль приложения", PlaceholderText = Mail.HasPassword ? "сохранён в защищённом хранилище" : "" };
        var copy = new ToggleSwitch { Header = "Копия себе", OnContent = "Письмо появится во «Входящих» на всех устройствах", OffContent = "Не отправлять копию", IsOn = saved.CopyToSelf };
        var providerTitle = new TextBlock { VerticalAlignment = VerticalAlignment.Center };
        var hint = UiKit.Muted("");
        var passwordPage = new HyperlinkButton { Content = "Создать пароль приложения", Padding = new Thickness(0) };
        var custom = UiKit.VStack(10, host, UiKit.HStack(12, security, port));
        var problem = new TextBlock { Foreground = UiKit.ThemeBrush("SystemFillColorCriticalBrush"), TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed };
        var status = new InfoBar { IsOpen = false, IsClosable = false };

        MailSecurity SelectedSecurity() => (security.SelectedItem as ComboBoxItem)?.Tag is MailSecurity s ? s : MailSecurity.Tls;
        MailAccount Draft() => new(provider, host.Text.Trim(), double.IsNaN(port.Value) ? 0 : (int)port.Value, SelectedSecurity(),
            login.Text.Trim().Length == 0 ? address.Text.Trim() : login.Text.Trim(), address.Text.Trim(), name.Text.Trim(), copy.IsOn);

        void ShowProvider()
        {
            providerTitle.Text = provider.Title();
            hint.Text = provider.Hint();
            passwordPage.NavigateUri = provider.AppPasswordPage();
            passwordPage.Visibility = Fmt.Vis(provider.AppPasswordPage() is not null);
            custom.Visibility = Fmt.Vis(provider == MailProvider.Custom);
        }

        void ShowProblem()
        {
            var text = address.Text.Length > 0 ? Draft().Problem : null;
            problem.Text = text ?? "";
            problem.Visibility = Fmt.Vis(text is not null);
        }

        address.TextChanged += (_, _) =>
        {
            var detected = MailProviders.Detect(address.Text);
            provider = detected;
            if (detected != MailProvider.Custom)
            {
                host.Text = detected.Host();
                port.Value = detected.Port();
                security.SelectedIndex = detected.Security() == MailSecurity.Tls ? 0 : 1;
            }

            if (login.Text.Length == 0 || login.Text.Contains('@'))
            {
                login.Text = address.Text;
            }

            ShowProvider();
            ShowProblem();
        };
        security.SelectionChanged += (_, _) =>
        {
            if (provider == MailProvider.Custom)
            {
                port.Value = SelectedSecurity() == MailSecurity.Tls ? 465 : 587;
            }
        };
        host.TextChanged += (_, _) => ShowProblem();
        login.TextChanged += (_, _) => ShowProblem();
        ShowProvider();

        void ShowResult(bool ok, string text)
        {
            status.Severity = ok ? InfoBarSeverity.Success : InfoBarSeverity.Error;
            status.Title = text;
            status.IsOpen = true;
        }

        bool Save()
        {
            var draft = Draft();
            if (draft.Problem is { } p)
            {
                ShowResult(false, p);
                return false;
            }

            Mail.Account = draft;
            if (password.Password.Length > 0)
            {
                Mail.SetPassword(password.Password);
                password.Password = "";
                password.PlaceholderText = "сохранён в защищённом хранилище";
            }

            return true;
        }

        var saveButton = UiKit.TextButton("Сохранить", () =>
        {
            if (Save())
            {
                ShowResult(true, "Сохранено");
            }
        }, accent: true);
        var testButton = UiKit.TextButton("Отправить проверочное письмо", () => Run(async () =>
        {
            if (!Save())
            {
                return;
            }

            if (!Mail.HasPassword)
            {
                ShowResult(false, "Введите пароль приложения");
                return;
            }

            ShowResult(true, "Отправляю…");
            var ok = await Mail.SendTestAsync();
            ShowResult(ok, ok ? Mail.LastResult ?? "Отправлено" : Mail.LastError ?? "Не удалось отправить");
        }, "Не удалось отправить письмо"));
        var forget = UiKit.TextButton("Забыть почту", () => Run(async () =>
        {
            if (await Dialogs.ConfirmAsync("Забыть настройки почты?", "Пароль приложения и настройки ящика будут удалены с этого компьютера. Письма в вашем ящике не пострадают.", "Забыть"))
            {
                Mail.Forget();
                Refresh();
            }
        }));
        forget.IsEnabled = Mail.Account is not null || Mail.HasPassword;

        var form = UiKit.VStack(10,
            UiKit.Strong("Отправка из приложения (SMTP)"),
            address,
            name,
            UiKit.HStack(12, providerTitle, passwordPage),
            hint,
            custom,
            login,
            password,
            copy,
            problem,
            UiKit.HStack(8, saveButton, testButton, forget),
            status);
        Add(UiKit.Card(form));
        Add(UiKit.Muted("Для Gmail, Яндекса, Mail.ru и iCloud вместо обычного пароля нужен пароль приложения: ссылка на его создание появится после ввода адреса. "
            + "Сервер, порт и шифрование для них подставляются сами."));
    }
}

/// <summary>Окно «Написать письмо»: адрес, тема и текст черновика; отправка из приложения (если настроена) или открытие в почтовой программе.</summary>
internal static class ComposeMailDialog
{
    public static async Task ShowAsync(AppModel model, LeadItem lead, string to, string subject, string body)
    {
        var mail = model.Mail;
        var toBox = new TextBox { Header = "Кому", Text = to };
        var subjectBox = new TextBox { Header = "Тема", Text = subject };
        var bodyBox = new TextBox { Header = "Текст", Text = body, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 220, MaxHeight = 340 };
        var error = new TextBlock { Foreground = UiKit.ThemeBrush("SystemFillColorCriticalBrush"), TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed };
        var panel = new StackPanel { Spacing = 10, Width = 520 };
        var smtp = mail.SmtpReady;
        panel.Children.Add(UiKit.Muted(smtp
            ? $"Письмо уйдёт с адреса {mail.Account!.FromAddress} прямо из приложения."
            : "Отправка из приложения не настроена: письмо откроется в почтовой программе Windows. Включить отправку можно в «Настройки → Почта»."));
        panel.Children.Add(toBox);
        panel.Children.Add(subjectBox);
        panel.Children.Add(bodyBox);
        panel.Children.Add(error);

        var dialog = new ContentDialog {
            Title = "Написать письмо",
            Content = new ScrollViewer { Content = panel, MaxHeight = 560 },
            PrimaryButtonText = smtp ? "Отправить" : "Открыть в почтовой программе",
            SecondaryButtonText = smtp ? "Открыть в почтовой программе" : "",
            CloseButtonText = "Отмена",
            DefaultButton = ContentDialogButton.Primary,
        };
        var openInMailApp = false;
        dialog.PrimaryButtonClick += async (_, e) =>
        {
            var deferral = e.GetDeferral();
            try
            {
                if (!smtp)
                {
                    openInMailApp = true;
                    return;
                }

                dialog.IsPrimaryButtonEnabled = false;
                dialog.PrimaryButtonText = "Отправляю…";
                var sent = await mail.SendAsync(new OutgoingMail(toBox.Text, subjectBox.Text, bodyBox.Text));
                if (!sent)
                {
                    error.Text = mail.LastError ?? "Не удалось отправить письмо.";
                    error.Visibility = Visibility.Visible;
                    e.Cancel = true;
                    dialog.IsPrimaryButtonEnabled = true;
                    dialog.PrimaryButtonText = "Отправить";
                }
            }
            finally
            {
                deferral.Complete();
            }
        };
        var result = await Dialogs.ShowAsync(dialog);
        var address = toBox.Text.Trim();
        if (result == ContentDialogResult.Primary && smtp)
        {
            model.LogEvent(lead.Id, $"Отправлено письмо на {address}");
            App.Instance.Notifier.Success("Письмо отправлено", address);
        }
        else if ((result == ContentDialogResult.Secondary || openInMailApp) && ContactLinks.MailtoUri(address, subjectBox.Text, bodyBox.Text) is { } uri)
        {
            if (await Launcher.OpenAsync(uri))
            {
                model.LogEvent(lead.Id, $"Открыто письмо для {address}");
            }
            else
            {
                App.Instance.Notifier.Error("Не удалось открыть почтовую программу", "Выберите программу для писем в «Параметры → Приложения по умолчанию» или настройте отправку из приложения.");
            }
        }
        else if (result != ContentDialogResult.None && !ContactLinks.IsEmail(address))
        {
            App.Instance.Notifier.Error("Неверный адрес получателя", address);
        }
    }
}
