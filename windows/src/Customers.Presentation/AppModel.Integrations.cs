namespace Customers.Presentation;

public sealed partial class AppModel
{
    private IntegrationsModel? _drives;
    private MailModel? _mail;

    /// <summary>Облачные диски этой учётной записи.</summary>
    public IntegrationsModel Drives => _drives ??= new IntegrationsModel(_env, Username);

    /// <summary>Почта этой учётной записи.</summary>
    public MailModel Mail => _mail ??= new MailModel(_env, Prefs, Username);

    /// <summary>Создаёт свежую резервную копию и выгружает её на диск.</summary>
    public async Task<bool> UploadBackupAsync(DriveService service)
    {
        if (BackupNow() is not { } file)
        {
            Drives.ReportError("Не удалось создать копию базы: " + (LastError ?? "неизвестная ошибка"));
            return false;
        }

        return await Drives.UploadAsync(file, service).ConfigureAwait(true);
    }
}
