#if canImport(CryptoKit)
import CryptoKit
#endif
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Номер версии вида 1.0.4 (тег v1.0.4 тоже понимается).
public struct AppVersion: Comparable, CustomStringConvertible, Sendable {
    public let parts: [Int]

    public init?(_ text: String) {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("v") || s.hasPrefix("V") { s.removeFirst() }
        // «1.0.4-beta» → 1.0.4: суффиксы предварительных версий не учитываются.
        if let cut = s.firstIndex(where: { $0 == "-" || $0 == "+" || $0 == " " }) { s = String(s[..<cut]) }
        let nums = s.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard !nums.isEmpty, nums.count <= 4, nums.allSatisfy({ $0 != nil && $0! >= 0 }) else { return nil }
        parts = nums.map { $0! }
    }

    public var description: String { parts.map(String.init).joined(separator: ".") }

    public static func < (a: AppVersion, b: AppVersion) -> Bool {
        let n = max(a.parts.count, b.parts.count)
        for i in 0..<n {
            let x = i < a.parts.count ? a.parts[i] : 0
            let y = i < b.parts.count ? b.parts[i] : 0
            if x != y { return x < y }
        }
        return false
    }

    public static func == (a: AppVersion, b: AppVersion) -> Bool { !(a < b) && !(b < a) }
}

/// Релиз из публичного API GitHub (без токена).
public struct ReleaseInfo: Decodable, Sendable {
    public struct Asset: Decodable, Sendable {
        public let name: String
        public let browserDownloadURL: URL
        public let size: Int?
        /// «sha256:…», GitHub считает сам для каждого файла релиза.
        public let digest: String?

        enum CodingKeys: String, CodingKey {
            case name, size, digest
            case browserDownloadURL = "browser_download_url"
        }
    }

    public let tagName: String
    public let name: String?
    public let body: String?
    public let htmlURL: URL?
    public let draft: Bool
    public let prerelease: Bool
    public let assets: [Asset]
    /// Дата публикации в формате ISO 8601 (у черновиков её нет).
    public let publishedAt: String?

    public var publishedDate: Date? { publishedAt.flatMap { ISO8601DateFormatter().date(from: $0) } }
    /// Название для списка: «Lead Generator 1.0.6» или тег, если названия нет.
    public var title: String { (name?.isEmpty == false ? name : nil) ?? tagName }

    enum CodingKeys: String, CodingKey {
        case name, body, draft, prerelease, assets
        case tagName = "tag_name"
        case htmlURL = "html_url"
        case publishedAt = "published_at"
    }
}

/// Найденное обновление: версия, установщик и его контрольная сумма.
public struct AvailableUpdate: Sendable {
    public let version: AppVersion
    public let title: String
    public let notes: String
    public let page: URL?
    public let dmg: ReleaseInfo.Asset
    /// Файл .sha256 рядом с установщиком (запасной способ проверки, если GitHub не прислал digest).
    public let checksumFile: ReleaseInfo.Asset?

    /// Ожидаемая SHA-256 из ответа GitHub, если она есть.
    public var expectedDigest: String? {
        guard let d = dmg.digest?.lowercased(), d.hasPrefix("sha256:") else { return nil }
        let hex = String(d.dropFirst("sha256:".count))
        return Updates.isSHA256(hex) ? hex : nil
    }
}

public enum UpdateError: LocalizedError {
    case badResponse(Int)
    case noInstaller
    case noChecksum
    case checksumMismatch
    case wrongApp(String)
    case cannotInstall(String)
    case notEnoughSpace(String)
    case network(String)

    public var errorDescription: String? {
        switch self {
        case .badResponse(let code): return "GitHub ответил с кодом \(code)"
        case .noInstaller: return "В релизе нет установщика для macOS"
        case .noChecksum: return "В релизе нет контрольной суммы установщика, установка небезопасна"
        case .checksumMismatch: return "Контрольная сумма скачанного файла не совпала: файл повреждён или подменён"
        case .wrongApp(let why): return "В установщике не то приложение: \(why)"
        case .cannotInstall(let why): return "Не удалось установить обновление: \(why)"
        case .notEnoughSpace(let why): return why
        case .network(let why): return why
        }
    }
}

