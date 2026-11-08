import AppKit
import LeadGenCore
import LeadSearch
import Observation
import SwiftUI

// MARK: - Что нового

struct WhatsNewContent: Identifiable, Equatable {
    let id = UUID()
    let version: String
    let text: String
}

/// «Что нового в версии X.Y.Z?»: один раз для каждой установленной версии. Текст берётся из записи, сделанной перед
/// установкой (работает без сети), иначе из истории релизов на GitHub.
@MainActor
@Observable
final class WhatsNewController {
    static let shared = WhatsNewController()
    static let seenKey = "app.lastSeenVersion"

    var content: WhatsNewContent?
    private let defaults = UserDefaults.standard

    /// - Parameter existingInstall: на этом Mac уже были учётные записи до запуска (то есть это не первая установка).
    func evaluate(existingInstall: Bool) {
        guard content == nil, let current = UpdateController.shared.current else { return }
        switch WhatsNewPolicy.decide(lastSeen: defaults.string(forKey: Self.seenKey), current: current, hasExistingData: existingInstall) {
        case .none: return
        case .recordOnly: defaults.set(current.description, forKey: Self.seenKey)
        case .show:
            if let saved = InstalledNotes.decode(defaults.string(forKey: UpdateController.installedNotesKey), for: current),
               !saved.notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                content = WhatsNewContent(version: current.description, text: Updates.plainNotes(saved.notes))
                return
            }
            // Показываем сразу, описание подгружается: без сети будет ссылка на страницу релизов.
            content = WhatsNewContent(version: current.description, text: "")
            Task {
                let release = try? await Updates.fetchRelease(version: current, userAgent: "LeadGenerator/\(current) (macOS)")
                let text = Updates.plainNotes(release?.body ?? "")
                if content?.version == current.description { content = WhatsNewContent(version: current.description, text: text) }
            }
        }
    }

    /// Закрыто: запоминаем версию, чтобы больше не показывать, и убираем сохранённое описание.
    func dismiss() {
        if let c = content { defaults.set(c.version, forKey: Self.seenKey) }
        defaults.removeObject(forKey: UpdateController.installedNotesKey)
        content = nil
    }
}

struct WhatsNewSheet: View {
    let content: WhatsNewContent
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Что нового в версии \(content.version)?").font(.title2.weight(.semibold))
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    if content.text.isEmpty {
                        Text("Список изменений сейчас недоступен: нет подключения к интернету. Его можно прочитать на странице версий на GitHub.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(content.text.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
                            if line.isEmpty { Spacer().frame(height: 4) } else { Text(line).textSelection(.enabled) }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 160, maxHeight: 360)
            HStack {
                Link("Все версии на GitHub", destination: Updates.releasesPage)
                Spacer()
                Button("Закрыть", action: onClose).keyboardShortcut(.defaultAction)
            }
        }
        .padding(22)
        .frame(width: 520)
    }
}

// MARK: - Мастер первого запуска

