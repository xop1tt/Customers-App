namespace Customers.Presentation;

public enum UpdatePhase
{
    Idle,
    Checking,
    UpToDate,
    /// <summary>Найдена новая версия, она ещё не скачана.</summary>
    Available,
    Downloading,
    /// <summary>Установщик скачан, проверен и ждёт согласия пользователя.</summary>
    Ready,
    Installing,
    Failed,
}

/// <summary>
/// Обновление приложения: проверка, фоновое скачивание, готовность к установке. Ничего не устанавливается без согласия:
/// установщик запускается только вызовом <see cref="InstallAsync"/>, который делает интерфейс по нажатию пользователя.
/// Работающая копия приложения не меняется, пока не начнётся установка; скачанное проверяется по SHA-256 дважды.
/// </summary>
public sealed class UpdateModel : ObservableObject
{
    /// <summary>После неудачной автоматической попытки следующая — не раньше, чем через это время.</summary>
    public static readonly TimeSpan RetryAfterFailure = TimeSpan.FromHours(1);

    private readonly AppEnvironment _env;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private UpdatePhase _phase;
    private UpdateOffer? _offer;
    private StagedUpdate? _staged;
    private double? _progress;
    private string? _error;
    private bool _errorIsSpace;
    private DateTimeOffset _nextAutomaticAttempt = DateTimeOffset.MinValue;
    private readonly DateTimeOffset _startedAt;
    private DateTimeOffset _lastProgressReport = DateTimeOffset.MinValue;
    private CancellationTokenSource? _download;

    public UpdateModel(AppEnvironment env, AppVersion current)
    {
        _env = env;
        _startedAt = env.Now();
        Current = current;
        Stage = new UpdateStage(Path.Combine(env.Root, "updates"));
        _staged = Stage.Load(current);
        _phase = _staged is null ? UpdatePhase.Idle : UpdatePhase.Ready;
        if (_staged is null)
        {
            // Остатки прерванного скачивания или давно установленной версии не нужны.
            Stage.Clear();
        }
    }

    public AppVersion Current { get; }

    public UpdateStage Stage { get; }

    private DevicePreferences Device => _env.Device;

    public UpdatePhase Phase { get => _phase; private set => Assign(ref _phase, value); }

    /// <summary>Найденная, но, возможно, ещё не скачанная версия.</summary>
    public UpdateOffer? Offer { get => _offer; private set => Assign(ref _offer, value); }

    /// <summary>Скачанное и проверенное обновление.</summary>
    public StagedUpdate? Staged { get => _staged; private set => Assign(ref _staged, value); }

    /// <summary>Доля скачанного (0..1) или null, если размер неизвестен.</summary>
    public double? Progress { get => _progress; private set => Assign(ref _progress, value); }

    public string? Error { get => _error; private set => Assign(ref _error, value); }

    /// <summary>Ошибка из-за нехватки места на диске (интерфейс подсказывает, что делать).</summary>
    public bool ErrorIsSpace => _errorIsSpace;

    public bool IsBusy => Phase is UpdatePhase.Checking or UpdatePhase.Downloading or UpdatePhase.Installing;

    /// <summary>Версия, о которой идёт речь: скачанная или найденная.</summary>
    public AppVersion? TargetVersion => Staged?.ParsedVersion ?? Offer?.Version;

    /// <summary>Скачанное обновление готово: можно показывать кнопку «Обновить».</summary>
    public bool ReadyToInstall => Phase == UpdatePhase.Ready && Staged is not null;

    public DateTimeOffset? LastCheck => Device.LastUpdateCheck;

    /// <summary>Скачивание завершено и проверено: интерфейс сообщает об этом, но ничего не перезапускает.</summary>
    public event Action<StagedUpdate>? UpdateReady;

    private void OnUi(Action action) => _env.Ui.Post(action);

    /// <summary>Состояние меняется сразу (его читает фоновая логика), а оповещение интерфейса уходит в его поток.</summary>
    private void Assign<T>(ref T field, T value, [System.Runtime.CompilerServices.CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value))
        {
            return;
        }

