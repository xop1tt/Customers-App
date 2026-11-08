import Foundation

extension KeyedDecodingContainer {
    /// Значение или значение по умолчанию: новые поля не сбрасывают сохранённые настройки.
    func v<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }
}

/// Ключи источников. Совпадают с ключами Python-версии, чтобы старые лиды оставались привязаны к источникам.
public enum SourceKey {
    public static let rss = "fl_ru"
    public static let telegram = "telegram_channels"
    public static let vk = "vk_communities"
    public static let osm = "osm_organizations"
    public static let all = [rss, telegram, vk, osm]
}

/// RSS/Atom-ленты (FL.ru и любые другие публичные ленты заказов).
public struct FeedSourceSettings: Codable, Equatable, Sendable {
    public var enabled = true
    public var intervalHours: Double = 2
    public var feeds: [String] = ["https://www.fl.ru/rss/all.xml"]
    /// Пусто — в оценку идут все записи.
    public var keywords: [String] = []

    public init() {}
    enum CodingKeys: String, CodingKey { case enabled, intervalHours, feeds, keywords }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Self()
        enabled = c.v(.enabled, d.enabled); intervalHours = c.v(.intervalHours, d.intervalHours)
        feeds = c.v(.feeds, d.feeds); keywords = c.v(.keywords, d.keywords)
    }
}

/// Публичные Telegram-каналы через веб-превью t.me/s/<канал>.
public struct TelegramSourceSettings: Codable, Equatable, Sendable {
    public var enabled = true
    public var intervalHours: Double = 3
    public var channels: [String] = ["teleworko", "vacanciesbest", "freetasks", "theyseeku"]
    public var maxPages = 3
    public var keywords: [String] = SearchDefaults.orderKeywords

    public init() {}
    enum CodingKeys: String, CodingKey { case enabled, intervalHours, channels, maxPages, keywords }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Self()
        enabled = c.v(.enabled, d.enabled); intervalHours = c.v(.intervalHours, d.intervalHours)
        channels = c.v(.channels, d.channels); maxPages = c.v(.maxPages, d.maxPages); keywords = c.v(.keywords, d.keywords)
    }
}

/// Открытые сообщества ВКонтакте (wall.get с бесплатным сервисным ключом).
public struct VKSourceSettings: Codable, Equatable, Sendable {
    public var enabled = false
    public var intervalHours: Double = 3
    public var communities: [String] = []
    public var pageSize = 50
    public var maxPages = 2
    public var keywords: [String] = ["сайт", "бот", "приложени", "разработ", "программист", "автоматизац", "crm", "парсер", "интеграц"]

    public init() {}
    enum CodingKeys: String, CodingKey { case enabled, intervalHours, communities, pageSize, maxPages, keywords }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Self()
        enabled = c.v(.enabled, d.enabled); intervalHours = c.v(.intervalHours, d.intervalHours)
        communities = c.v(.communities, d.communities); pageSize = c.v(.pageSize, d.pageSize)
        maxPages = c.v(.maxPages, d.maxPages); keywords = c.v(.keywords, d.keywords)
    }
}

/// Категория организаций OpenStreetMap.
public struct OSMCategory: Codable, Hashable, Identifiable, Sendable {
    public var key: String
    public var label: String
    public var group: String
    public var filters: [String]
    public var enabled: Bool
    public var weight: Double
    public var id: String { key }

    public init(key: String, label: String, group: String, filters: [String], enabled: Bool = true, weight: Double = 10) {
        self.key = key; self.label = label; self.group = group; self.filters = filters
        self.enabled = enabled; self.weight = weight
    }
}

/// Организации из OpenStreetMap через Overpass API.
public struct OSMSourceSettings: Codable, Equatable, Sendable {
    public var enabled = true
    public var intervalHours: Double = 120
    public var regions: [String] = ["Ереван"]
    public var categories: [OSMCategory] = SearchDefaults.osmCategories
    public var checkWebsites = true
    /// Одинаковый запрос регион × категория не чаще, чем раз в N дней.
    public var refreshDays: Double = 7
    /// Повторная проверка уже известной организации.
    public var recheckDays: Double = 60
    public var maxNewPerRun = 40
    public var endpoint = "https://overpass-api.de/api/interpreter"

