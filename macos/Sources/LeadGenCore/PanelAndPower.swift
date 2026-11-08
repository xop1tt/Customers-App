import Foundation

/// Раскрытие свёрнутой боковой панели при наведении на левый край окна. Чистая логика без интерфейса:
/// время передаётся снаружи, поэтому поведение проверяется тестами.
///
/// - Курсор у левого края дольше `showDelay` — панель раскрывается (без случайных срабатываний при пролёте мимо).
/// - Пока курсор над краем или над самой панелью, а также пока открыто меню из панели, она остаётся.
/// - Курсор ушёл — панель сворачивается через `hideDelay`; возврат раньше этого срока отменяет сворачивание,
///   поэтому при переходе между краем, панелью и её вложенными элементами нет мерцания.
public struct HoverReveal: Equatable, Sendable {
    public static let showDelay: TimeInterval = 0.12
    public static let hideDelay: TimeInterval = 0.45

    public private(set) var revealed = false
    private var overEdge = false
    private var overPanel = false
    private var busy = false
    private var overSince: TimeInterval?
    private var outSince: TimeInterval?

    public init() {}

    private var isOver: Bool { overEdge || overPanel }

    public mutating func setEdge(_ inside: Bool, now: TimeInterval) { overEdge = inside; refresh(now) }
    public mutating func setPanel(_ inside: Bool, now: TimeInterval) { overPanel = inside; refresh(now) }
    /// Открыто меню, всплывающее окно или идёт перетаскивание: панель не сворачивается.
    public mutating func setBusy(_ value: Bool, now: TimeInterval) { busy = value; refresh(now) }

    /// Немедленно свернуть (панель закреплена кнопкой, окно потеряло фокус).
    public mutating func reset() {
        revealed = false; overEdge = false; overPanel = false; overSince = nil; outSince = nil
    }

    private mutating func refresh(_ now: TimeInterval) {
        if revealed {
            if isOver || busy { outSince = nil } else if outSince == nil { outSince = now }
        } else if isOver {
            if overSince == nil { overSince = now }
        } else {
            overSince = nil
        }
    }

    /// Применяет истёкшие задержки. Возвращает true, если видимость изменилась.
    @discardableResult
    public mutating func tick(now: TimeInterval) -> Bool {
        if !revealed, let since = overSince, isOver, now - since >= Self.showDelay {
            revealed = true; overSince = nil; outSince = nil
            return true
        }
        if revealed, !isOver, !busy, let since = outSince, now - since >= Self.hideDelay {
            revealed = false; outSince = nil
            return true
        }
        return false
    }

    /// Через сколько секунд нужно вызвать `tick`, nil — ждать нечего.
    public func nextDelay(now: TimeInterval) -> TimeInterval? {
        if !revealed, let since = overSince, isOver { return max(0.01, Self.showDelay - (now - since)) }
        if revealed, !isOver, !busy, let since = outSince { return max(0.01, Self.hideDelay - (now - since)) }
        return nil
    }
}

/// Состояние питания устройства.
public struct PowerState: Equatable, Sendable {
    /// Включён системный режим энергосбережения.
    public var systemSaver: Bool
    /// Заряд батареи в процентах; nil, если батареи нет или система не сообщает.
    public var batteryPercent: Int?
    /// Подключено ли зарядное устройство; nil — неизвестно.
    public var charging: Bool?

    public init(systemSaver: Bool = false, batteryPercent: Int? = nil, charging: Bool? = nil) {
        self.systemSaver = systemSaver
        self.batteryPercent = batteryPercent
        self.charging = charging
    }
}

/// Почему включён облегчённый режим (объясняется пользователю).
public enum LightModeReason: Equatable, Sendable {
    case systemSaver
    case lowBattery(percent: Int, threshold: Int)

    public var explanation: String {
        switch self {
        case .systemSaver: return "Включён режим энергосбережения системы: тяжёлые анимации и эффекты отключены."
        case .lowBattery(let p, let t): return "Заряд батареи \(p)% ниже порога \(t)%: тяжёлые анимации и эффекты отключены."
        }
    }

    public var shortTitle: String {
        switch self {
        case .systemSaver: return "Энергосбережение системы"
        case .lowBattery(let p, _): return "Низкий заряд, \(p)%"
        }
    }
}

/// Решение об облегчённом режиме: по режиму энергосбережения системы и по заряду батареи.
public enum PowerPolicy {
    public static let defaultThreshold = 20
    public static let thresholdRange = 5...50

    public static func clamp(_ threshold: Int) -> Int {
        min(max(threshold, thresholdRange.lowerBound), thresholdRange.upperBound)
    }

    /// Причина включения облегчённого режима или nil, если нужен обычный.
    /// Батарея учитывается, только пока устройство не заряжается. Если заряд неизвестен (стационарный компьютер,
    /// нет доступа к сведениям), работает один лишь режим энергосбережения системы.
    public static func evaluate(_ state: PowerState, automatic: Bool, threshold: Int) -> LightModeReason? {
        guard automatic else { return nil }
        if state.systemSaver { return .systemSaver }
        let limit = clamp(threshold)
        if let p = state.batteryPercent, state.charging != true, p < limit { return .lowBattery(percent: p, threshold: limit) }
        return nil
    }
}

/// Какие параметры боковой панели включены. Хранятся в настройках приложения.
public struct SidebarPrefs: Equatable, Sendable {
    public var hiddenSections: Set<String>
    public var showCounts: Bool
    public var showSourceList: Bool
    public var revealOnHover: Bool

    public init(hiddenSections: Set<String> = [], showCounts: Bool = true, showSourceList: Bool = true, revealOnHover: Bool = true) {
        self.hiddenSections = hiddenSections
        self.showCounts = showCounts
        self.showSourceList = showSourceList
        self.revealOnHover = revealOnHover
    }

    /// Список скрытых разделов хранится строкой «a,b,c».
    public static func parse(hidden raw: String) -> Set<String> {
        Set(raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
    }

    public static func serialize(hidden: Set<String>) -> String { hidden.sorted().joined(separator: ",") }
}