        field = value;
        OnUi(() =>
        {
            Raise(name);
            if (name is nameof(Phase) or nameof(Staged) or nameof(Offer))
            {
                RaiseAll(nameof(IsBusy), nameof(ReadyToInstall), nameof(TargetVersion), nameof(NeedsManualDownload));
            }
        });
    }

    // MARK: Проверка

    /// <summary>Ищет новую версию. Ошибка сети не бросается, а записывается в <see cref="Error"/>. Ручная проверка сбрасывает паузу после неудач.</summary>
    public async Task<UpdateOffer?> CheckAsync(bool manual = true, CancellationToken ct = default)
    {
        if (!await _gate.WaitAsync(0, ct).ConfigureAwait(false))
        {
            return Offer;
        }

        try
        {
            if (!_env.IsOnline())
            {
                Fail("Нет подключения к интернету: обновления проверить не удалось.", manual);
                return null;
            }

            Error = null;
            Phase = UpdatePhase.Checking;
            UpdateOffer? offer;
            try
            {
                offer = await new UpdateChecker(_env.SearchTransport()).CheckAsync(Current, ct).ConfigureAwait(false);
            }
            catch (Exception e) when (e is HttpFailure or HttpRequestException or IOException || (e is OperationCanceledException && !ct.IsCancellationRequested))
            {
                _env.Log.Warn("Проверка обновлений не удалась: " + e.Message);
                Fail("Не удалось проверить обновления: " + e.Message, manual);
                return null;
            }

            Device.LastUpdateCheck = _env.Now();
            Offer = offer;
            if (offer is null)
            {
                // Скачанное раньше обновление могло устареть (ещё одна версия вышла, или релиз отозвали).
                if (Staged is not null)
                {
                    Stage.Clear();
                    Staged = null;
                }

                Phase = UpdatePhase.UpToDate;
            }
            else if (Staged is not null && Staged.ParsedVersion is { } sv && sv.Equals(offer.Version))
            {
                Phase = UpdatePhase.Ready;
            }
            else
            {
                if (Staged is not null)
                {
                    Stage.Clear(); // вышла версия новее скачанной
                    Staged = null;
                }

                Phase = UpdatePhase.Available;
            }

            return offer;
        }
        finally
        {
            _gate.Release();
        }
    }

    private void Fail(string text, bool manual)
    {
        if (!manual)
        {
            _nextAutomaticAttempt = _env.Now() + RetryAfterFailure;
        }

        _errorIsSpace = false;
        Error = text;
        // Уже скачанный и проверенный установщик остаётся доступным: установить его можно и без сети.
        Phase = Staged is not null ? UpdatePhase.Ready : UpdatePhase.Failed;
    }

    // MARK: Скачивание

    /// <summary>Скачивает и проверяет установщик найденной версии. Установленное приложение не затрагивается.</summary>
    public async Task<bool> DownloadAsync(bool manual = true, CancellationToken ct = default)
    {
        if (Offer is not { } offer)
        {
            return Staged is not null;
        }

        if (!await _gate.WaitAsync(0, ct).ConfigureAwait(false))
        {
            return false;
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        _download = cts;
        object? downloaderForDispose = null;
        try
        {
            if (!_env.IsOnline())
            {
                Fail("Нет подключения к интернету: обновление не скачано.", manual);
                return false;
            }

            Error = null;
            _errorIsSpace = false;
            Progress = null;
            Phase = UpdatePhase.Downloading;
            var progress = new Progress<DownloadProgress>(p =>
            {
                var now = DateTimeOffset.UtcNow;
                if (now - _lastProgressReport < TimeSpan.FromMilliseconds(250) && p.Fraction is not 1.0)
                {
                    return;
                }

                _lastProgressReport = now;
                Progress = p.Fraction;
            });
            var downloader = _env.Downloader();
            downloaderForDispose = downloader;
            try
            {
                var staged = await new UpdateChecker(_env.SearchTransport())
                    .StageAsync(offer, Stage, downloader, _env.FreeSpace, progress, cts.Token).ConfigureAwait(false);
                Staged = staged;
                Progress = 1;
                Phase = UpdatePhase.Ready;
                _env.Log.Info($"Обновление {staged.Version} скачано и проверено: {staged.InstallerPath}");
                OnUi(() => UpdateReady?.Invoke(staged));
                return true;
            }
            catch (OperationCanceledException)
            {
                Phase = UpdatePhase.Available;
                return false;
            }
            catch (InsufficientSpaceException e)
            {
                _env.Log.Warn(e.Message);
                _nextAutomaticAttempt = _env.Now() + RetryAfterFailure;
                _errorIsSpace = true;
                Error = e.Message;
                Phase = UpdatePhase.Failed;
                return false;
            }
            catch (Exception e) when (e is HttpFailure or HttpRequestException or IOException or UnauthorizedAccessException)
            {
                _env.Log.Warn("Обновление не скачано: " + e.Message);
                Fail("Обновление не скачано: " + e.Message + " Приложение работает как прежде, попробуйте позже.", manual);
                return false;
            }
        }
        finally
        {
            _download = null;
            (downloaderForDispose as IDisposable)?.Dispose();
            _gate.Release();
        }
    }

    /// <summary>Прерывает идущее скачивание (докачка продолжится с того же места).</summary>
    public void CancelDownload() => _download?.Cancel();

    // MARK: Установка

    /// <summary>
    /// Запускает скачанный установщик. Вызывается только по действию пользователя. Возвращает true, если установщик запущен
    /// и приложению нужно закрыться; false — установка не началась, причина в <see cref="Error"/>.
    /// </summary>
    public async Task<bool> InstallAsync(CancellationToken ct = default)
    {
        if (Staged is not { } staged || IsBusy)
        {
            return false;
        }

        Phase = UpdatePhase.Installing;
        if (!await Task.Run(() => UpdateStage.VerifyFile(staged), ct).ConfigureAwait(false))
        {
            _env.Log.Warn("Скачанный установщик не прошёл повторную проверку, удаляю.");
            Stage.Clear();
            Staged = null;
            Error = "Скачанный файл повреждён или изменён. Нажмите «Проверить обновления», чтобы скачать его заново.";
            Phase = UpdatePhase.Failed;
            return false;
        }

        Stage.SaveInstalledNotes(staged);
        bool started;
        try
        {
            started = _env.LaunchInstaller(staged.InstallerPath);
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or IOException or InvalidOperationException)
        {
            _env.Log.Error("Установщик не запущен", e);
            started = false;
        }

        if (!started)
        {
            Stage.ClearInstalledNotes();
            Error = "Не удалось запустить установщик. Приложение осталось прежним; попробуйте ещё раз.";
            Phase = UpdatePhase.Ready;
            return false;
        }

        _env.Log.Info("Запущена установка версии " + staged.Version);
        return true;
    }

    /// <summary>Пользователь отказался от готового обновления: файл удаляется, версия остаётся в списке доступных.</summary>
    public void Discard()
    {
        Stage.Clear();
        Staged = null;
        Phase = Offer is null ? UpdatePhase.Idle : UpdatePhase.Available;
    }

    // MARK: По расписанию

    /// <summary>Пора ли проверять обновления сама (по настройке частоты, <see cref="UpdateSchedule"/>). «При каждом запуске» — один раз за запуск, а не на каждом тике таймера.</summary>
    public bool IsCheckDue()
    {
        var now = _env.Now();
        if (!Device.CheckUpdates || now < _nextAutomaticAttempt)
        {
            return false;
        }

        var hours = Device.UpdateCheckHours;
        if (hours <= 0)
        {
            return Device.LastUpdateCheck is not { } at || at < _startedAt;
        }

        return UpdateSchedule.IsDue(true, hours, Device.LastUpdateCheck, now);
    }

    /// <summary>
    /// Один шаг фонового обновления: если подошёл срок — проверка, а затем (по настройке) скачивание. Вызывается таймером приложения.
    /// Скачивание откладывается на платном подключении и при отсутствии сети; установка никогда не запускается сама.
    /// </summary>
    public async Task RunScheduledAsync(CancellationToken ct = default)
    {
        if (IsBusy || !Device.CheckUpdates)
        {
            return;
        }

        if (IsCheckDue())
        {
            await CheckAsync(false, ct).ConfigureAwait(false);
        }

        var wantDownload = Device.BackgroundDownload && Phase is UpdatePhase.Available or UpdatePhase.Failed && Offer is not null && Staged is null
            && _env.Now() >= _nextAutomaticAttempt && _env.IsOnline() && !_env.IsMetered();
        if (wantDownload)
        {
            await DownloadAsync(false, ct).ConfigureAwait(false);
        }
    }

    /// <summary>Нужно ли предложить скачивание вручную: найдено, но фоновая загрузка выключена.</summary>
    public bool NeedsManualDownload => Phase == UpdatePhase.Available && Offer is not null && !Device.BackgroundDownload;
}
