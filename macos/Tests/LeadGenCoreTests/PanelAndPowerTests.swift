import XCTest
@testable import LeadGenCore

/// Раскрытие боковой панели при наведении: задержки, отсутствие мерцания, меню не закрываются под курсором.
final class HoverRevealTests: XCTestCase {
    func testQuickPassOverEdgeDoesNotReveal() {
        var h = HoverReveal()
        h.setEdge(true, now: 0)
        XCTAssertFalse(h.tick(now: 0.05))
        h.setEdge(false, now: 0.08)
        XCTAssertFalse(h.tick(now: 1))
        XCTAssertFalse(h.revealed)
        XCTAssertNil(h.nextDelay(now: 1))
    }

    func testStayingAtEdgeRevealsAfterDelay() {
        var h = HoverReveal()
        h.setEdge(true, now: 0)
        XCTAssertEqual(h.nextDelay(now: 0)!, HoverReveal.showDelay, accuracy: 0.001)
        XCTAssertTrue(h.tick(now: HoverReveal.showDelay + 0.01))
        XCTAssertTrue(h.revealed)
    }

    func testMovingFromEdgeToPanelKeepsPanelOpen() {
        var h = HoverReveal()
        h.setEdge(true, now: 0)
        h.tick(now: 0.2)
        // Курсор перешёл с полосы на панель: сначала «ушёл с края», затем «вошёл в панель».
        h.setEdge(false, now: 1.0)
        h.setPanel(true, now: 1.01)
        XCTAssertFalse(h.tick(now: 3), "панель не должна закрыться, пока курсор над ней")
        XCTAssertTrue(h.revealed)
    }

    func testLeavingPanelCollapsesAfterHideDelayAndNotBefore() {
        var h = HoverReveal()
        h.setPanel(true, now: 0)
        h.tick(now: 0.2)
        XCTAssertTrue(h.revealed)
        h.setPanel(false, now: 1.0)
        XCTAssertFalse(h.tick(now: 1.0 + HoverReveal.hideDelay - 0.05))
        XCTAssertTrue(h.revealed)
        XCTAssertTrue(h.tick(now: 1.0 + HoverReveal.hideDelay + 0.01))
        XCTAssertFalse(h.revealed)
    }

    func testReturningBeforeHideDelayCancelsCollapse() {
        var h = HoverReveal()
        h.setPanel(true, now: 0)
        h.tick(now: 0.2)
        h.setPanel(false, now: 1.0)
        h.setPanel(true, now: 1.2)
        XCTAssertFalse(h.tick(now: 2.0))
        XCTAssertTrue(h.revealed)
        XCTAssertNil(h.nextDelay(now: 2.0))
    }

    func testOpenMenuKeepsPanelUntilClosed() {
        var h = HoverReveal()
        h.setPanel(true, now: 0)
        h.tick(now: 0.2)
        h.setBusy(true, now: 0.5)
        h.setPanel(false, now: 1.0) // курсор ушёл в меню учётной записи
        XCTAssertFalse(h.tick(now: 10))
        XCTAssertTrue(h.revealed)
        h.setBusy(false, now: 10)
        XCTAssertFalse(h.tick(now: 10.1))
        XCTAssertTrue(h.tick(now: 10 + HoverReveal.hideDelay + 0.01))
    }

    func testResetCollapsesImmediately() {
        var h = HoverReveal()
        h.setEdge(true, now: 0)
        h.tick(now: 0.2)
        h.reset()
        XCTAssertFalse(h.revealed)
        XCTAssertNil(h.nextDelay(now: 0.3))
    }

    func testNoFlickerWhenPointerJittersAtEdge() {
        var h = HoverReveal()
        var now = 0.0
        var changes = 0
        // Курсор дрожит на краю: заходит и выходит каждые 40 мс — панель ни разу не должна открыться.
        for i in 0..<50 {
            h.setEdge(i % 2 == 0, now: now)
            if h.tick(now: now) { changes += 1 }
            now += 0.04
        }
        XCTAssertEqual(changes, 0)
    }
}

final class PowerPolicyTests: XCTestCase {
    func testSystemSaverAlwaysTurnsLightModeOn() {
        let r = PowerPolicy.evaluate(PowerState(systemSaver: true, batteryPercent: 100, charging: true), automatic: true, threshold: 20)
        XCTAssertEqual(r, .systemSaver)
    }

    func testBatteryBelowThresholdTurnsItOn() {
        let r = PowerPolicy.evaluate(PowerState(batteryPercent: 19, charging: false), automatic: true, threshold: 20)
        XCTAssertEqual(r, .lowBattery(percent: 19, threshold: 20))
    }

    func testBatteryAtOrAboveThresholdKeepsNormalMode() {
        XCTAssertNil(PowerPolicy.evaluate(PowerState(batteryPercent: 20, charging: false), automatic: true, threshold: 20))
        XCTAssertNil(PowerPolicy.evaluate(PowerState(batteryPercent: 21, charging: false), automatic: true, threshold: 20))
    }

    func testChargingDoesNotCountAsLowBattery() {
        XCTAssertNil(PowerPolicy.evaluate(PowerState(batteryPercent: 5, charging: true), automatic: true, threshold: 20))
    }

    func testUnknownChargingStillAppliesThreshold() {
        XCTAssertNotNil(PowerPolicy.evaluate(PowerState(batteryPercent: 5, charging: nil), automatic: true, threshold: 20))
    }

