import XCTest
@testable import LeadGenCore

final class FirstRunTests: XCTestCase {
    private func v(_ s: String) -> AppVersion { AppVersion(s)! }

    func testWhatsNewPolicy() {
        XCTAssertEqual(WhatsNewPolicy.decide(lastSeen: nil, current: v("1.0.0"), hasExistingData: false), .recordOnly)
        XCTAssertEqual(WhatsNewPolicy.decide(lastSeen: nil, current: v("1.0.0"), hasExistingData: true), .show)
        XCTAssertEqual(WhatsNewPolicy.decide(lastSeen: "1.0.0", current: v("1.1.0"), hasExistingData: false), .show)
        XCTAssertEqual(WhatsNewPolicy.decide(lastSeen: "1.1.0", current: v("1.1.0"), hasExistingData: true), .none)
        XCTAssertEqual(WhatsNewPolicy.decide(lastSeen: "1.2.0", current: v("1.1.0"), hasExistingData: true), .recordOnly)
        XCTAssertEqual(WhatsNewPolicy.decide(lastSeen: "мусор", current: v("1.1.0"), hasExistingData: false), .recordOnly)
        XCTAssertEqual(WhatsNewPolicy.decide(lastSeen: "1.0.9", current: v("1.0.10"), hasExistingData: false), .show)
    }

    func testInstalledNotesRoundTripAndVersionMatch() {
        let n = InstalledNotes(version: "1.3.0", title: "Customers 1.3.0", notes: "## Новое\n- быстрее")
        XCTAssertEqual(InstalledNotes.decode(n.encoded(), for: v("1.3.0")), n)
        XCTAssertNil(InstalledNotes.decode(n.encoded(), for: v("1.4.0")))
        XCTAssertNil(InstalledNotes.decode("не json", for: v("1.3.0")))
        XCTAssertNil(InstalledNotes.decode(nil, for: v("1.3.0")))
    }

    func testSpaceRequirement() {
        let size = 100 * 1024 * 1024
        let need = UpdateSpace.required(dmgSize: size)
        XCTAssertEqual(need, Int64(size) * 3 + UpdateSpace.margin)
        XCTAssertTrue(UpdateSpace.isEnough(available: need, dmgSize: size))
        XCTAssertFalse(UpdateSpace.isEnough(available: need - 1, dmgSize: size))
        XCTAssertGreaterThan(UpdateSpace.required(dmgSize: nil), UpdateSpace.margin)
        XCTAssertTrue(UpdateSpace.message(available: 1000, dmgSize: size).contains("Недостаточно места"))
    }

    func testIntervals() {
        XCTAssertEqual(UpdateIntervals.normalize(6), 6)
        XCTAssertEqual(UpdateIntervals.normalize(5), 24)
        XCTAssertEqual(UpdateIntervals.normalize(0), 24)
    }

    func testWelcomeFlowWalkBackSkipFinish() {
        var f = WelcomeFlow()
        XCTAssertEqual(f.step, .intro)
        XCTAssertFalse(f.canGoBack)
        XCTAssertFalse(f.canSkip)
        XCTAssertEqual(f.position, "Шаг 1 из 5")
        var seen = [f.step]
        var progress = [f.progress]
        while !f.isLast { f.next(); seen.append(f.step); progress.append(f.progress) }
        XCTAssertEqual(seen, WelcomeStep.allCases)
        XCTAssertEqual(progress.last, 1.0)
        XCTAssertEqual(progress, progress.sorted())
        f.back()
        XCTAssertEqual(f.step, .drives)
        f.next()
        XCTAssertFalse(f.finished)
        f.next()
        XCTAssertTrue(f.finished)
        XCTAssertFalse(f.canGoBack)
    }

    func testSkipMarksStepAndConfiguredWins() {
        var f = WelcomeFlow()
        f.skip() // знакомство нельзя пропустить, просто идём дальше
        XCTAssertEqual(f.step, .sources)
        XCTAssertEqual(f.state(of: .intro, configured: false), .pending)
        f.skip()
        XCTAssertEqual(f.state(of: .sources, configured: false), .skipped)
        XCTAssertEqual(f.state(of: .sources, configured: true), .configured)
        f.back()
        f.next()
        XCTAssertEqual(f.state(of: .sources, configured: false), .pending)
        f.finish()
        XCTAssertTrue(f.finished)
    }
}
