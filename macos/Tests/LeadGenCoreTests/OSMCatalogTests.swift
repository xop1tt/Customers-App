import XCTest
@testable import LeadGenCore
@testable import LeadSearch

/// Каталог категорий OpenStreetMap: настоящие теги, без повторов, с группами, старые настройки не ломаются.
final class OSMCatalogTests: XCTestCase {
    private let all = SearchDefaults.osmCategories

    func testCatalogIsMuchLargerThanTheOriginalEight() {
        XCTAssertGreaterThanOrEqual(all.count, 40)
        XCTAssertEqual(all.prefix(8).map(\.key), ["beauty", "dance", "restaurant", "cafe", "education", "medical", "fitness", "shops"])
        XCTAssertTrue(all.prefix(8).allSatisfy(\.enabled), "прежние категории остаются включёнными по умолчанию")
        XCTAssertTrue(all.dropFirst(8).allSatisfy { !$0.enabled }, "новые категории выключены: запросов не становится больше сами по себе")
    }

    func testKeysAndLabelsAreUnique() {
        XCTAssertEqual(Set(all.map(\.key)).count, all.count)
        XCTAssertEqual(Set(all.map(\.label)).count, all.count)
    }

    func testNoTwoCategoriesShareAFilter() {
        var seen: [String: String] = [:]
        for c in all {
            for f in c.filters {
                XCTAssertNil(seen[f], "фильтр \(f) есть и в «\(seen[f] ?? "")», и в «\(c.key)»")
                seen[f] = c.key
            }
        }
    }

    func testEveryFilterIsAWellFormedOverpassTagCondition() {
        let rx = try! NSRegularExpression(pattern: #"^(\["[a-z_:]+"(=|!=)"[a-z_]+"\])+$"#)
        for c in all {
            XCTAssertFalse(c.filters.isEmpty, c.key)
            for f in c.filters {
                XCTAssertNotNil(rx.firstMatch(in: f, range: NSRange(f.startIndex..., in: f)), "\(c.key): \(f)")
                XCTAssertTrue(f.hasPrefix("[\"shop\"") || f.hasPrefix("[\"amenity\"") || f.hasPrefix("[\"office\"") || f.hasPrefix("[\"craft\"")
                              || f.hasPrefix("[\"leisure\"") || f.hasPrefix("[\"tourism\"") || f.hasPrefix("[\"healthcare\"") || f.hasPrefix("[\"sport\""),
                              "ключ тега не из известных основных: \(f)")
            }
        }
    }

    func testEveryCategoryHasGroupTitleAndSaneWeight() {
        for c in all {
            XCTAssertNotNil(SearchDefaults.osmGroupTitles[c.group], "нет названия группы \(c.group)")
            XCTAssertTrue((1...30).contains(c.weight), c.key)
            XCTAssertFalse(c.label.isEmpty)
        }
    }

    func testQueryContainsEveryFilterOfACategory() {
        let c = all.first { $0.key == "pools" }!
        let q = OSMSource.buildQuery(region: "Казань", filters: c.filters)
        for f in c.filters { XCTAssertTrue(q.contains("nwr\(f)(area.a);"), f) }
    }

    func testStoredSettingsGetNewCategoriesWithoutChangingChoices() {
        var old = SearchSettings()
        old.osm.categories = Array(SearchDefaults.osmCategories.prefix(8))
        old.osm.categories[0].enabled = false
        var json = old.encoded()
        // Настройки, сохранённые старой версией: только восемь категорий.
        let decoded = SearchSettings.decode(json)
        XCTAssertEqual(decoded.osm.categories.count, all.count)
        XCTAssertFalse(decoded.osm.categories[0].enabled, "выбор пользователя сохранился")
        XCTAssertTrue(decoded.osm.categories.dropFirst(8).allSatisfy { !$0.enabled })
        json = decoded.encoded()
        XCTAssertEqual(SearchSettings.decode(json).osm.categories.count, all.count, "повторное чтение не дублирует категории")
    }

    func testNewUserHasNothingPreselectedForTheUser() {
        let s = SearchSettings.stored(nil)
        XCTAssertEqual(SearchSettings.stored(""), SearchSettings.blankStart)
        XCTAssertEqual(s.osm.regions, [], "регион по умолчанию не задан")
        XCTAssertEqual(s.telegram.channels, [])
        XCTAssertEqual(s.telegram.keywords, [])
    }

    func testSavedFiltersOfExistingUsersAreKept() {
        var s = SearchSettings()
        s.telegram.channels = ["mychannel"]
        s.telegram.keywords = ["сайт"]
        s.osm.regions = ["Казань"]
        let back = SearchSettings.decode(s.encoded())
        XCTAssertEqual(back.telegram.channels, ["mychannel"])
        XCTAssertEqual(back.telegram.keywords, ["сайт"])
        XCTAssertEqual(back.osm.regions, ["Казань"])
    }
}
