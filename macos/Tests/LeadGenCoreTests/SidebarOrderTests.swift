import Foundation
import XCTest
@testable import LeadGenCore

/// Порядок и видимость пунктов боковой панели в режиме редактирования («Настроить панель» → «Готово»).
final class SidebarOrderTests: XCTestCase {
    func testOrderRoundTripDropsBlanksAndDuplicates() {
        XCTAssertEqual(SidebarPrefs.parse(order: ""), [])
        XCTAssertEqual(SidebarPrefs.parse(order: " b, a ,,b, c"), ["b", "a", "c"])
        let order = ["runs", "sources", "archive"]
        XCTAssertEqual(SidebarPrefs.parse(order: SidebarPrefs.serialize(order: order)), order)
    }

    func testOrderedKeepsSavedOrderAndAppendsNewItems() {
        let items = ["home", "all", "new", "favorites"]
        XCTAssertEqual(SidebarPrefs.ordered(items, by: []), items, "без сохранённого порядка — исходный")
        XCTAssertEqual(SidebarPrefs.ordered(items, by: ["new", "home"]), ["new", "home", "all", "favorites"])
        XCTAssertEqual(SidebarPrefs.ordered(items, by: ["gone", "favorites"]), ["favorites", "home", "all", "new"],
                       "исчезнувшие пункты пропускаются")
        XCTAssertEqual(SidebarPrefs.ordered([], by: ["a"]), [])
    }

    func testMoveMatchesListOnMoveSemantics() {
        let items = ["a", "b", "c", "d"]
        XCTAssertEqual(SidebarPrefs.move(items, from: [0], to: 3), ["b", "c", "a", "d"])
        XCTAssertEqual(SidebarPrefs.move(items, from: [0], to: 4), ["b", "c", "d", "a"])
        XCTAssertEqual(SidebarPrefs.move(items, from: [3], to: 0), ["d", "a", "b", "c"])
        XCTAssertEqual(SidebarPrefs.move(items, from: [1, 2], to: 4), ["a", "d", "b", "c"])
        XCTAssertEqual(SidebarPrefs.move(items, from: [2], to: 2), items, "на то же место — без изменений")
    }

    func testMoveIgnoresInvalidPositions() {
        let items = ["a", "b"]
        XCTAssertEqual(SidebarPrefs.move(items, from: [5], to: 0), items)
        XCTAssertEqual(SidebarPrefs.move(items, from: [0], to: 9), items)
        XCTAssertEqual(SidebarPrefs.move(items, from: [], to: 1), items)
        XCTAssertEqual(SidebarPrefs.move([], from: [0], to: 0), [])
    }

    func testMoveKeepsEveryItemExactlyOnce() {
        let items = ["a", "b", "c", "d", "e"]
        for from in items.indices {
            for to in 0...items.count {
                let moved = SidebarPrefs.move(items, from: [from], to: to)
                XCTAssertEqual(moved.sorted(), items, "перенос \(from)→\(to) потерял или задвоил пункт")
            }
        }
    }

    func testToggledVisibility() {
        var hidden: Set<String> = []
        hidden = SidebarPrefs.toggled(hidden, "runs", visible: false)
        XCTAssertEqual(hidden, ["runs"])
        hidden = SidebarPrefs.toggled(hidden, "runs", visible: false)
        XCTAssertEqual(hidden, ["runs"], "повторное скрытие ничего не меняет")
        hidden = SidebarPrefs.toggled(hidden, "runs", visible: true)
        XCTAssertEqual(hidden, [])
    }
}
