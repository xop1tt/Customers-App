namespace Customers.Presentation;

public enum WelcomeStep
{
    /// <summary>Краткое описание возможностей.</summary>
    Intro,
    Sources,
    Integrations,
    Drives,
    Appearance,
}

public static class WelcomeSteps
{
    public static readonly IReadOnlyList<WelcomeStep> All = Enum.GetValues<WelcomeStep>();

    public static string Title(this WelcomeStep step) => step switch {
        WelcomeStep.Intro => "Добро пожаловать",
        WelcomeStep.Sources => "Источники лидов",
        WelcomeStep.Integrations => "Интеграции",
        WelcomeStep.Drives => "Облачные диски",
        _ => "Оформление",
    };

    /// <summary>Первый шаг только знакомит с приложением, остальные можно пропустить.</summary>
    public static bool IsOptional(this WelcomeStep step) => step != WelcomeStep.Intro;
}

/// <summary>Состояние шага для итоговой сводки.</summary>
public enum WelcomeStepState
{
    /// <summary>Шаг ещё впереди или ничего не нужно.</summary>
    Pending,

    /// <summary>Уже настроено (в том числе раньше): повторно настраивать не нужно.</summary>
    Configured,

    /// <summary>Пользователь пропустил шаг.</summary>
    Skipped,
}

/// <summary>
/// Мастер первого запуска: описание → источники → интеграции → диски → оформление.
/// Хранит только положение в мастере; сами настройки применяются сразу через те же модели, что и обычные «Настройки»,
/// поэтому уже подключённое видно как подключённое и повторно не запрашивается.
/// </summary>
public sealed class WelcomeModel : ObservableObject
{
    private readonly AppModel _model;
    private readonly IntegrationsModel _drives;
    private readonly HashSet<WelcomeStep> _skipped = [];
    private int _index;
    private bool _finished;

    public WelcomeModel(AppModel model, IntegrationsModel drives)
    {
        _model = model;
        _drives = drives;
    }

    /// <summary>Мастер нужен, если учётная запись его не проходила и в ней ещё нет данных (иначе это уже обжитая запись, оставшаяся с прошлой версии).</summary>
    public static bool IsNeeded(AppModel model) => !model.Prefs.WelcomeDone && model.AllLeads.Count == 0 && model.RunLog.Count == 0;

    /// <summary>Обжитую запись с прошлой версии отмечаем пройденной, чтобы не показывать мастер.</summary>
    public static void MarkLegacyAccount(AppModel model)
    {
        if (!model.Prefs.WelcomeDone && !IsNeeded(model))
        {
            model.Prefs.WelcomeDone = true;
        }
    }

    public int Index { get => _index; private set { if (Set(ref _index, value)) { RaiseAll(nameof(Step), nameof(CanGoBack), nameof(IsLast), nameof(Progress), nameof(Position), nameof(CanSkip)); } } }

    public WelcomeStep Step => WelcomeSteps.All[_index];

    public int Count => WelcomeSteps.All.Count;

    /// <summary>«Шаг 2 из 5».</summary>
    public string Position => $"Шаг {_index + 1} из {Count}";

    /// <summary>Доля пройденного пути для полосы прогресса: на последнем шаге — полная.</summary>
    public double Progress => (double)(_index + 1) / Count;

    public bool CanGoBack => _index > 0 && !_finished;

    public bool IsLast => _index == Count - 1;

    public bool CanSkip => Step.IsOptional();

    public bool Finished { get => _finished; private set => Set(ref _finished, value); }

    public event Action? Completed;

    public void Back()
    {
        if (CanGoBack)
        {
            Index--;
        }
    }

    /// <summary>«Далее»: шаг считается настроенным (или пройденным), даже если пользователь ничего не менял.</summary>
    public void Next()
    {
        _skipped.Remove(Step);
        Advance();
    }

    /// <summary>«Пропустить»: переход дальше без настройки. Нельзя пропустить знакомство.</summary>
    public void Skip()
    {
        if (!CanSkip)
        {
            Next();
            return;
        }

        _skipped.Add(Step);
        Advance();
    }

    private void Advance()
    {
        if (IsLast)
        {
            Finish();
        }
        else
        {
            Index++;
        }
    }

    /// <summary>Закрывает мастер (дойден до конца или пропущен целиком): запоминает это и открывает главную страницу.</summary>
    public void Finish()
    {
        if (_finished)
        {
            return;
        }

        _model.Prefs.WelcomeDone = true;
        _model.Section = NavSection.Home;
        Finished = true;
        Completed?.Invoke();
    }

    // MARK: Что уже настроено

    public bool SourcesConfigured => _model.SearchSettings.Rss.Enabled || _model.SearchSettings.Telegram.Enabled
        || _model.SearchSettings.Vk.Enabled || _model.SearchSettings.Osm.Enabled;

    public bool IntegrationsConfigured => _model.CrmSecret(CrmKind.Bitrix) is { Length: > 0 }
        || _model.CrmSecret(CrmKind.Webhook) is { Length: > 0 }
        || _model.CrmSecret(CrmKind.Notion) is { Length: > 0 }
        || _model.Prefs.MailAccount.Length > 0;

    public bool DrivesConfigured => _drives.Connections.Count > 0;

    public IntegrationsModel Drives => _drives;

    public AppModel Model => _model;

    /// <summary>Что показать на шаге: уже настроено, пропущено или ещё нет.</summary>
    public WelcomeStepState StateOf(WelcomeStep step)
    {
        var configured = step switch {
            WelcomeStep.Sources => SourcesConfigured,
            WelcomeStep.Integrations => IntegrationsConfigured,
            WelcomeStep.Drives => DrivesConfigured,
            _ => false,
        };
        if (configured)
        {
            return WelcomeStepState.Configured;
        }

        return _skipped.Contains(step) ? WelcomeStepState.Skipped : WelcomeStepState.Pending;
    }
}
