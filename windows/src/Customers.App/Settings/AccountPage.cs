using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Customers.Ui;

internal sealed class AccountPage(AppModel model, SessionModel session, ShellView shell) : SettingsPage(model, session, shell)
{
    protected override SettingsSection Kind => SettingsSection.Account;

    protected override void Fill()
    {
        if (Model.IsCloud)
        {
            FillCloud();
        }
        else
        {
            FillLocal();
        }
    }

    // MARK: Локальная учётная запись

    private void FillLocal()
    {
        var created = Session.LocalAccounts.FirstOrDefault(a => string.Equals(a.Username, Model.Username, StringComparison.OrdinalIgnoreCase));
        Add(UiKit.Card(UiKit.VStack(4,
            UiKit.Strong(Model.DisplayName),
            UiKit.Muted("Локальная учётная запись: данные хранятся только на этом компьютере и работают без интернета."),
            UiKit.Muted("Создана: " + Fmt.Date(created?.CreatedAt) + " · последний вход: " + Fmt.Date(created?.LastLoginAt)))));

        Add(UiKit.SettingRow("Запомнить меня", "При следующем запуске войти в эту запись без ввода пароля. Пароль при этом нигде не сохраняется.",
            UiKit.Toggle(Session.Remembered, v => Session.SetRemembered(v))));

        Heading("Безопасность");
        Add(UiKit.SettingRow("Пароль", "Хранится только в виде хеша; после нескольких неверных попыток вход временно блокируется.",
            UiKit.TextButton("Сменить пароль…", () => Run(ChangeLocalPasswordAsync))));
        Add(UiKit.SettingRow("Выйти", "Закрыть учётную запись и вернуться к экрану входа.", UiKit.TextButton("Выйти", Session.Logout)));

        Heading("Опасная зона");
        var delete = UiKit.TextButton("Удалить запись…", () => Run(DeleteLocalAsync));
        Add(UiKit.SettingRow("Удалить учётную запись", "Удаляет лиды, заметки и настройки этой записи с компьютера. Перед этим сохраняется копия базы.", delete));
    }

    private async Task ChangeLocalPasswordAsync()
    {
        var old = await Dialogs.PromptAsync("Смена пароля", "Текущий пароль", "", password: true, primary: "Далее");
        if (old is null)
        {
            return;
        }

        var next = await Dialogs.PromptAsync("Смена пароля", "Новый пароль (не короче 8 символов, буквы и цифры)", "", password: true, primary: "Далее");
        if (next is null)
        {
            return;
        }

        var again = await Dialogs.PromptAsync("Смена пароля", "Повторите новый пароль", "", password: true, primary: "Сменить");
        if (again is null)
        {
            return;
        }

        var error = await Session.ChangePasswordAsync(old, next, again);
        if (error is null)
        {
            Ok("Пароль изменён");
        }
        else
        {
            Fail("Пароль не изменён", error);
        }
    }

    private async Task DeleteLocalAsync()
    {
        if (!await Dialogs.ConfirmAsync("Удалить учётную запись?",
                $"Запись «{Model.Username}» и все её данные будут удалены с этого компьютера. Копия базы сохранится в папке резервных копий.", "Продолжить"))
        {
            return;
        }

        var password = await Dialogs.PromptAsync("Подтвердите паролем", "Введите пароль учётной записи", "", password: true, primary: "Удалить");
        if (password is null)
        {
            return;
        }

        var error = await Session.DeleteLocalAccountAsync(password);
        if (error is not null)
        {
            Fail("Запись не удалена", error);
        }
    }

    // MARK: Облачная учётная запись

