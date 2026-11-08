import XCTest
@testable import LeadGenCore

final class WhatsNewDigestTests: XCTestCase {
    private func texts(_ features: [WhatsNewFeature]) -> [String] { features.flatMap(\.items) }

    func testTechnicalAndServiceLinesAreDropped() {
        let md = """
        ## Что изменилось
        - Обновили README и вики
        - Рефакторинг модуля поиска
        - Исправили тесты CI
        - Bump pillow from 12 to 13 by @dependabot in https://github.com/x/y/pull/42
        - Новое окно настроек с поиском по разделам

        **Full Changelog**: https://github.com/x/y/compare/v1...v2
        """
        let items = texts(WhatsNewDigest.build(md, platform: .macOS))
        XCTAssertEqual(items, ["Новое окно настроек с поиском по разделам"])
        XCTAssertFalse(items.joined().contains("github"))
    }

    func testOtherPlatformChangesAreHidden() {
        let md = """
        - Windows: значок в области уведомлений
        - macOS: боковая панель выезжает при наведении
        - Общий поиск стал быстрее
        - Мастер на Windows и macOS спрашивает регион
        """
        let mac = texts(WhatsNewDigest.build(md, platform: .macOS))
        let win = texts(WhatsNewDigest.build(md, platform: .windows))
        XCTAssertFalse(mac.contains { $0.lowercased().contains("значок в области") })
        XCTAssertTrue(mac.contains { $0.contains("боковая панель") })
        XCTAssertTrue(mac.contains { $0.contains("Общий поиск") })
        XCTAssertTrue(mac.contains { $0.contains("Мастер на Windows и macOS") })
        XCTAssertTrue(win.contains { $0.contains("значок в области") })
        XCTAssertFalse(win.contains { $0.contains("боковая панель") })
        XCTAssertTrue(win.contains { $0.contains("Мастер на Windows и macOS") })
    }

    func testPlatformSectionHeadingScopesItsBullets() {
        let md = """
        ## Windows
        - Адаптивная сетка карточек
        ## macOS
        - Новая иконка в строке меню
        """
        XCTAssertEqual(texts(WhatsNewDigest.build(md, platform: .macOS)), ["Новая иконка в строке меню"])
        XCTAssertEqual(texts(WhatsNewDigest.build(md, platform: .windows)), ["Адаптивная сетка карточек"])
    }

    func testInstallationSectionsAreServiceInformation() {
        let md = """
        ## Изменилось
        - Облегчённый режим при низком заряде
        ## Установка
        - Скачайте Customers-v1.dmg и перетащите в Программы
        """
        let items = texts(WhatsNewDigest.build(md, platform: .macOS))
        XCTAssertEqual(items.count, 1)
        XCTAssertTrue(items[0].contains("Облегчённый"))
    }

    func testBoldLeadBecomesShortPhraseWithoutMarkup() {
        let md = "- **Исключения.** Одно поле для домена, телефона и почты, формат определяется сам. Старые правила сохранены."
        let f = WhatsNewDigest.build(md, platform: .macOS)
        XCTAssertEqual(f.count, 1)
        XCTAssertEqual(f[0].items, ["Одно поле для домена, телефона и почты, формат определяется сам"])
        XCTAssertFalse(f[0].items[0].contains("*"))
    }

    func testBoldWordInsideSentenceKeepsWholePhrase() {
        let f = WhatsNewDigest.build("- **Быстрее** запуск приложения\n- **Окно.** Новое окно настроек", platform: .macOS)
        let items = texts(f)
        XCTAssertTrue(items.contains("Быстрее запуск приложения"), "\(items)")
        XCTAssertTrue(items.contains("Новое окно настроек"), "\(items)")
    }

    func testRelatedChangesAreGroupedUnderOneTopic() {
        let md = """
        - Адаптивное расположение элементов
        - Обновлённое окно настроек
        - Улучшенное поведение боковых панелей
        - Поиск по категориям OpenStreetMap стал богаче
        """
        let features = WhatsNewDigest.build(md, platform: .macOS)
        let ui = features.first { $0.topic == .interface }
        XCTAssertEqual(ui?.items.count, 3)
        XCTAssertEqual(ui?.title, "Улучшили и доработали интерфейс")
        XCTAssertEqual(features.first { $0.topic == .search }?.items.count, 1)
    }

    func testTopicsKeepFixedOrderAndLimitedItems() {
        var md = "- Энергосбережение: облегчённый режим при низком заряде\n"
        for i in 1...9 { md += "- Окно \(i) стало удобнее\n" }
        let features = WhatsNewDigest.build(md, platform: .macOS)
        XCTAssertEqual(features.map(\.topic), [.interface, .power])
        XCTAssertEqual(features[0].items.count, WhatsNewDigest.maxItemsPerTopic)
    }

    func testDuplicatesAreMergedAndLongTextIsShortened() {
        let long = String(repeating: "очень длинное описание ", count: 20)
        let md = "- Поиск стал быстрее\n- поиск стал быстрее\n- \(long)"
        let items = texts(WhatsNewDigest.build(md, platform: .macOS))
        XCTAssertEqual(items.filter { $0.lowercased() == "поиск стал быстрее" }.count, 1)
        XCTAssertTrue(items.allSatisfy { $0.count <= WhatsNewDigest.maxItemLength + 1 })
    }

    func testPreviewMatchesWhatTheFeatureDoes() {
        func preview(_ line: String) -> WhatsNewPreview? { WhatsNewDigest.build("- \(line)", platform: .macOS).first?.preview }
        XCTAssertEqual(preview("Одно поле для исключений"), .exclusions)
        XCTAssertEqual(preview("Облегчённый режим при низком заряде"), .power)
        XCTAssertEqual(preview("Больше категорий организаций на карте"), .categories)
        XCTAssertEqual(preview("Боковая панель раскрывается при наведении"), .sidebar)
        XCTAssertEqual(preview("Новое окно настроек"), .settings)
    }

    func testEmptyOrOnlyTechnicalNotesGiveNothing() {
        XCTAssertTrue(WhatsNewDigest.build("", platform: .macOS).isEmpty)
        XCTAssertTrue(WhatsNewDigest.build("- Обновили wiki\n- Рефакторинг", platform: .windows).isEmpty)
    }

    func testAutoGeneratedGitHubNotesAreCleaned() {
        let md = """
        ## What's Changed
        * Новая кнопка обновления с прогрессом by @xop1tt in https://github.com/xop1tt/Customers-App/pull/63
        **Full Changelog**: https://github.com/xop1tt/Customers-App/compare/v1.0.9...v1.1.0
        """
        let f = WhatsNewDigest.build(md, platform: .macOS)
        XCTAssertEqual(texts(f), ["Новая кнопка обновления с прогрессом"])
    }
}
