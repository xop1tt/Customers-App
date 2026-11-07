import SwiftUI
import XCTest
@testable import LeadGenerator

/// Состояние «обновление скачано»: от него зависит кнопка «Обновить» над учётной записью.
@MainActor
final class UpdateReadyTests: XCTestCase {
    func testReadyVersionOnlyInReadyPhase() {
        let updates = UpdateController.shared
        let saved = updates.phase
        defer { updates.phase = saved }
        let others: [UpdateController.Phase] = [.idle, .checking, .upToDate, .available("9.9.9"), .downloading, .installing, .failed("x")]
        for phase in others {
            updates.phase = phase
            XCTAssertNil(updates.readyVersion, "\(phase)")
        }
        updates.phase = .ready("1.2.3")
        XCTAssertEqual(updates.readyVersion, "1.2.3")
    }

    func testFooterRendersWithAndWithoutReadyUpdate() {
        let updates = UpdateController.shared
        let saved = updates.phase
        defer { updates.phase = saved }
        let model = AppModel(username: "ui-test", dataDirectory: FileManager.default.temporaryDirectory
            .appendingPathComponent("lg-ui-\(UUID().uuidString)"), inert: true)
        for phase in [UpdateController.Phase.idle, .ready("1.2.3")] {
            updates.phase = phase
            let host = NSHostingView(rootView: SidebarFooter(model: model, session: SessionModel.shared,
                                                             look: AppearanceSettings.shared))
            host.frame = CGRect(x: 0, y: 0, width: 260, height: 100)
            host.layoutSubtreeIfNeeded()
            XCTAssertGreaterThan(host.fittingSize.height, 0)
        }
    }
}
