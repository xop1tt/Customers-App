import AppKit
import LeadGenCore
import Network
import Observation

/// Автообновление из GitHub Releases: проверка, скачивание, проверка SHA-256, замена и перезапуск.
///
/// Без серверов и ключей: публичный API релизов и файлы, которые публикует release.yml.
/// Окна — NSAlert, чтобы не связывать обновление с графом SwiftUI.
@MainActor
@Observable
final class UpdateController {
    static let shared = UpdateController()

    enum Phase: Equatable {
        case idle
        case checking
        case upToDate
        case available(String)
        case downloading
        /// Обновление скачано, проверено и ждёт установки (версия). Сюда же приходит фоновое скачивание.
        case ready(String)
        case installing
        case failed(String)
    }

    var phase: Phase = .idle

    /// Версия скачанного и готового к установке обновления; от этого зависит кнопка «Обновить» в боковой панели.
    var readyVersion: String? {
        if case .ready(let v) = phase { return v }
        return nil
    }
    private(set) var lastCheck: Date?
    /// Три последних релиза для раздела «Что нового?» (nil — ещё не загружались).
    private(set) var recentReleases: [ReleaseInfo]?
    private(set) var recentFailed = false
    @ObservationIgnored private var recentLoadedAt: Date?
    @ObservationIgnored private var recentLoading = false

    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var pending: AvailableUpdate?
    /// Распакованное и проверенное приложение новой версии.
    @ObservationIgnored private var staged: URL?
    /// Последняя автоматическая попытка, в том числе неудачная (нет сети, GitHub недоступен).
    @ObservationIgnored private var lastAttempt: Date?

    static let autoKey = "updates.auto"
    static let intervalKey = "updates.intervalHours"
    /// Варианты частоты автоматической проверки, в часах.
    struct Interval: Hashable {
        let hours: Int
        let title: String
    }
    static let intervals: [Interval] = [
        Interval(hours: 1, title: "Каждый час"), Interval(hours: 3, title: "Каждые 3 часа"),
        Interval(hours: 6, title: "Каждые 6 часов"), Interval(hours: 12, title: "Каждые 12 часов"),
        Interval(hours: 24, title: "Раз в сутки"), Interval(hours: 168, title: "Раз в неделю"),
    ]
    private static let skipKey = "updates.skip"
    private static let lastKey = "updates.lastCheck"

    static let backgroundKey = "updates.background"
    private static let stagedKey = "updates.staged"
    static let installedNotesKey = "updates.installedNotes"

    /// Скачивать найденное обновление в фоне. Установка всё равно только по нажатию «Обновить».
    var backgroundDownload: Bool {
        get { access(keyPath: \.backgroundDownload); return defaults.object(forKey: Self.backgroundKey) as? Bool ?? true }
        set { withMutation(keyPath: \.backgroundDownload) { defaults.set(newValue, forKey: Self.backgroundKey) } }
    }

    /// Скачанное и проверенное обновление, запомненное между запусками.
    private struct StagedRecord: Codable {
        var version: String
        var path: String
        var title: String
        var notes: String
    }

    /// Подключение с лимитом трафика (точка доступа телефона, «экономия данных»): большие загрузки в фоне откладываются.
    @ObservationIgnored private let pathMonitor = NWPathMonitor()
    @ObservationIgnored private var expensiveNetwork = false

