import Foundation

/// Что делать с экраном «Что нового» при запуске.
public enum WhatsNewDecision: Equatable, Sendable {
    /// Для этой версии экран уже показан.
    case none
    /// Приложение обновилось: показать.
    case show
    /// Не показывать, только запомнить версию: первая установка (её встречает мастер) или возврат на старую версию.
    case recordOnly
}

public enum WhatsNewPolicy {
    /// - Parameters:
    ///   - lastSeen: версия, для которой экран уже показывали (из настроек).
    ///   - hasExistingData: на этом Mac уже были учётные записи, то есть это не первая установка.
    public static func decide(lastSeen: String?, current: AppVersion, hasExistingData: Bool) -> WhatsNewDecision {
        guard let lastSeen, let seen = AppVersion(lastSeen) else { return hasExistingData ? .show : .recordOnly }
        if seen < current { return .show }
        return seen > current ? .recordOnly : .none
    }
}

/// Описание только что установленной версии. Записывается перед установкой, чтобы после перезапуска
/// «Что нового» показалось без сети.
public struct InstalledNotes: Codable, Equatable, Sendable {
    public var version: String
    public var title: String
    public var notes: String

    public init(version: String, title: String, notes: String) {
        self.version = version
        self.title = title
        self.notes = notes
    }

    public func encoded() -> String { (try? JSONEncoder().encode(self)).map { String(decoding: $0, as: UTF8.self) } ?? "" }

    /// Запись нужной версии или nil (другая версия, пустая или испорченная запись).
    public static func decode(_ text: String?, for version: AppVersion) -> InstalledNotes? {
        guard let text, let data = text.data(using: .utf8),
              let n = try? JSONDecoder().decode(InstalledNotes.self, from: data),
              AppVersion(n.version) == version else { return nil }
        return n
    }
}

/// Сколько места нужно на диске для загрузки обновления: образ + смонтированная копия + распакованное приложение.
public enum UpdateSpace {
    public static let margin: Int64 = 200 * 1024 * 1024
    public static let assumedSize: Int64 = 150 * 1024 * 1024

    public static func required(dmgSize: Int?) -> Int64 {
        Int64(dmgSize ?? Int(assumedSize)) * 3 + margin
    }

    public static func isEnough(available: Int64, dmgSize: Int?) -> Bool { available >= required(dmgSize: dmgSize) }

    public static func message(available: Int64, dmgSize: Int?) -> String {
        func mb(_ v: Int64) -> Int64 { (v + 1_048_575) / 1_048_576 }
        return "Недостаточно места на диске: для обновления нужно около \(mb(required(dmgSize: dmgSize))) МБ, свободно \(mb(max(available, 0))) МБ. Освободите место и повторите."
    }
}

/// Варианты частоты проверки обновлений в часах — единый список для настроек.
public enum UpdateIntervals {
    public static let `default` = 24
    public static let hours = [1, 3, 6, 12, 24, 168]
    public static func normalize(_ h: Int) -> Int { hours.contains(h) ? h : `default` }
}

public enum WelcomeStep: Int, CaseIterable, Identifiable, Sendable {
    case intro, sources, integrations, drives, appearance
    public var id: Int { rawValue }
    public var title: String {
        switch self {
        case .intro: return "Добро пожаловать"
        case .sources: return "Источники лидов"
        case .integrations: return "Интеграции"
        case .drives: return "Облачные диски"
        case .appearance: return "Оформление"
        }
    }
    /// Первый шаг только знакомит с приложением, остальные можно пропустить.
    public var isOptional: Bool { self != .intro }
}

public enum WelcomeStepState: Equatable, Sendable { case pending, configured, skipped }

/// Положение в мастере первого запуска: вперёд, назад, пропуск, прогресс. Сами настройки применяются сразу в интерфейсе.
public struct WelcomeFlow: Equatable, Sendable {
    public private(set) var index = 0
    public private(set) var skipped: Set<WelcomeStep> = []
    public private(set) var finished = false

    public init() {}

    public var step: WelcomeStep { WelcomeStep.allCases[index] }
    public var count: Int { WelcomeStep.allCases.count }
    public var position: String { "Шаг \(index + 1) из \(count)" }
    public var progress: Double { Double(index + 1) / Double(count) }
    public var canGoBack: Bool { index > 0 && !finished }
    public var isLast: Bool { index == count - 1 }
    public var canSkip: Bool { step.isOptional && !isLast }

    public mutating func back() { if canGoBack { index -= 1 } }

    public mutating func next() {
        skipped.remove(step)
        advance()
    }

    public mutating func skip() {
        guard step.isOptional else { next(); return }
        skipped.insert(step)
        advance()
    }

    /// Закрыть мастер целиком (дошли до конца или «Пропустить всю настройку»).
    public mutating func finish() { finished = true }

    private mutating func advance() { if isLast { finished = true } else { index += 1 } }

    public func state(of step: WelcomeStep, configured: Bool) -> WelcomeStepState {
        configured ? .configured : (skipped.contains(step) ? .skipped : .pending)
    }
}

/// Название региона для поиска организаций по результату определения местоположения.
public enum RegionSuggestion {
    /// Город или населённый пункт; если его нет — район или область. Лишние слова вроде «городской округ» убираются.
    /// nil — местоположение не определилось, регион выбирает пользователь.
    public static func name(locality: String?, subAdministrativeArea: String? = nil, administrativeArea: String? = nil) -> String? {
        for raw in [locality, subAdministrativeArea, administrativeArea] {
            guard var s = raw?.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\"", with: ""), !s.isEmpty else { continue }
            for prefix in ["городской округ ", "город ", "г. ", "муниципальный округ "] where s.lowercased().hasPrefix(prefix) {
                s = String(s.dropFirst(prefix.count))
            }
            for suffix in [" городской округ", " (город)"] where s.lowercased().hasSuffix(suffix) {
                s = String(s.dropLast(suffix.count))
            }
            s = s.trimmingCharacters(in: .whitespaces)
            if !s.isEmpty { return s }
        }
        return nil
    }

    /// Добавляет предложенный регион, если пользователь ещё ничего не выбрал: уже заданное не трогаем.
    public static func applying(_ suggestion: String?, to regions: [String]) -> [String] {
        guard regions.isEmpty, let suggestion, !suggestion.isEmpty else { return regions }
        return [suggestion]
    }
}