public enum Updates {
    /// Описание релиза (Markdown с GitHub) в обычный читаемый текст: без «**», «##», обратных кавычек и ссылок,
    /// списки — с точками «•», переносы строк сохраняются, лишние пустые строки схлопываются.
    /// `limit` — максимум символов; текст обрезается по границе строки с многоточием.
    public static func plainNotes(_ markdown: String, limit: Int? = nil) -> String {
        var text = markdown.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        text = replace(text, "(?s)<!--.*?-->", "")
        var out: [String] = []
        var inFence = false
        for raw in text.components(separatedBy: "\n") {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { inFence.toggle(); continue }
            if inFence { out.append(raw.replacingOccurrences(of: "\t", with: "  ")); continue }
            if trimmed.isEmpty { out.append(""); continue }
            // Горизонтальные линии «---», «***», «___» и таблицы-разделители не нужны.
            if replace(trimmed, "^([-*_=])(\\s*\\1){2,}$", "").isEmpty { continue }
            var line = trimmed
            var indent = ""
            // Уровень вложенности списка — по отступу в исходной строке.
            let lead = raw.prefix { $0 == " " || $0 == "\t" }.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
            if lead >= 2 { indent = String(repeating: "  ", count: min(lead / 2, 4)) }
            while line.hasPrefix(">") { line = String(line.dropFirst()).trimmingCharacters(in: .whitespaces) }
            if line.hasPrefix("#") {
                line = replace(line, "^#{1,6}\\s*", "")
                line = replace(line, "\\s+#+$", "")
                indent = ""
            } else if let m = firstMatch(line, "^[-*+]\\s+(\\[[ xX]\\]\\s+)?(.*)$") {
                let box = m[1].trimmingCharacters(in: .whitespaces)
                let mark = box.isEmpty ? "•" : (box == "[ ]" ? "☐" : "☑")
                line = indent + mark + " " + m[2]
                indent = ""
            } else if firstMatch(line, "^\\d+[.)]\\s+") != nil {
                line = indent + line
                indent = ""
            }
            out.append(indent + inline(line))
        }
        // Схлопываем пустые строки и обрезаем края.
        var lines: [String] = []
        for l in out {
            let t = l.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { if lines.last?.isEmpty == false { lines.append("") } } else { lines.append(l.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)) }
        }
        while lines.last?.isEmpty == true { lines.removeLast() }
        while lines.first?.isEmpty == true { lines.removeFirst() }
        var result = lines.joined(separator: "\n")
        if let limit, result.count > limit {
            var cut = String(result.prefix(limit))
            if let nl = cut.lastIndex(of: "\n"), cut.distance(from: cut.startIndex, to: nl) > limit / 2 { cut = String(cut[..<nl]) }
            result = cut.trimmingCharacters(in: .whitespacesAndNewlines) + "…"
        }
        return result
    }

    /// Разметка внутри строки: ссылки, картинки, жирный, курсив, зачёркнутый, код, HTML-теги.
    private static func inline(_ s: String) -> String {
        var t = s
        t = replace(t, "!\\[([^\\]]*)\\]\\([^)]*\\)", "$1")
        t = replace(t, "\\[([^\\]]+)\\]\\(([^)\\s]+)[^)]*\\)", "$1")
        t = replace(t, "<(https?://[^>\\s]+)>", "$1")
        t = replace(t, "</?[A-Za-z][^>]*>", "")
        t = replace(t, "`+([^`]*)`+", "$1")
        t = replace(t, "\\*\\*\\*(.+?)\\*\\*\\*", "$1")
        t = replace(t, "\\*\\*(.+?)\\*\\*", "$1")
        t = replace(t, "(?<![A-Za-z0-9_])__(.+?)__(?![A-Za-z0-9_])", "$1")
        t = replace(t, "(?<![\\*\\w])\\*(?!\\s)([^*]+?)(?<!\\s)\\*(?![\\*\\w])", "$1")
        t = replace(t, "(?<![A-Za-z0-9_])_(?!\\s)([^_]+?)(?<!\\s)_(?![A-Za-z0-9_])", "$1")
        t = replace(t, "~~(.+?)~~", "$1")
        return t
    }

    private static func replace(_ s: String, _ pattern: String, _ template: String) -> String {
        s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
    }

    /// Группы первого совпадения (0 — всё совпадение); пустая строка для необязательной группы, которой нет.
    private static func firstMatch(_ s: String, _ pattern: String) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            Range(m.range(at: i), in: s).map { String(s[$0]) } ?? ""
        }
    }

    public static let repository = "xop1tt/CLIENTS"
    public static let latestReleaseURL = URL(string: "https://api.github.com/repos/\(repository)/releases/latest")!
    public static let releasesPage = URL(string: "https://github.com/\(repository)/releases")!
    public static let wikiPage = URL(string: "https://github.com/\(repository)/wiki")!
    static let recentReleasesURL = URL(string: "https://api.github.com/repos/\(repository)/releases?per_page=10")!

    /// Последние опубликованные релизы, новые сначала (без черновиков и предварительных версий).
    public static func recent(from releases: [ReleaseInfo], limit: Int = 3) -> [ReleaseInfo] {
        Array(releases.filter { !$0.draft && !$0.prerelease }.prefix(limit))
    }

    /// Список релизов из публичного API, для раздела «Что нового?».
    public static func fetchRecent(userAgent: String, limit: Int = 3, session: URLSession = .shared) async throws -> [ReleaseInfo] {
        var r = URLRequest(url: recentReleasesURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        r.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        r.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        r.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        let (data, resp) = try await session.data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw UpdateError.badResponse(code) }
        return recent(from: try JSONDecoder().decode([ReleaseInfo].self, from: data), limit: limit)
    }

    /// Релиз по номеру версии (для «Что нового» после ручной установки). nil — такого релиза нет.
    public static func fetchRelease(version: AppVersion, userAgent: String, session: URLSession = .shared) async throws -> ReleaseInfo? {
        for tag in ["v\(version)", "\(version)"] {
            var r = URLRequest(url: URL(string: "https://api.github.com/repos/\(repository)/releases/tags/\(tag)")!,
                               cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
            r.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            r.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
            r.setValue(userAgent, forHTTPHeaderField: "User-Agent")
            let (data, resp) = try await session.data(for: r)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 404 { continue }
            guard code == 200 else { throw UpdateError.badResponse(code) }
            if let release = try? JSONDecoder().decode(ReleaseInfo.self, from: data), !release.draft { return release }
        }
        return nil
    }

    /// Есть ли в релизе версия новее установленной.
    public static func update(from release: ReleaseInfo, current: AppVersion) -> AvailableUpdate? {
        guard !release.draft, !release.prerelease,
              let version = AppVersion(release.tagName), current < version else { return nil }
        let dmgs = release.assets.filter { $0.name.lowercased().hasSuffix(".dmg") }
        guard let dmg = dmgs.first(where: { $0.name.contains("macOS") }) ?? dmgs.first else { return nil }
        let sum = release.assets.first { $0.name == dmg.name + ".sha256" }
        return AvailableUpdate(version: version, title: release.name ?? "Customers \(version)",
                               notes: release.body ?? "", page: release.htmlURL, dmg: dmg, checksumFile: sum)
    }

    /// Последний релиз из публичного API. Без токена: 60 запросов в час на адрес, проверке раз в сутки хватает.
    public static func fetchLatest(userAgent: String, session: URLSession = .shared) async throws -> ReleaseInfo {
        var r = URLRequest(url: latestReleaseURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        r.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        r.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        r.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        let (data, resp) = try await session.data(for: r)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw UpdateError.badResponse(code) }
        return try JSONDecoder().decode(ReleaseInfo.self, from: data)
    }

    /// Первая 64-символьная шестнадцатеричная строка из файла вида «<sha256>  <имя файла>».
    public static func parseChecksumFile(_ text: String) -> String? {
        text.split(whereSeparator: { $0.isWhitespace }).map { $0.lowercased() }.first(where: isSHA256)
    }

    public static func isSHA256(_ s: String) -> Bool {
        s.count == 64 && s.allSatisfy { $0.isHexDigit }
    }

    #if canImport(CryptoKit)  // на Linux (облачные тесты ядра) CryptoKit нет; приложению он есть всегда
    /// SHA-256 файла, читается по частям.
    public static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
    #endif
}