    /// Папка со скачанными обновлениями. Не временная: система может очищать /tmp, а скачанное нужно хранить до установки.
    nonisolated static var stageRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Lead Generator", isDirectory: true).appendingPathComponent("updates", isDirectory: true)
    }

    var automatic: Bool {
        get { access(keyPath: \.automatic); return defaults.object(forKey: Self.autoKey) as? Bool ?? true }
        set { withMutation(keyPath: \.automatic) { defaults.set(newValue, forKey: Self.autoKey) } }
    }

    /// Как часто проверять обновления, в часах (по умолчанию раз в сутки).
    var intervalHours: Int {
        get {
            access(keyPath: \.intervalHours)
            let h = defaults.integer(forKey: Self.intervalKey)
            return Self.intervals.contains { $0.hours == h } ? h : 24
        }
        set { withMutation(keyPath: \.intervalHours) { defaults.set(newValue, forKey: Self.intervalKey) } }
    }

    /// Версия этой сборки. Нет у запуска без .app (swift run): тогда обновление выключено.
    let current: AppVersion? = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String).flatMap(AppVersion.init)

    var canUpdate: Bool { current != nil && Bundle.main.bundleURL.pathExtension == "app" }

    private init() {
        lastCheck = defaults.object(forKey: Self.lastKey) as? Date
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let expensive = path.isExpensive || path.isConstrained
            Task { @MainActor in self?.expensiveNetwork = expensive }
        }
        pathMonitor.start(queue: DispatchQueue(label: "updates.path"))
        restoreStaged()
    }

    /// После перезапуска скачанное раньше обновление снова «готово к установке», если оно цело и всё ещё новее.
    private func restoreStaged() {
        guard let data = defaults.data(forKey: Self.stagedKey), let rec = try? JSONDecoder().decode(StagedRecord.self, from: data),
              let v = AppVersion(rec.version), let current, current < v,
              FileManager.default.fileExists(atPath: rec.path),
              (NSDictionary(contentsOf: URL(fileURLWithPath: rec.path).appendingPathComponent("Contents/Info.plist")) as? [String: Any])?["CFBundleShortVersionString"] as? String == rec.version
        else {
            clearStaged()
            return
        }
        staged = URL(fileURLWithPath: rec.path)
        phase = .ready(rec.version)
    }

    private func clearStaged() {
        defaults.removeObject(forKey: Self.stagedKey)
        staged = nil
        try? FileManager.default.removeItem(at: Self.stageRoot)
    }

    // MARK: Что нового

    /// Загружает список последних релизов, не чаще раза в 6 часов (после ошибки — раз в 10 минут).
    func refreshRecentReleases(force: Bool = false) {
        guard !recentLoading else { return }
        if !force, let at = recentLoadedAt, Date().timeIntervalSince(at) < (recentFailed ? 600 : 6 * 3600) { return }
        recentLoading = true
        Task {
            defer { recentLoading = false; recentLoadedAt = Date() }
            do {
                recentReleases = try await Updates.fetchRecent(userAgent: "LeadGenerator/\(current?.description ?? "dev") (macOS)")
                recentFailed = false
            } catch {
                recentFailed = true
            }
        }
    }

    // MARK: Проверка

    /// Через полминуты после запуска и затем каждые 10 минут смотрим, не пора ли проверить.
    /// Сама проверка идёт с выбранной частотой (публичный API GitHub разрешает 60 запросов в час).
    func startAutomaticChecks() {
        guard canUpdate else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in self?.automaticCheck() }
        timer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.automaticCheck() }
        }
    }

    private func automaticCheck() {
        guard automatic else { return }
        // Небольшой запас, чтобы проверка «раз в час» не сдвигалась на следующий тик таймера.
        if let lastCheck, Date().timeIntervalSince(lastCheck) < Double(intervalHours) * 3600 - 300 { return }
        // После неудачи (lastCheck не обновился) повторяем не чаще раза в час, а не на каждом тике.
        if let lastAttempt, Date().timeIntervalSince(lastAttempt) < 3600 - 300 { return }
        lastAttempt = Date()
        check(manual: false)
    }

    /// Ручная проверка показывает результат всегда, автоматическая — только если есть новая версия.
    func check(manual: Bool) {
        guard let current, canUpdate else {
            if manual { alert("Обновление недоступно", "Приложение запущено не из «Customers.app», обновлять нечего.") }
            return
        }
        switch phase {
        case .checking, .downloading, .installing: return
        case .ready:
            // Обновление уже скачано: ручная проверка предлагает его установить, а не качает заново.
            if manual, let pending { offer(pending) }
            return
        default: break
        }
        phase = .checking
        Task {
            do {
                let release = try await Updates.fetchLatest(userAgent: "LeadGenerator/\(current) (macOS)")
                lastCheck = Date()
                defaults.set(lastCheck, forKey: Self.lastKey)
                guard let update = Updates.update(from: release, current: current) else {
                    phase = .upToDate
                    if manual { alert("Установлена последняя версия", "Customers \(current) — самая новая версия.") }
                    return
                }
                phase = .available(update.version.description)
                if !manual, defaults.string(forKey: Self.skipKey) == update.version.description { return }
                if !manual, backgroundDownload {
                    // Тихая загрузка: окно не появляется, пока пользователь работает. Установка — только по кнопке «Обновить».
                    guard !expensiveNetwork else { return }
                    if await prepare(update) { announceReady(update.version.description) }
                    return
                }
                offer(update)
            } catch {
                phase = .failed(error.localizedDescription)
                if manual { alert("Не удалось проверить обновления", error.localizedDescription) }
            }
        }
    }

    private func offer(_ update: AvailableUpdate) {
        let a = NSAlert()
        a.messageText = "Доступна версия \(update.version)"
        let notes = Updates.plainNotes(update.notes, limit: 900)
        a.informativeText = "Установлена версия \(current?.description ?? "?")." + (notes.isEmpty ? "" : "\n\n\(notes)")
        a.addButton(withTitle: "Установить и перезапустить")
        a.addButton(withTitle: "Позже")
        a.addButton(withTitle: "Пропустить эту версию")
        NSApp.activate(ignoringOtherApps: true)
        switch a.runModal() {
        case .alertFirstButtonReturn: install(update)
        case .alertThirdButtonReturn: defaults.set(update.version.description, forKey: Self.skipKey)
        default: break
        }
    }

    // MARK: Установка

    /// Скачивает и проверяет обновление, не трогая запущенное приложение: после этого оно «готово к установке».
    /// Годится и для фонового скачивания. Возвращает false при ошибке (фаза `.failed`).
    @discardableResult
    func prepare(_ update: AvailableUpdate) async -> Bool {
        if readyVersion == update.version.description, let staged, FileManager.default.fileExists(atPath: staged.path) { return true }
        pending = update
        phase = .downloading
        do {
            let app = try await download(update)
            staged = app
            let record = StagedRecord(version: update.version.description, path: app.path, title: update.title, notes: update.notes)
            if let data = try? JSONEncoder().encode(record) { defaults.set(data, forKey: Self.stagedKey) }
            phase = .ready(update.version.description)
            return true
        } catch {
            // Незавершённая загрузка не оставляет мусора, установленное приложение не затронуто.
            staged = nil
            try? FileManager.default.removeItem(at: Self.stageRoot)
            phase = .failed(Self.friendly(error))
            return false
        }
    }

    /// Понятное сообщение вместо технической ошибки сети.
    nonisolated static func friendly(_ error: Error) -> String {
        guard let url = error as? URLError else { return error.localizedDescription }
        switch url.code {
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff: return "Нет подключения к интернету. Приложение работает как прежде, попробуйте позже."
        case .networkConnectionLost, .timedOut, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed: return "Соединение прервалось, обновление не скачано. Приложение работает как прежде, попробуйте позже."
        default: return error.localizedDescription
        }
    }

    private func announceReady(_ version: String) {
        SessionModel.shared.current?.lastMessage = "Версия \(version) скачана. Нажмите «Обновить» в боковой панели, чтобы установить."
    }

    /// Устанавливает уже скачанное обновление и перезапускает приложение (кнопка «Обновить»).
    func installReady() {
        guard let staged, let version = readyVersion else { return }
        guard FileManager.default.fileExists(atPath: staged.path) else {
            // Файлы пропали (очистка диска): скачиваем заново.
            clearStaged()
            phase = .idle
            if let pending { install(pending) } else { check(manual: true) }
            return
        }
        // Описание версии запоминаем до установки: после перезапуска «Что нового» покажется без сети.
        if let data = defaults.data(forKey: Self.stagedKey), let rec = try? JSONDecoder().decode(StagedRecord.self, from: data) {
            defaults.set(InstalledNotes(version: rec.version, title: rec.title, notes: rec.notes).encoded(), forKey: Self.installedNotesKey)
        }
        phase = .installing
        do {
            try relaunch(replacingWith: staged)
        } catch {
            phase = .ready(version)
            defaults.removeObject(forKey: Self.installedNotesKey)
            if let pending { installFailed(error.localizedDescription, pending) } else { alert("Обновление не установлено", error.localizedDescription) }
        }
    }

    func install(_ update: AvailableUpdate) {
        Task {
            if await prepare(update) {
                installReady()
            } else if case .failed(let why) = phase {
                installFailed(why, update)
            }
        }
    }

    private func installFailed(_ reason: String, _ update: AvailableUpdate) {
        let a = NSAlert()
        a.messageText = "Обновление не установлено"
        a.informativeText = "\(reason)\n\nМожно скачать установщик со страницы релиза и установить вручную."
        a.addButton(withTitle: "Открыть страницу релиза")
        a.addButton(withTitle: "Закрыть")
        NSApp.activate(ignoringOtherApps: true)
        if a.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(update.page ?? Updates.releasesPage) }
    }

    /// Скачивает установщик, сверяет SHA-256, достаёт приложение из образа и проверяет его.
    /// Не на главном потоке: подсчёт суммы и hdiutil занимают несколько секунд.
    nonisolated private func download(_ update: AvailableUpdate) async throws -> URL {
        // Места должно хватить на образ, его копию при распаковке и сам пакет приложения.
        let probe = (try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?
            .volumeAvailableCapacityForImportantUsage ?? Int64.max
        guard UpdateSpace.isEnough(available: probe, dmgSize: update.dmg.size) else {
            throw UpdateError.notEnoughSpace(UpdateSpace.message(available: probe, dmgSize: update.dmg.size))
        }
        let work = Self.stageRoot.appendingPathComponent(update.version.description, isDirectory: true)
        try? FileManager.default.removeItem(at: Self.stageRoot) // старые и недокачанные версии не копятся
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)

        // Ожидаемая сумма: digest от GitHub, иначе файл .sha256 из релиза. Без суммы не ставим.
        var expected = update.expectedDigest
        if expected == nil, let sumAsset = update.checksumFile {
            let (data, _) = try await URLSession.shared.data(from: sumAsset.browserDownloadURL)
            expected = Updates.parseChecksumFile(String(decoding: data, as: UTF8.self))
        }
        guard let expected else { throw UpdateError.noChecksum }

        var downloaded: (URL, URLResponse)?
        for attempt in 1...3 {
            do {
                downloaded = try await URLSession.shared.download(from: update.dmg.browserDownloadURL)
                break
            } catch let e as URLError where attempt < 3 && [.networkConnectionLost, .timedOut, .cannotConnectToHost, .notConnectedToInternet].contains(e.code) {
                try await Task.sleep(nanoseconds: UInt64(attempt) * 4_000_000_000) // обрыв связи: пробуем снова
            }
        }
        guard let (tmp, resp) = downloaded else { throw UpdateError.network("Соединение прервалось, обновление не скачано.") }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw UpdateError.badResponse(code) }
        let dmg = work.appendingPathComponent(update.dmg.name)
        try FileManager.default.moveItem(at: tmp, to: dmg)
        guard try Updates.sha256(of: dmg) == expected else { throw UpdateError.checksumMismatch }

        let mount = work.appendingPathComponent("mnt", isDirectory: true)
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        try Self.run("/usr/bin/hdiutil", ["attach", dmg.path, "-nobrowse", "-noautoopen", "-readonly", "-mountpoint", mount.path])
        defer { _ = try? Self.run("/usr/bin/hdiutil", ["detach", mount.path, "-force"]) }

        guard let appName = try FileManager.default.contentsOfDirectory(atPath: mount.path).first(where: { $0.hasSuffix(".app") })
        else { throw UpdateError.wrongApp("приложение не найдено в образе") }
        let staged = work.appendingPathComponent("Customers.app")
        try Self.run("/usr/bin/ditto", [mount.appendingPathComponent(appName).path, staged.path])

        let info = NSDictionary(contentsOf: staged.appendingPathComponent("Contents/Info.plist")) as? [String: Any] ?? [:]
        guard info["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier else {
            throw UpdateError.wrongApp("другой идентификатор приложения")
        }
        guard (info["CFBundleShortVersionString"] as? String).flatMap(AppVersion.init) == update.version else {
            throw UpdateError.wrongApp("версия внутри не совпадает с версией релиза")
        }
        return staged
    }

    /// Заменяет приложение после выхода и запускает новую версию.
    private func relaunch(replacingWith staged: URL) throws {
        let target = Bundle.main.bundleURL
        let parent = target.deletingLastPathComponent()
        // Приложение раньше называлось «Lead Generator.app»: после обновления оно ставится как «Customers.app»,
        // а старый пакет удаляется.
        let renamed = parent.appendingPathComponent("Customers.app")
        guard FileManager.default.isWritableFile(atPath: parent.path) else {
            // Нет прав на папку с приложением: открываем образ, пользователь перетащит сам.
            NSWorkspace.shared.open(staged.deletingLastPathComponent().appendingPathComponent(pending?.dmg.name ?? ""))
            throw UpdateError.cannotInstall("нет прав на запись в \(parent.path). Установщик открыт: перетащите приложение в «Программы» вручную")
        }
        // Скрипт ждёт выхода приложения, меняет пакет целиком и запускает новую версию.
        // При ошибке возвращает прежнюю версию.
        let script = """
        #!/bin/sh
        PID="$1"; NEW="$2"; OLD="$3"; TARGET="$4"
        while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
        rm -rf "$TARGET.update" "$TARGET.previous"
        /usr/bin/ditto "$NEW" "$TARGET.update" || exit 1
        mv "$OLD" "$OLD.previous" || exit 1
        if [ -e "$TARGET" ]; then mv "$TARGET" "$TARGET.replaced"; fi
        if mv "$TARGET.update" "$TARGET"; then
          rm -rf "$OLD.previous" "$TARGET.replaced"
        else
          rm -rf "$TARGET"
          mv "$OLD.previous" "$OLD"
          if [ -e "$TARGET.replaced" ]; then mv "$TARGET.replaced" "$TARGET"; fi
          TARGET="$OLD"
        fi
        /usr/bin/xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
        /usr/bin/open "$TARGET"
        """
        let scriptURL = staged.deletingLastPathComponent().appendingPathComponent("install.sh")
        try script.write(to: scriptURL, atomically: true, encoding: .utf8)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = [scriptURL.path, String(ProcessInfo.processInfo.processIdentifier), staged.path, target.path, renamed.path]
        try p.run()
        SessionModel.shared.current?.shutdown()
        NSApp.terminate(nil)
    }

    @discardableResult
    nonisolated private static func run(_ tool: String, _ args: [String]) throws -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            throw UpdateError.cannotInstall("\(URL(fileURLWithPath: tool).lastPathComponent) завершился с кодом \(p.terminationStatus)")
        }
        return p.terminationStatus
    }

    private func alert(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }
}
