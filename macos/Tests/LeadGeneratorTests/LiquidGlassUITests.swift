import AppKit
import SwiftUI
import XCTest
import LeadGenCore
@testable import LeadGenerator

/// Настройки во всплывающем окне, настройка боковой панели на месте и элементы Liquid Glass.
@MainActor
final class LiquidGlassUITests: XCTestCase {
    private var directory: URL!
    private var model: AppModel!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("lg-glass-\(UUID().uuidString)")
        model = AppModel(username: "glass-test", dataDirectory: directory, inert: true)
        suite = "lg-glass-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: directory)
        SettingsPresenter.shared.dismiss()
    }

    @discardableResult
    private func lay<V: View>(_ view: V, size: CGSize) -> NSHostingView<V> {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        return host
    }

    private func withEnvironment<V: View>(_ view: V, look: AppearanceSettings = .shared) -> some View {
        view.environment(\.appModel, model)
            .environment(\.look, look)
            .environment(\.session, SessionModel.shared)
    }

    // MARK: Настройки поверх окна

    func testOverlaySizeIsLargeCenteredAndKeepsMargins() {
        for container in [CGSize(width: 980, height: 620), CGSize(width: 1440, height: 900), CGSize(width: 2560, height: 1440)] {
            let s = SettingsOverlayLayout.size(in: container)
            XCTAssertLessThanOrEqual(s.width, container.width - SettingsOverlayLayout.margin * 2, "\(container)")
            XCTAssertLessThanOrEqual(s.height, container.height - SettingsOverlayLayout.margin * 2, "\(container)")
            XCTAssertLessThanOrEqual(s.width, SettingsOverlayLayout.maxSize.width)
            XCTAssertLessThanOrEqual(s.height, SettingsOverlayLayout.maxSize.height)
            XCTAssertGreaterThanOrEqual(s.width, SettingsOverlayLayout.minSize.width, "в минимальном окне приложения настройки не тесные")
            XCTAssertGreaterThanOrEqual(s.height, SettingsOverlayLayout.minSize.height)
        }
        let typical = SettingsOverlayLayout.size(in: CGSize(width: 1440, height: 900))
        XCTAssertGreaterThan(typical.width, 920, "больше прежнего отдельного окна (920×660)")
        XCTAssertGreaterThan(typical.height, 660)
    }

    func testOverlaySizeNeverNegativeInTinyContainer() {
        let s = SettingsOverlayLayout.size(in: CGSize(width: 40, height: 30))
        XCTAssertGreaterThanOrEqual(s.width, 0)
        XCTAssertGreaterThanOrEqual(s.height, 0)
    }

    func testPresenterShowsAndHides() {
        let p = SettingsPresenter.shared
        p.dismiss()
        XCTAssertFalse(p.shown)
        p.present()
        XCTAssertTrue(p.shown)
        p.present()
        XCTAssertTrue(p.shown, "повторное открытие не закрывает")
        p.dismiss()
        XCTAssertFalse(p.shown)
    }

    func testOverlayRendersEverySectionWithAndWithoutLightMode() {
        let saved = UserDefaults.standard.string(forKey: "settings.section")
        defer { UserDefaults.standard.set(saved, forKey: "settings.section") }
        for section in SettingsSection.allCases {
            UserDefaults.standard.set(section.rawValue, forKey: "settings.section")
            lay(withEnvironment(SettingsOverlay(presenter: .shared)), size: CGSize(width: 1440, height: 900))
            lay(SettingsOverlay(presenter: .shared), size: CGSize(width: 980, height: 620))
        }
    }

    func testRootViewRendersWithSettingsOpen() {
        SettingsPresenter.shared.present()
        lay(withEnvironment(RootView()), size: CGSize(width: 1200, height: 760))
        SettingsPresenter.shared.dismiss()
    }

    // MARK: Настройка боковой панели

    func testEditingIsADraftUntilDone() {
        defaults.set("runs", forKey: SidebarKeys.hidden)
        let e = SidebarEditModel(defaults: defaults)
        e.begin()
        XCTAssertTrue(e.editing)
        XCTAssertEqual(e.hidden, ["runs"], "черновик начинается с сохранённого")
        e.setVisible(.runs, true)
        e.setVisible(.archive, false)
        e.showCounts = false
        e.cancel()
        XCTAssertFalse(e.editing)
        XCTAssertEqual(defaults.string(forKey: SidebarKeys.hidden), "runs", "«Отменить» ничего не сохраняет")
        XCTAssertNil(defaults.object(forKey: SidebarKeys.counts))

        e.begin()
        XCTAssertEqual(e.hidden, ["runs"], "после отмены черновик снова из сохранённого")
        e.setVisible(.runs, true)
        e.setVisible(.archive, false)
        e.showCounts = false
        e.commit()
        XCTAssertFalse(e.editing)
        XCTAssertEqual(SidebarPrefs.parse(hidden: defaults.string(forKey: SidebarKeys.hidden) ?? ""), ["archive"])
        XCTAssertEqual(defaults.object(forKey: SidebarKeys.counts) as? Bool, false)
    }

    func testReorderStaysInsideCategory() {
        let e = SidebarEditModel(defaults: defaults)
        e.begin()
        XCTAssertEqual(e.sections(SidebarKeys.mainGroup), SidebarKeys.mainGroup)
        e.move(in: SidebarKeys.workGroup, from: [3], to: 0)
        XCTAssertEqual(e.sections(SidebarKeys.workGroup), [.excluded, .sources, .runs, .archive])
        e.move(in: SidebarKeys.mainGroup, from: [0], to: 4)
        XCTAssertEqual(e.sections(SidebarKeys.mainGroup), [.all, .new, .favorites, .home])
        XCTAssertEqual(e.sections(SidebarKeys.workGroup), [.excluded, .sources, .runs, .archive], "другая категория не сдвинулась")
        e.commit()

        let again = SidebarEditModel(defaults: defaults)
        again.begin()
        XCTAssertEqual(again.sections(SidebarKeys.mainGroup), [.all, .new, .favorites, .home], "порядок сохранился")
        XCTAssertEqual(again.sections(SidebarKeys.workGroup), [.excluded, .sources, .runs, .archive])
    }

    func testCategoriesCoverEveryNavSectionOnce() {
        let all = SidebarKeys.mainGroup + SidebarKeys.workGroup
        XCTAssertEqual(Set(all), Set(NavSection.allCases))
        XCTAssertEqual(all.count, NavSection.allCases.count)
        XCTAssertFalse(SidebarKeys.configurable.contains(.all), "«Все лиды» не скрывается")
    }

    func testSourcesReorderAndHide() {
        let e = SidebarEditModel(defaults: defaults)
        e.begin()
        let all = ["rss", "telegram", "osm"]
        e.moveSources(all, from: [2], to: 0)
        XCTAssertEqual(e.sources(all), ["osm", "rss", "telegram"])
        e.setSourceVisible("rss", false)
        e.commit()
        XCTAssertEqual(defaults.string(forKey: SidebarKeys.sourceOrder), "osm,rss,telegram")
        XCTAssertEqual(defaults.string(forKey: SidebarKeys.hiddenSources), "rss")
        XCTAssertEqual(e.sources(all + ["vk"]), ["osm", "rss", "telegram", "vk"], "новый источник — в конце")
    }

    func testSidebarRendersInEditMode() {
        let shared = SidebarEditModel.shared
        shared.begin()
        defer { shared.cancel() }
        lay(withEnvironment(SidebarView()), size: CGSize(width: 260, height: 700))
        lay(SidebarView(), size: CGSize(width: 260, height: 700))
        lay(SidebarFooter(model: model, session: SessionModel.shared, look: AppearanceSettings.shared), size: CGSize(width: 260, height: 100))
    }

    // MARK: Элементы Liquid Glass

    func testGlassControlsRenderInNormalAndLightMode() {
        let look = AppearanceSettings()
        let controls = VStack {
            Button("Обычная") {}.buttonStyle(.pill)
            Button("Главная") {}.buttonStyle(.pillProminent)
            Button("Удалить") {}.buttonStyle(.pillDestructive)
            Button("Форма") {}.prominentGlassButton()
            Button("Стекло") {}.glassButton()
            Toggle("Переключатель", isOn: .constant(true)).toggleStyle(.glassSwitch)
            Toggle("", isOn: .constant(false)).labelsHidden().toggleStyle(.glassSwitch).controlSize(.mini)
            GlassGroup { Text("Группа").padding().glassBackground() }
            Text("Панель").padding().glassPanel(RoundedRectangle(cornerRadius: LiquidGlass.panelRadius))
            Toast(text: "Готово", isError: false) {}
        }
        let host = lay(controls.environment(\.look, look), size: CGSize(width: 400, height: 600))
        XCTAssertGreaterThan(host.fittingSize.width, 0)
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            host.appearance = NSAppearance(named: appearance)
            host.layoutSubtreeIfNeeded()
        }
    }

    func testAccentColorsStayDistinctAndOpaque() {
        let colors = AccentChoice.allCases.compactMap { NSColor($0.color).usingColorSpace(.sRGB) }
        XCTAssertEqual(colors.count, AccentChoice.allCases.count)
        for c in colors { XCTAssertEqual(c.alphaComponent, 1, accuracy: 0.001) }
        let keys = Set(colors.map { "\(Int($0.redComponent * 20))-\(Int($0.greenComponent * 20))-\(Int($0.blueComponent * 20))" })
        XCTAssertEqual(keys.count, colors.count, "схемы различимы")
    }
}