    func testMissingBatteryInfoUsesOnlySystemSaver() {
        XCTAssertNil(PowerPolicy.evaluate(PowerState(systemSaver: false, batteryPercent: nil), automatic: true, threshold: 20))
        XCTAssertEqual(PowerPolicy.evaluate(PowerState(systemSaver: true, batteryPercent: nil), automatic: true, threshold: 20), .systemSaver)
    }

    func testDisabledAutomaticModeNeverActivates() {
        XCTAssertNil(PowerPolicy.evaluate(PowerState(systemSaver: true, batteryPercent: 1, charging: false), automatic: false, threshold: 50))
    }

    func testRecoveryRestoresNormalMode() {
        var state = PowerState(batteryPercent: 10, charging: false)
        XCTAssertNotNil(PowerPolicy.evaluate(state, automatic: true, threshold: 20))
        state.batteryPercent = 35
        XCTAssertNil(PowerPolicy.evaluate(state, automatic: true, threshold: 20))
        state.systemSaver = true
        XCTAssertNotNil(PowerPolicy.evaluate(state, automatic: true, threshold: 20))
        state.systemSaver = false
        XCTAssertNil(PowerPolicy.evaluate(state, automatic: true, threshold: 20))
    }

    func testThresholdIsClamped() {
        XCTAssertEqual(PowerPolicy.defaultThreshold, 20)
        XCTAssertEqual(PowerPolicy.clamp(0), 5)
        XCTAssertEqual(PowerPolicy.clamp(99), 50)
        XCTAssertEqual(PowerPolicy.clamp(30), 30)
        // Порог 99 считается как 50: заряд 49 уже низкий, 50 — нет.
        XCTAssertNotNil(PowerPolicy.evaluate(PowerState(batteryPercent: 49, charging: false), automatic: true, threshold: 99))
        XCTAssertNil(PowerPolicy.evaluate(PowerState(batteryPercent: 50, charging: false), automatic: true, threshold: 99))
    }

    func testExplanationsTellTheReason() {
        XCTAssertTrue(LightModeReason.systemSaver.explanation.contains("энергосбережения"))
        let low = LightModeReason.lowBattery(percent: 18, threshold: 20).explanation
        XCTAssertTrue(low.contains("18%") && low.contains("20%"))
    }
}

final class SidebarPrefsTests: XCTestCase {
    func testHiddenSectionsRoundTrip() {
        let set: Set<String> = ["runs", "archive"]
        XCTAssertEqual(SidebarPrefs.parse(hidden: SidebarPrefs.serialize(hidden: set)), set)
        XCTAssertEqual(SidebarPrefs.parse(hidden: ""), [])
        XCTAssertEqual(SidebarPrefs.parse(hidden: " a , ,b"), ["a", "b"])
    }
}

final class ExclusionDetectionTests: XCTestCase {
    func testDetectsEveryFormat() {
        XCTAssertEqual(ExclusionKind.detect("example.ru"), .domain)
        XCTAssertEqual(ExclusionKind.detect("https://www.Example.ru/page?x=1"), .domain)
        XCTAssertEqual(ExclusionKind.detect("+7 (843) 212-48-90"), .phone)
        XCTAssertEqual(ExclusionKind.detect("8 843 2124890"), .phone)
        XCTAssertEqual(ExclusionKind.detect("name@mail.ru"), .email)
        XCTAssertEqual(ExclusionKind.detect("  Name@Mail.RU  "), .email)
    }

    func testUnknownFormatFallsBackToNothing() {
        XCTAssertNil(ExclusionKind.detect("Студия красоты Лаванда"))
        XCTAssertNil(ExclusionKind.detect(""))
        XCTAssertNil(ExclusionKind.detect("   "))
        XCTAssertNil(ExclusionKind.detect("12.5"))      // число, не домен
        XCTAssertNil(ExclusionKind.detect("212-48-90")) // короче 10 цифр
        XCTAssertNil(ExclusionKind.detect("не email @ почта"))
    }
}

final class RegionSuggestionTests: XCTestCase {
    func testPrefersLocalityThenDistrictThenRegion() {
        XCTAssertEqual(RegionSuggestion.name(locality: "Казань", subAdministrativeArea: "Вахитовский", administrativeArea: "Татарстан"), "Казань")
        XCTAssertEqual(RegionSuggestion.name(locality: nil, subAdministrativeArea: "Пестречинский район", administrativeArea: "Татарстан"), "Пестречинский район")
        XCTAssertEqual(RegionSuggestion.name(locality: " ", subAdministrativeArea: nil, administrativeArea: "Татарстан"), "Татарстан")
        XCTAssertNil(RegionSuggestion.name(locality: nil))
        XCTAssertNil(RegionSuggestion.name(locality: "", subAdministrativeArea: "", administrativeArea: nil))
    }

    func testStripsAdministrativeWords() {
        XCTAssertEqual(RegionSuggestion.name(locality: "городской округ Сочи"), "Сочи")
        XCTAssertEqual(RegionSuggestion.name(locality: "город Пермь"), "Пермь")
        XCTAssertEqual(RegionSuggestion.name(locality: "Сочи городской округ"), "Сочи")
    }

    func testSuggestionNeverOverwritesUserChoice() {
        XCTAssertEqual(RegionSuggestion.applying("Казань", to: []), ["Казань"])
        XCTAssertEqual(RegionSuggestion.applying("Казань", to: ["Ереван"]), ["Ереван"])
        XCTAssertEqual(RegionSuggestion.applying(nil, to: []), [])
    }
}
