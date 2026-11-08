import Foundation

/// Платформа, для которой показывается «Что нового?».
public enum ReleasePlatform: String, Sendable {
    case macOS, windows
}

/// Тема группы изменений в окне «Что нового?».
public enum WhatsNewTopic: String, CaseIterable, Sendable {
    case interface, search, data, updates, power, other

    public var title: String {
        switch self {
        case .interface: return "Улучшили и доработали интерфейс"
        case .search: return "Стало удобнее искать лиды"
        case .data: return "Данные, облако и интеграции"
        case .updates: return "Запуск и обновления"
        case .power: return "Экономия энергии"
        case .other: return "Другие улучшения"
        }
    }
}

/// Что показывает анимированное превью рядом с группой изменений.
public enum WhatsNewPreview: String, Sendable {
    case sidebar, settings, adaptive, exclusions, categories, power, update, cloud
}

public struct WhatsNewFeature: Equatable, Identifiable, Sendable {
    public var topic: WhatsNewTopic
    public var items: [String]
    public var preview: WhatsNewPreview?
    public var id: String { topic.rawValue }
    public var title: String { topic.title }
}

/// Превращает описание релиза (то, что разработчик пишет для себя) в короткий список полезных пользователю изменений
/// для одной платформы: без README, вики, рефакторинга, CI, ссылок на GitHub и изменений другой платформы,
/// со сгруппированными и переформулированными пунктами.
public enum WhatsNewDigest {
    /// Максимум пунктов в группе и длина пункта.
    public static let maxItemsPerTopic = 4
    public static let maxItemLength = 110

    public static func build(_ markdown: String, platform: ReleasePlatform) -> [WhatsNewFeature] {
        var byTopic: [WhatsNewTopic: [String]] = [:]
        var seen = Set<String>()
        var sectionOK = true
        var sectionPlatform: ReleasePlatform?
        var sectionTitleLow = ""

        let text = markdown.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        for raw in text.components(separatedBy: "\n") {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            if trimmed.hasPrefix("#") {
                let head = clean(trimmed.drop { $0 == "#" || $0 == " " }.description).lowercased()
                sectionTitleLow = head
                sectionOK = !isServiceSection(head)
                sectionPlatform = only(head)
                continue
            }
            guard sectionOK, let item = bullet(trimmed) else { continue }
            let low = (sectionTitleLow + " " + item.full).lowercased().replacingOccurrences(of: "ё", with: "е")
            // Чужая платформа: либо заголовок раздела, либо сам пункт говорят только о ней.
            if let p = only(item.full.lowercased()) ?? sectionPlatform, p != platform { continue }
            if isTechnical(item.full.lowercased().replacingOccurrences(of: "ё", with: "е")) { continue }
            let short = shorten(item)
            guard !short.isEmpty, seen.insert(short.lowercased()).inserted else { continue }
            byTopic[topic(of: low), default: []].append(short)
        }

        return WhatsNewTopic.allCases.compactMap { topic in
            guard let items = byTopic[topic], !items.isEmpty else { return nil }
            let kept = Array(items.prefix(maxItemsPerTopic))
            return WhatsNewFeature(topic: topic, items: kept, preview: preview(for: topic, items: kept, platform: platform))
        }
    }

    // MARK: Разбор

    private struct Bullet { var lead: String?; var rest: String; var full: String }