    public init() {}
    enum CodingKeys: String, CodingKey {
        case enabled, intervalHours, regions, categories, checkWebsites, refreshDays, recheckDays, maxNewPerRun, endpoint
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Self()
        enabled = c.v(.enabled, d.enabled); intervalHours = c.v(.intervalHours, d.intervalHours)
        regions = c.v(.regions, d.regions); categories = SearchDefaults.mergeCategories(c.v(.categories, d.categories))
        checkWebsites = c.v(.checkWebsites, d.checkWebsites); refreshDays = c.v(.refreshDays, d.refreshDays)
        recheckDays = c.v(.recheckDays, d.recheckDays); maxNewPerRun = c.v(.maxNewPerRun, d.maxNewPerRun)
        endpoint = c.v(.endpoint, d.endpoint)
    }
}

/// Все настройки поиска пользователя. Хранятся в его базе как JSON — тот же JSON сможет читать сервер.
public struct SearchSettings: Codable, Equatable, Sendable {
    public var rss = FeedSourceSettings()
    public var telegram = TelegramSourceSettings()
    public var vk = VKSourceSettings()
    public var osm = OSMSourceSettings()

    public init() {}
    enum CodingKeys: String, CodingKey { case rss, telegram, vk, osm }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rss = c.v(.rss, FeedSourceSettings()); telegram = c.v(.telegram, TelegramSourceSettings())
        vk = c.v(.vk, VKSourceSettings()); osm = c.v(.osm, OSMSourceSettings())
    }

    public func isEnabled(_ key: String) -> Bool {
        switch key {
        case SourceKey.rss: return rss.enabled
        case SourceKey.telegram: return telegram.enabled
        case SourceKey.vk: return vk.enabled
        case SourceKey.osm: return osm.enabled
        default: return false
        }
    }

    public func intervalHours(_ key: String) -> Double {
        switch key {
        case SourceKey.rss: return rss.intervalHours
        case SourceKey.telegram: return telegram.intervalHours
        case SourceKey.vk: return vk.intervalHours
        case SourceKey.osm: return osm.intervalHours
        default: return 24
        }
    }

    /// Настройки нового пользователя: регионы, каналы и слова пустые, их выбирает сам человек
    /// (мастер предлагает регион по геолокации). Остальное как по умолчанию.
    public static var blankStart: SearchSettings {
        var s = SearchSettings()
        s.osm.regions = []
        s.telegram.channels = []
        s.telegram.keywords = []
        return s
    }

    /// Сохранённые настройки, а для нового пользователя (в базе ничего нет) пустой старт.
    public static func stored(_ json: String?) -> SearchSettings {
        guard let json, !json.isEmpty else { return blankStart }
        return decode(json)
    }

    public static func decode(_ json: String?) -> SearchSettings {
        guard let json, let s = try? JSONDecoder().decode(SearchSettings.self, from: Data(json.utf8)) else { return SearchSettings() }
        return s
    }

    public func encoded() -> String {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return (try? e.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }
}

/// Секреты, которые нужны источникам. Хранит их приложение (Связка ключей), а не настройки.
public struct SearchSecrets: Sendable {
    public var vkToken: String?
    public init(vkToken: String? = nil) { self.vkToken = vkToken }
}

public enum SearchDefaults {
    public static let orderKeywords = [
        "сайт", "бот", "приложени", "разработ", "программист", "автоматизац", "crm", "срм", "парсер", "интеграц",
        "лендинг", "верстк", "доработ", "интернет-магазин", "telegram", "телеграм", "python", "api",
    ]