/// Пошаговая настройка при первом входе: описание → источники → интеграции → диски → оформление.
/// Настройки применяются сразу теми же элементами, что и в «Настройках», уже подключённое видно как подключённое.
struct WelcomeView: View {
    let model: AppModel
    let onFinish: () -> Void
    @State private var flow = WelcomeFlow()
    @State private var drives: IntegrationsController?
    @State private var mail: MailController?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            stepBody
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            footer
        }
        .frame(maxWidth: 820, maxHeight: .infinity)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            if drives == nil { drives = IntegrationsController(user: model.username, inert: model.isInert) }
            if mail == nil { mail = MailController(user: model.username, inert: model.isInert) }
        }
        .onChange(of: flow.finished) { _, done in if done { onFinish() } }
        .accessibilityIdentifier("welcome-view")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(flow.position).font(.caption).foregroundStyle(.secondary)
                    Text(flow.step.title).font(.title2.weight(.semibold))
                }
                Spacer()
                Button("Пропустить всю настройку") { flow.finish() }
                    .buttonStyle(.link)
                    .help("Закрыть мастер и открыть главную страницу. Всё можно настроить позже в «Настройках».")
            }
            ProgressView(value: flow.progress)
                .accessibilityLabel("Прогресс первоначальной настройки")
            HStack(spacing: 14) {
                ForEach(WelcomeStep.allCases) { s in
                    HStack(spacing: 5) {
                        Image(systemName: s.rawValue < flow.step.rawValue ? "checkmark.circle.fill" : (s == flow.step ? "\(s.rawValue + 1).circle.fill" : "\(s.rawValue + 1).circle"))
                            .foregroundStyle(s.rawValue <= flow.step.rawValue ? Color.accentColor : Color.secondary)
                        Text(s.title).font(.caption).foregroundStyle(s == flow.step ? .primary : .secondary).lineLimit(1)
                    }
                }
            }
        }
        .padding(.horizontal, 24).padding(.vertical, 16)
    }

    private var footer: some View {
        HStack {
            if flow.canGoBack { Button("Назад") { flow.back() } }
            Spacer()
            if flow.canSkip { Button("Пропустить") { flow.skip() }.help("Перейти дальше, не настраивая этот шаг") }
            Button(flow.isLast ? "Готово — открыть главную" : "Далее") { flow.next() }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        }
        .padding(.horizontal, 24).padding(.vertical, 14)
    }

    @ViewBuilder private var stepBody: some View {
        switch flow.step {
        case .intro: intro
        case .sources: sources
        case .integrations: integrationsStep
        case .drives: drivesStep
        case .appearance: AppearanceSettingsView()
        }
    }

    private func configuredBanner(_ text: String) -> some View {
        Label(text, systemImage: "checkmark.seal.fill")
            .foregroundStyle(.green)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24).padding(.top, 10)
    }

    private func feature(_ icon: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon).font(.system(size: 22)).foregroundStyle(Color.accentColor).frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(text).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var intro: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Customers находит заказы и потенциальных клиентов в открытых источниках").font(.title3.weight(.semibold))
                Text("Пять коротких шагов — и всё готово к работе. Любой шаг можно пропустить, всё это есть и в «Настройках».").foregroundStyle(.secondary)
                feature("magnifyingglass", "Поиск лидов", "Биржи заказов, Telegram-каналы, сообщества и организации на карте. Приложение само проверяет источники по расписанию, в том числе в фоне.")
                feature("star.leadinghalf.filled", "Оценка и карточки", "Каждому лиду ставится оценка. В карточке — контакты, заметки и история действий.")
                feature("phone.bubble", "Связь одним нажатием", "Позвонить или написать из карточки, отправить лиды в Bitrix24, Notion или по вебхуку.")
                feature("icloud", "Облако и диски", "Одна учётная запись на Mac и Windows, резервные копии на Google Диск, Яндекс Диск, Dropbox, OneDrive и WebDAV.")
                feature("paintpalette", "Ваше оформление", "Светлая и тёмная тема, цвет акцента, масштаб. Меняется сразу.")
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var sourcesConfigured: Bool {
        let s = model.searchSettings
        return s.rss.enabled || s.telegram.enabled || s.vk.enabled || s.osm.enabled
    }

    private var sources: some View {
        @Bindable var model = model
        return VStack(spacing: 0) {
            if sourcesConfigured { configuredBanner("Источники уже включены. Можно оставить как есть или поменять.") }
            Form {
                Section("Где искать") {
                    Toggle("Ленты заказов (FL.ru и другие RSS)", isOn: $model.searchSettings.rss.enabled)
                    Toggle("Telegram-каналы (публичные)", isOn: $model.searchSettings.telegram.enabled)
                    Toggle("Организации на карте (OpenStreetMap)", isOn: $model.searchSettings.osm.enabled)
                    Toggle("Сообщества ВКонтакте (нужен бесплатный ключ VK)", isOn: $model.searchSettings.vk.enabled)
                }
                Section("Регионы для поиска организаций") {
                    TextField("Города через запятую", text: Binding(
                        get: { model.searchSettings.osm.regions.joined(separator: ", ") },
                        set: { model.searchSettings.osm.regions = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
                    ))
                    Text("Город или область, как они называются на карте. Подробности — в разделе «Источники».").font(.caption).foregroundStyle(.secondary)
                }
                Section("Автоматический поиск") {
                    Picker("Как часто", selection: $model.autoSearchMinutes) {
                        Text("Выключен").tag(0)
                        Text("Каждые 30 минут").tag(30)
                        Text("Каждый час").tag(60)
                        Text("Каждые 2 часа").tag(120)
                        Text("Каждые 6 часов").tag(360)
                        Text("Раз в сутки").tag(1440)
                    }
                }
            }
            .formStyle(.grouped)
        }
    }

    private var integrationsConfigured: Bool {
        (mail?.smtpReady ?? false) || [CRMKind.bitrix, .notion, .webhook].contains { model.crmSecret($0) != nil }
    }

    private var integrationsStep: some View {
        VStack(spacing: 0) {
            if integrationsConfigured { configuredBanner("Одна или несколько интеграций уже подключены. Повторно настраивать их не нужно.") }
            Form {
                Section("CRM и вебхуки") {
                    ForEach([ExportTab.bitrix, .notion, .webhook]) { tab in
                        HStack {
                            Image(systemName: tab.icon).frame(width: 22)
                            Text(tab.title)
                            Spacer()
                            if let kind = tab.crm, model.crmSecret(kind) != nil {
                                Label("Подключено", systemImage: "checkmark.circle.fill").foregroundStyle(.green).labelStyle(.titleAndIcon)
                            }
                            Button(tab.crm.flatMap { model.crmSecret($0) } != nil ? "Изменить" : "Подключить") { model.exportTab = tab }
                        }
                    }
                    Text("Лиды отправляются в выбранный сервис из списка: выделите их и выберите «Экспорт в…».").font(.caption).foregroundStyle(.secondary)
                }
                Section("Почта") {
                    HStack {
                        Image(systemName: "envelope").frame(width: 22)
                        Text((mail?.smtpReady ?? false) ? "Письма уходят прямо из приложения" : "Письма открываются в программе «Почта»")
                        Spacer()
                        Button((mail?.smtpReady ?? false) ? "Настроить" : "Подключить почту") {
                            MenuActions.openSettings(.outreach)
                        }
                    }
                }
            }
            .formStyle(.grouped)
        }
    }

    private var drivesStep: some View {
        VStack(spacing: 0) {
            if let drives, !drives.connections.isEmpty {
                configuredBanner("Уже подключено: \(drives.connections.keys.map { $0.title }.sorted().joined(separator: ", ")). Повторно входить не нужно.")
            }
            Form {
                Section("Облачные диски для резервных копий") {
                    if let drives {
                        DriveIntegrationsList(controller: drives, backupFile: { model.backupNow() })
                    }
                }
            }
            .formStyle(.grouped)
        }
    }
}

/// Нужен ли мастер: запись его не проходила и в ней ещё нет данных. Обжитую запись с прошлой версии отмечаем пройденной.
@MainActor
enum WelcomeGate {
    private static func key(_ model: AppModel) -> String { "welcome.done.\(model.username.lowercased())" }

    static func isNeeded(_ model: AppModel) -> Bool {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: key(model)) { return false }
        if !model.leads.isEmpty || model.lastReport != nil {
            defaults.set(true, forKey: key(model))
            return false
        }
        return true
    }

    static func markDone(_ model: AppModel) { UserDefaults.standard.set(true, forKey: key(model)) }
}