    private static func bullet(_ line: String) -> Bullet? {
        guard let m = firstMatch(line, #"^(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$"#) else { return nil }
        let body = m[1]
        // «**Название.** Описание»: жирное начало с точкой или двоеточием — заголовок пункта.
        // Жирное слово посреди фразы («**Быстрее** запуск») — просто выделение, фраза остаётся целой.
        if let b = firstMatch(body, #"^\*\*(.+?)\*\*(\s*[:.—–-]+\s*)?(.*)$"#) {
            let titleStyle = !b[2].trimmingCharacters(in: .whitespaces).isEmpty || b[1].last.map { ".:—".contains($0) } == true
            if titleStyle {
                let lead = clean(b[1]).trimmingCharacters(in: CharacterSet(charactersIn: ".:— "))
                let rest = clean(b[3])
                return Bullet(lead: lead.isEmpty ? nil : lead, rest: rest, full: clean(body))
            }
        }
        let c = clean(body)
        return c.isEmpty ? nil : Bullet(lead: nil, rest: c, full: c)
    }

    /// Убирает разметку, ссылки, адреса и подписи «by @автор in …» из автоматических заметок GitHub.
    static func clean(_ s: String) -> String {
        var t = s
        t = replace(t, #"\s+by\s+@\S+\s+in\s+\S+"#, "")
        t = replace(t, #"\[([^\]]*)\]\([^)]*\)"#, "$1")
        t = replace(t, #"https?://\S+"#, "")
        t = replace(t, #"\(?#\d+\)?"#, "")
        t = t.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "")
            .replacingOccurrences(of: "`", with: "")
        t = replace(t, #"\s+"#, " ")
        return t.trimmingCharacters(in: .whitespaces)
    }

    /// Одна короткая фраза: начало описания до первой точки, при необходимости с заголовком пункта.
    private static func shorten(_ b: Bullet) -> String {
        var phrase: String
        if let lead = b.lead {
            // Короткий заголовок вроде «Название» без описания беден: добавляем первое предложение описания.
            let sentence = firstSentence(b.rest)
            phrase = sentence.isEmpty ? lead : (lead.count <= 14 ? sentence : lead)
        } else {
            phrase = firstSentence(b.rest)
        }
        phrase = phrase.trimmingCharacters(in: CharacterSet(charactersIn: " .;:"))
        guard phrase.count >= 4 else { return "" }
        if phrase.count > maxItemLength {
            let cut = phrase.prefix(maxItemLength)
            let atSpace = cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? String(cut)
            phrase = atSpace + "…"
        }
        return phrase.prefix(1).uppercased() + phrase.dropFirst()
    }

    private static func firstSentence(_ s: String) -> String {
        guard let r = s.range(of: #"[.!?](\s|$)"#, options: .regularExpression) else { return s }
        return String(s[..<r.lowerBound])
    }

    // MARK: Фильтры

    private static func isServiceSection(_ head: String) -> Bool {
        ["установк", "install", "контрольн", "checksum", "sha", "full changelog", "new contributors", "новые участники", "скачать", "файлы", "assets"]
            .contains { head.contains($0) }
    }

    /// Пункты для разработчиков: документация, CI, тесты, зависимости, внутренняя перестройка.
    private static let technicalMarkers = [
        "readme", "wiki", "вики", "рефактор", "refactor", "workflow", "github actions", "ci:", " ci ", "dependabot", "bump",
        "зависимост", "автотест", "тесты", "тестов", "тестир", "unit", "test", "lint", "codeql", "swiftpm", "dotnet", ".yml", "pull request", "коммит", "commit",
        "опечатк", "typo", "full changelog", "changelog", "sha-256", "sha256", "контрольн", "sqlite", "миграци базы", "ci/cd",
        "документаци", "покрыти", "сборк", "xcode", "winui", "inno setup",
    ]

    private static func isTechnical(_ low: String) -> Bool {
        technicalMarkers.contains { low.contains($0) }
    }

    /// Платформа, о которой говорит только этот текст; nil, если не названа или названы обе.
    static func only(_ low: String) -> ReleasePlatform? {
        let mac = ["macos", "mac os", " mac ", "dock", "связк", "liquid glass", "строк меню", "строке меню", "dmg"].contains { (" " + low + " ").contains($0) }
        let win = ["windows", "винд", "winui", "трей", "проводник"].contains { low.contains($0) }
        if mac && !win { return .macOS }
        if win && !mac { return .windows }
        return nil
    }

    // MARK: Темы

    private static func topic(of low: String) -> WhatsNewTopic {
        func has(_ words: [String]) -> Bool { words.contains { low.contains($0) } }
        if has(["энергосбереж", "заряд", "батаре", "облегчен"]) { return .power }
        if has(["что нового", "мастер", "первый запуск", "первоначальн", "автообновлен", "обновление приложени"]) { return .updates }
        if has(["поиск", "источник", "лид", "категори", "openstreetmap", "osm", "telegram", "телеграм", "регион", "ключев", "исключен"]) { return .search }
        if has(["облак", "синхрон", "резервн", "диск", "экспорт", "импорт", "crm", "интеграц", "почт", "звонк"]) { return .data }
        if has(["интерфейс", "окн", "панел", "дизайн", "оформлен", "темн", "светл", "тема", "темы", "тему", "цвет", "адаптив", "масштаб", "анимац", "кнопк", "меню", "настройк"]) { return .interface }
        return .other
    }

    private static func preview(for topic: WhatsNewTopic, items: [String], platform: ReleasePlatform) -> WhatsNewPreview? {
        let low = items.joined(separator: " ").lowercased().replacingOccurrences(of: "ё", with: "е")
        func has(_ words: [String]) -> Bool { words.contains { low.contains($0) } }
        if has(["энергосбереж", "заряд", "батаре", "облегчен"]) { return .power }
        if has(["исключен"]) { return .exclusions }
        if has(["категори", "openstreetmap", "osm"]) { return .categories }
        if has(["панел"]) { return .sidebar }
        if has(["адаптив"]) { return .adaptive }
        if has(["окно настроек", "окна настроек", "настройк"]) { return .settings }
        if has(["кнопк", "обновить"]) && topic == .updates { return .update }
        switch topic {
        case .interface: return platform == .windows ? .adaptive : .settings
        case .search: return .categories
        case .data: return .cloud
        case .updates: return .update
        case .power: return .power
        case .other: return nil
        }
    }

    // MARK: Регулярные выражения

    private static func replace(_ s: String, _ pattern: String, _ template: String) -> String {
        s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
    }

    private static func firstMatch(_ s: String, _ pattern: String) -> [String]? {
        guard let rx = try? NSRegularExpression(pattern: pattern),
              let m = rx.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            Range(m.range(at: i), in: s).map { String(s[$0]) } ?? ""
        }
    }
}