    private void FillCloud()
    {
        var user = Session.CloudUser;
        var details = UiKit.VStack(4, UiKit.Strong(user?.Email ?? Model.DisplayName),
            UiKit.Muted(user is { IsConfirmed: true } ? "Адрес подтверждён" : "Адрес не подтверждён"));
        if (user?.NewEmail is { } pending)
        {
            details.Children.Add(UiKit.Muted("Ожидает подтверждения новый адрес: " + pending));
        }

        details.Children.Add(UiKit.Muted("Облачная запись: лиды хранятся на этом компьютере и синхронизируются с другими вашими устройствами, в том числе с macOS."));
        Add(UiKit.Card(details));

        Heading("Вход и безопасность");
        Add(UiKit.SettingRow("Пароль", null, UiKit.TextButton("Сменить пароль…", () => Run(ChangeCloudPasswordAsync))));
        Add(UiKit.SettingRow("Адрес электронной почты", "Новый адрес нужно подтвердить шестизначным кодом из письма.",
            UiKit.TextButton("Сменить адрес…", () => Run(ChangeCloudEmailAsync))));
        if (user?.NewEmail is { } waiting)
        {
            var codeButton = UiKit.TextButton("Ввести код…", () => Run(() => ConfirmEmailAsync(waiting)));
            var resend = UiKit.TextButton("Выслать код ещё раз", () => Run(ResendAsync));
            Add(UiKit.SettingRow("Подтверждение нового адреса", waiting, UiKit.HStack(8, codeButton, resend)));
        }

        Add(UiKit.SettingRow("Выйти", "Закрыть учётную запись на этом компьютере. Данные в облаке остаются.", UiKit.TextButton("Выйти", Session.Logout)));

        var locals = Session.LocalAccounts;
        if (locals.Count > 0)
        {
            Heading("Перенос локальной записи");
            Add(UiKit.Muted("Скопировать лиды, исключения и настройки локальной записи в эту облачную. Исходная запись не меняется."));
            foreach (var account in locals)
            {
                var name = account.Username;
                Add(UiKit.SettingRow(name, "Локальная запись на этом компьютере", UiKit.TextButton("Перенести в облако…", () => Run(() => ImportAsync(name)))));
            }
        }

        Heading("Опасная зона");
        Add(UiKit.SettingRow("Удалить облачную запись", "Удаляет запись и данные в облаке без возможности вернуть. Перед этим на компьютере сохраняется копия базы.",
            UiKit.TextButton("Удалить запись…", () => Run(DeleteCloudAsync))));
    }

    private async Task ChangeCloudPasswordAsync()
    {
        var old = await Dialogs.PromptAsync("Смена пароля", "Текущий пароль", "", password: true, primary: "Далее");
        if (old is null)
        {
            return;
        }

        var next = await Dialogs.PromptAsync("Смена пароля", "Новый пароль", "", password: true, primary: "Далее");
        if (next is null)
        {
            return;
        }

        var again = await Dialogs.PromptAsync("Смена пароля", "Повторите новый пароль", "", password: true, primary: "Сменить");
        if (again is null)
        {
            return;
        }

        Report(await Session.ChangeCloudPasswordAsync(old, next, again), "Пароль изменён", "Пароль не изменён");
    }

    private async Task ChangeCloudEmailAsync()
    {
        var email = await Dialogs.PromptAsync("Новый адрес", "Укажите новый адрес электронной почты", "name@example.com", primary: "Далее");
        if (email is null)
        {
            return;
        }

        var password = await Dialogs.PromptAsync("Подтвердите паролем", "Введите пароль учётной записи", "", password: true, primary: "Отправить код");
        if (password is null)
        {
            return;
        }

        var error = await Session.ChangeCloudEmailAsync(email, password);
        Report(error, "Код отправлен на новый адрес", "Адрес не изменён");
        Refresh();
    }

    private async Task ConfirmEmailAsync(string email)
    {
        var code = await Dialogs.PromptAsync("Подтверждение адреса", $"Введите код из письма, отправленного на {email}", "000000", primary: "Подтвердить");
        if (code is null)
        {
            return;
        }

        Report(await Session.ConfirmCloudEmailAsync(email, code), "Адрес подтверждён", "Код не подошёл");
        Refresh();
    }

    private async Task ResendAsync() => Report(await Session.ResendCloudEmailChangeAsync(), "Код отправлен повторно", "Письмо не отправлено");

    private async Task ImportAsync(string username)
    {
        var password = await Dialogs.PromptAsync("Перенос в облако", $"Пароль локальной записи «{username}»", "", password: true, primary: "Перенести");
        if (password is null)
        {
            return;
        }

        var error = await Session.ImportLocalAsync(username, password);
        if (error is null)
        {
            Ok("Перенос выполнен", Model.LastMessage ?? "");
        }
        else
        {
            Fail("Перенос не удался", error);
        }
    }

    private async Task DeleteCloudAsync()
    {
        if (!await Dialogs.ConfirmAsync("Удалить облачную запись?",
                "Запись и все данные в облаке будут удалены безвозвратно, в том числе для других ваших устройств. Копия базы сохранится на этом компьютере.", "Продолжить"))
        {
            return;
        }

        var password = await Dialogs.PromptAsync("Подтвердите паролем", "Введите пароль учётной записи", "", password: true, primary: "Удалить");
        if (password is null)
        {
            return;
        }

        var error = await Session.DeleteCloudAccountAsync(password);
        if (error is not null)
        {
            Fail("Запись не удалена", error);
        }
    }

    private static void Report(string? error, string success, string failure)
    {
        if (error is null)
        {
            Ok(success);
        }
        else
        {
            Fail(failure, error);
        }
    }
}