    public static let osmCategories: [OSMCategory] = [
        OSMCategory(key: "beauty", label: "Салоны красоты", group: "beauty",
                    filters: [#"["shop"="beauty"]"#, #"["shop"="hairdresser"]"#], weight: 20),
        OSMCategory(key: "dance", label: "Танцевальные студии", group: "dance",
                    filters: [#"["leisure"="dance"]"#, #"["amenity"="dancing_school"]"#], weight: 20),
        OSMCategory(key: "restaurant", label: "Рестораны", group: "restaurant",
                    filters: [#"["amenity"="restaurant"]"#], weight: 12),
        OSMCategory(key: "cafe", label: "Кафе", group: "restaurant",
                    filters: [#"["amenity"="cafe"]"#], weight: 10),
        OSMCategory(key: "education", label: "Образовательные центры", group: "education",
                    filters: [#"["amenity"="language_school"]"#, #"["amenity"="training"]"#, #"["amenity"="music_school"]"#], weight: 15),
        OSMCategory(key: "medical", label: "Медицина и косметология", group: "medical",
                    filters: [#"["amenity"="dentist"]"#, #"["healthcare"="clinic"]"#, #"["amenity"="clinic"]"#], weight: 15),
        OSMCategory(key: "fitness", label: "Спорт и фитнес", group: "fitness",
                    filters: [#"["leisure"="fitness_centre"]"#, #"["leisure"="sports_centre"]"#], weight: 15),
        OSMCategory(key: "shops", label: "Магазины", group: "shop",
                    filters: [#"["shop"="clothes"]"#, #"["shop"="gift"]"#, #"["shop"="florist"]"#], weight: 10),
        OSMCategory(key: "massage", label: "Массаж и SPA", group: "beauty",
                    filters: [#"["shop"="massage"]"#, #"["leisure"="sauna"]"#], enabled: false, weight: 15),
        OSMCategory(key: "tattoo", label: "Тату-салоны", group: "beauty",
                    filters: [#"["shop"="tattoo"]"#], enabled: false, weight: 14),
        OSMCategory(key: "cosmetics", label: "Косметика и парфюмерия", group: "beauty",
                    filters: [#"["shop"="cosmetics"]"#, #"["shop"="perfumery"]"#], enabled: false, weight: 10),
        OSMCategory(key: "doctors", label: "Частные врачи", group: "medical",
                    filters: [#"["amenity"="doctors"]"#, #"["healthcare"="doctor"]"#], enabled: false, weight: 14),
        OSMCategory(key: "physio", label: "Реабилитация и физиотерапия", group: "medical",
                    filters: [#"["healthcare"="physiotherapist"]"#, #"["healthcare"="alternative"]"#], enabled: false, weight: 13),
        OSMCategory(key: "optics", label: "Оптики", group: "medical",
                    filters: [#"["shop"="optician"]"#], enabled: false, weight: 12),
        OSMCategory(key: "vet", label: "Ветеринарные клиники", group: "medical",
                    filters: [#"["amenity"="veterinary"]"#], enabled: false, weight: 13),
        OSMCategory(key: "pharmacy", label: "Аптеки", group: "medical",
                    filters: [#"["amenity"="pharmacy"]"#], enabled: false, weight: 8),
        OSMCategory(key: "fastfood", label: "Фастфуд", group: "restaurant",
                    filters: [#"["amenity"="fast_food"]"#], enabled: false, weight: 8),
        OSMCategory(key: "bar", label: "Бары и пабы", group: "restaurant",
                    filters: [#"["amenity"="bar"]"#, #"["amenity"="pub"]"#], enabled: false, weight: 10),
        OSMCategory(key: "bakery", label: "Пекарни и кондитерские", group: "restaurant",
                    filters: [#"["shop"="bakery"]"#, #"["shop"="confectionery"]"#], enabled: false, weight: 10),
        OSMCategory(key: "catering", label: "Кейтеринг", group: "restaurant",
                    filters: [#"["craft"="caterer"]"#], enabled: false, weight: 12),
        OSMCategory(key: "hotel", label: "Отели и гостевые дома", group: "hospitality",
                    filters: [#"["tourism"="hotel"]"#, #"["tourism"="guest_house"]"#, #"["tourism"="hostel"]"#, #"["tourism"="motel"]"#], enabled: false, weight: 16),
        OSMCategory(key: "apartments", label: "Апартаменты и посуточная аренда", group: "hospitality",
                    filters: [#"["tourism"="apartment"]"#, #"["tourism"="chalet"]"#], enabled: false, weight: 14),
        OSMCategory(key: "travel", label: "Турагентства", group: "hospitality",
                    filters: [#"["shop"="travel_agency"]"#], enabled: false, weight: 14),
        OSMCategory(key: "kindergarten", label: "Детские сады и центры", group: "education",
                    filters: [#"["amenity"="kindergarten"]"#, #"["amenity"="childcare"]"#], enabled: false, weight: 12),
        OSMCategory(key: "driving", label: "Автошколы", group: "education",
                    filters: [#"["amenity"="driving_school"]"#], enabled: false, weight: 15),
        OSMCategory(key: "tutoring", label: "Репетиторы и учебные центры", group: "education",
                    filters: [#"["office"="educational_institution"]"#, #"["amenity"="prep_school"]"#], enabled: false, weight: 13),
        OSMCategory(key: "yoga", label: "Йога и студии", group: "fitness",
                    filters: [#"["sport"="yoga"]"#, #"["sport"="pilates"]"#], enabled: false, weight: 15),
        OSMCategory(key: "pools", label: "Бассейны и водный спорт", group: "fitness",
                    filters: [#"["leisure"="swimming_pool"]["access"!="private"]"#, #"["leisure"="water_park"]"#], enabled: false, weight: 9),
        OSMCategory(key: "martial", label: "Единоборства и спортивные секции", group: "fitness",
                    filters: [#"["sport"="martial_arts"]"#, #"["sport"="boxing"]"#, #"["sport"="karate"]"#], enabled: false, weight: 13),
        OSMCategory(key: "carrepair", label: "Автосервисы", group: "auto",
                    filters: [#"["shop"="car_repair"]"#, #"["craft"="mechanic"]"#], enabled: false, weight: 16),
        OSMCategory(key: "cardealer", label: "Автосалоны", group: "auto",
                    filters: [#"["shop"="car"]"#], enabled: false, weight: 14),
        OSMCategory(key: "carparts", label: "Автозапчасти и шины", group: "auto",
                    filters: [#"["shop"="car_parts"]"#, #"["shop"="tyres"]"#], enabled: false, weight: 12),
        OSMCategory(key: "carwash", label: "Автомойки", group: "auto",
                    filters: [#"["amenity"="car_wash"]"#], enabled: false, weight: 12),
        OSMCategory(key: "lawyer", label: "Юристы и нотариусы", group: "services",
                    filters: [#"["office"="lawyer"]"#, #"["office"="notary"]"#], enabled: false, weight: 16),
        OSMCategory(key: "accountant", label: "Бухгалтерия и аудит", group: "services",
                    filters: [#"["office"="accountant"]"#, #"["office"="tax_advisor"]"#], enabled: false, weight: 15),
        OSMCategory(key: "realty", label: "Агентства недвижимости", group: "services",
                    filters: [#"["office"="estate_agent"]"#], enabled: false, weight: 18),
        OSMCategory(key: "insurance", label: "Страхование", group: "services",
                    filters: [#"["office"="insurance"]"#], enabled: false, weight: 12),
        OSMCategory(key: "itcompany", label: "IT-компании", group: "services",
                    filters: [#"["office"="it"]"#], enabled: false, weight: 10),
        OSMCategory(key: "advertising", label: "Рекламные и маркетинговые агентства", group: "services",
                    filters: [#"["office"="advertising_agency"]"#, #"["office"="marketing"]"#], enabled: false, weight: 14),
        OSMCategory(key: "architect", label: "Архитекторы и дизайнеры", group: "services",
                    filters: [#"["office"="architect"]"#], enabled: false, weight: 15),
        OSMCategory(key: "photo", label: "Фотостудии и фотографы", group: "services",
                    filters: [#"["craft"="photographer"]"#, #"["shop"="photo"]"#], enabled: false, weight: 14),
        OSMCategory(key: "print", label: "Типографии и копицентры", group: "services",
                    filters: [#"["shop"="copyshop"]"#, #"["craft"="printer"]"#], enabled: false, weight: 12),
        OSMCategory(key: "cleaning", label: "Прачечные и химчистки", group: "services",
                    filters: [#"["shop"="laundry"]"#, #"["shop"="dry_cleaning"]"#], enabled: false, weight: 10),
        OSMCategory(key: "tailor", label: "Ателье и пошив", group: "services",
                    filters: [#"["craft"="tailor"]"#, #"["shop"="tailor"]"#, #"["shop"="fabric"]"#], enabled: false, weight: 11),
        OSMCategory(key: "repair", label: "Ремонт техники и телефонов", group: "services",
                    filters: [#"["craft"="electronics_repair"]"#, #"["shop"="mobile_phone"]"#], enabled: false, weight: 12),
        OSMCategory(key: "construction", label: "Строительство и ремонт", group: "construction",
                    filters: [#"["office"="construction_company"]"#, #"["craft"="builder"]"#, #"["craft"="carpenter"]"#], enabled: false, weight: 15),
        OSMCategory(key: "engineering", label: "Электрики, сантехники, отопление", group: "construction",
                    filters: [#"["craft"="electrician"]"#, #"["craft"="plumber"]"#, #"["craft"="hvac"]"#], enabled: false, weight: 12),
        OSMCategory(key: "furniture", label: "Мебель и интерьер", group: "home",
                    filters: [#"["shop"="furniture"]"#, #"["shop"="interior_decoration"]"#, #"["shop"="kitchen"]"#], enabled: false, weight: 14),
        OSMCategory(key: "hardware", label: "Стройматериалы и инструменты", group: "home",
                    filters: [#"["shop"="doityourself"]"#, #"["shop"="hardware"]"#, #"["shop"="trade"]"#], enabled: false, weight: 10),
        OSMCategory(key: "electronics", label: "Электроника и компьютеры", group: "retail",
                    filters: [#"["shop"="electronics"]"#, #"["shop"="computer"]"#, #"["shop"="appliance"]"#], enabled: false, weight: 10),
        OSMCategory(key: "jewelry", label: "Ювелирные магазины", group: "retail",
                    filters: [#"["shop"="jewelry"]"#], enabled: false, weight: 11),
        OSMCategory(key: "pets", label: "Зоомагазины", group: "retail",
                    filters: [#"["shop"="pet"]"#, #"["shop"="pet_grooming"]"#], enabled: false, weight: 11),
        OSMCategory(key: "kids", label: "Детские товары и игрушки", group: "retail",
                    filters: [#"["shop"="toys"]"#, #"["shop"="baby_goods"]"#], enabled: false, weight: 9),
        OSMCategory(key: "sports", label: "Спортивные товары и велосипеды", group: "retail",
                    filters: [#"["shop"="sports"]"#, #"["shop"="bicycle"]"#], enabled: false, weight: 9),
        OSMCategory(key: "books", label: "Книги и канцелярия", group: "retail",
                    filters: [#"["shop"="books"]"#, #"["shop"="stationery"]"#], enabled: false, weight: 8),
        OSMCategory(key: "events", label: "Мероприятия и праздники", group: "leisure",
                    filters: [#"["amenity"="events_venue"]"#, #"["shop"="party"]"#], enabled: false, weight: 13),
        OSMCategory(key: "entertainment", label: "Квесты, боулинг, кинотеатры", group: "leisure",
                    filters: [#"["leisure"="escape_game"]"#, #"["leisure"="bowling_alley"]"#, #"["amenity"="cinema"]"#], enabled: false, weight: 11),
        OSMCategory(key: "nightclub", label: "Ночные клубы", group: "leisure",
                    filters: [#"["amenity"="nightclub"]"#], enabled: false, weight: 10),
    ]

    /// Названия групп категорий OpenStreetMap для интерфейса.
    public static let osmGroupTitles: [String: String] = [
        "beauty": "Красота и уход",
        "dance": "Танцы",
        "restaurant": "Питание",
        "education": "Образование",
        "medical": "Здоровье",
        "fitness": "Спорт и фитнес",
        "shop": "Магазины",
        "retail": "Розница",
        "hospitality": "Отели и туризм",
        "auto": "Авто",
        "services": "Услуги и офисы",
        "construction": "Строительство",
        "home": "Дом и интерьер",
        "leisure": "Досуг и мероприятия",
    ]

    /// Сохранённые категории пользователя плюс новые из каталога (выключенные): выбор пользователя не меняется.
    public static func mergeCategories(_ stored: [OSMCategory]) -> [OSMCategory] {
        let known = Set(stored.map(\.key))
        return stored + osmCategories.filter { !known.contains($0.key) }
    }
}

/// Приведение того, что вводит пользователь, к виду, который понимает источник.
public enum SourceInput {
    private static let channelRx = Rx(#"^[A-Za-z][A-Za-z0-9_]{3,31}$"#)
    private static let vkRx = Rx(#"^[A-Za-z0-9_.]{2,64}$"#)

    /// «@name», «t.me/name», «https://t.me/s/name» → «name».
    public static func telegramChannel(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for p in ["https://", "http://"] where s.lowercased().hasPrefix(p) { s.removeFirst(p.count) }
        for p in ["www.", "t.me/s/", "t.me/", "telegram.me/"] where s.lowercased().hasPrefix(p) { s.removeFirst(p.count) }
        if s.hasPrefix("@") { s.removeFirst() }
        if let cut = s.firstIndex(where: { $0 == "/" || $0 == "?" }) { s = String(s[..<cut]) }
        return channelRx.matches(s) ? s : nil
    }

    /// «https://vk.com/name» → «name».
    public static func vkCommunity(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for p in ["https://", "http://"] where s.lowercased().hasPrefix(p) { s.removeFirst(p.count) }
        for p in ["www.", "m.vk.com/", "vk.com/", "vk.ru/"] where s.lowercased().hasPrefix(p) { s.removeFirst(p.count) }
        if s.hasPrefix("@") { s.removeFirst() }
        if let cut = s.firstIndex(where: { $0 == "/" || $0 == "?" }) { s = String(s[..<cut]) }
        return vkRx.matches(s) ? s : nil
    }

    /// Адрес ленты: только публичный http(s).
    public static func feedURL(_ raw: String) -> String? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "https://" + s }
        return SiteChecker.isPublicHTTPURL(s) ? s : nil
    }

    public static func keyword(_ raw: String) -> String? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return s.isEmpty ? nil : s
    }

    public static func region(_ raw: String) -> String? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\"", with: "")
        return s.isEmpty ? nil : s
    }

    /// Разбивает ввод на элементы: по запятым, точкам с запятой и строкам.
    public static func split(_ text: String) -> [String] {
        text.components(separatedBy: CharacterSet(charactersIn: ",;\n\r\t"))
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}
