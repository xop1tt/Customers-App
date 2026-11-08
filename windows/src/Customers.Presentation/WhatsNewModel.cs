namespace Customers.Presentation;

/// <summary>Что делать с экраном «Что нового» при запуске.</summary>
public enum WhatsNewDecision
{
    /// <summary>Для этой версии экран уже показан.</summary>
    None,

    /// <summary>Показать: приложение обновилось.</summary>
    Show,

    /// <summary>Не показывать, только запомнить версию: первая установка (её встречает мастер) или переход на более старую версию.</summary>
    RecordOnly,
}

public static class WhatsNewPolicy
{
    /// <param name="lastSeen">Версия, для которой экран уже показывали (из настроек), или null.</param>
    /// <param name="current">Запущенная версия.</param>
    /// <param name="hasExistingData">На компьютере уже были данные приложения, то есть это не первая установка.</param>
    public static WhatsNewDecision Decide(string? lastSeen, AppVersion current, bool hasExistingData)
    {
        if (AppVersion.Parse(lastSeen) is not { } seen)
        {
            return hasExistingData ? WhatsNewDecision.Show : WhatsNewDecision.RecordOnly;
        }

        if (seen < current)
        {
            return WhatsNewDecision.Show;
        }

        return seen > current ? WhatsNewDecision.RecordOnly : WhatsNewDecision.None;
    }
}

/// <summary>
/// «Что нового в версии X.Y.Z?»: показывается один раз для каждой установленной версии. Текст берётся из записи,
/// сохранённой перед установкой (работает без сети), а если её нет — из описания релиза на GitHub.
/// </summary>
public sealed class WhatsNewModel : ObservableObject
{
    private readonly AppEnvironment _env;
    private readonly UpdateStage _stage;
    private IReadOnlyList<NoteLine> _lines = [];
    private bool _loading = true;
    private bool _unavailable;
    private string _title;

    private WhatsNewModel(AppEnvironment env, AppVersion version, UpdateStage stage)
    {
        _env = env;
        _stage = stage;
        Version = version;
        _title = $"Что нового в версии {version}?";
    }

    public AppVersion Version { get; }

    public string Title => _title;

    public IReadOnlyList<NoteLine> Lines { get => _lines; private set => Set(ref _lines, value); }

    public bool Loading { get => _loading; private set => Set(ref _loading, value); }

    /// <summary>Описание не удалось получить (нет сети, релиз без описания): показываем ссылку на страницу релизов.</summary>
    public bool Unavailable { get => _unavailable; private set => Set(ref _unavailable, value); }

    public Uri ReleasesPage => new($"https://github.com/xop1tt/CLIENTS/releases/tag/v{Version}");

    /// <summary>Нужно ли показывать экран. При первой установке и при переходе на старую версию версия запоминается молча.</summary>
    public static WhatsNewModel? Create(AppEnvironment env, AppVersion current, bool hasExistingData)
    {
        switch (WhatsNewPolicy.Decide(env.Device.LastSeenVersion, current, hasExistingData))
        {
            case WhatsNewDecision.Show:
                return new WhatsNewModel(env, current, new UpdateStage(Path.Combine(env.Root, "updates")));
            case WhatsNewDecision.RecordOnly:
                env.Device.LastSeenVersion = current.ToString();
                return null;
            default:
                return null;
        }
    }

    public async Task LoadAsync(CancellationToken ct = default)
    {
        Loading = true;
        try
        {
            var text = _stage.LoadInstalledNotes(Version)?.Notes;
            if (string.IsNullOrWhiteSpace(text) && _env.IsOnline())
            {
                try
                {
                    text = (await new UpdateChecker(_env.SearchTransport()).FetchReleaseAsync(Version, ct).ConfigureAwait(false))?.Body;
                }
                catch (Exception e) when (e is HttpFailure or HttpRequestException or IOException || (e is OperationCanceledException && !ct.IsCancellationRequested))
                {
                    _env.Log.Warn("Описание версии не загружено: " + e.Message);
                }
            }

            var lines = ReleaseNotesText.Parse(text);
            Lines = lines;
            Unavailable = lines.Count == 0;
        }
        finally
        {
            Loading = false;
        }
    }

    /// <summary>Экран закрыт: запоминаем версию, чтобы больше его не показывать, и убираем сохранённое описание.</summary>
    public void Dismiss()
    {
        _env.Device.LastSeenVersion = Version.ToString();
        _stage.ClearInstalledNotes();
    }
}
