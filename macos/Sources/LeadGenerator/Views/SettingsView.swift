import AppKit
import LeadGenCore
import LeadSearch
import SwiftUI
import UniformTypeIdentifiers

/// Разделы настроек. Порядок и значения не меняются: по ним хранится выбранный раздел.
enum SettingsSection: String, CaseIterable, Identifiable {
    case appearance, search, account, data, exclusions, outreach, reports, updates
    var id: String { rawValue }
    var title: String {
        switch self {
        case .appearance: return "Внешний вид"
        case .search: return "Поиск"
        case .account: return "Учётная запись"
        case .data: return "Данные"
        case .exclusions: return "Исключения"
        case .outreach: return "Обращения"
        case .reports: return "Отчёты"
        case .updates: return "Обновления"
        }
    }
    var icon: String {
        switch self {
        case .appearance: return "paintpalette"
        case .search: return "magnifyingglass"
        case .account: return "person.crop.circle"
        case .data: return "externaldrive"
        case .exclusions: return "nosign"
        case .outreach: return "text.bubble"
        case .reports: return "ladybug"
        case .updates: return "arrow.down.circle"
        }
    }

    /// Раздел левого списка.
    var group: String {
        switch self {
        case .appearance, .updates: return "Приложение"
        case .search, .exclusions, .outreach: return "Работа с лидами"
        case .account, .data: return "Учётная запись и данные"
        case .reports: return "Поддержка"
        }
    }

    static let groups = ["Приложение", "Работа с лидами", "Учётная запись и данные", "Поддержка"]

    var subtitle: String {
        switch self {
        case .appearance: return "Тема, цвет, шрифты, масштаб и облегчённый режим"
        case .search: return "Как часто приложение проверяет источники и что делает в фоне"
        case .account: return "Профиль, вход и пароль"
        case .data: return "База, резервные копии, облачные диски и перенос"
        case .exclusions: return "Домены, телефоны, почта и названия, которые не нужно показывать"
        case .outreach: return "Почта для отправки писем из карточки лида"
        case .reports: return "Отчёты о сбоях и обратная связь"
        case .updates: return "Версия приложения и автоматические обновления"
        }
    }

    /// Слова, по которым раздел находится в поиске по настройкам.
    var keywords: String {
        switch self {
        case .appearance: return "тема светлая тёмная цвет акцент схема шрифт масштаб плотность энергосбережение батарея заряд облегчённый режим анимации"
        case .search: return "проверка источников расписание фон меню автоматически"
        case .account: return "пользователь пароль выйти вход облако синхронизация"
        case .data: return "база резервная копия диск google dropbox onedrive яндекс webdav перенос папка"
        case .exclusions: return "исключения домен телефон email почта название импорт csv"
        case .outreach: return "почта smtp письма черновик отправка"
        case .reports: return "сбой отчёт вылет ошибка"
        case .updates: return "обновление версия скачивание проверка"
        }
    }

    func matches(_ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: "ё", with: "е")
        if q.isEmpty { return true }
        let hay = (title + " " + subtitle + " " + keywords).lowercased().replacingOccurrences(of: "ё", with: "е")
        return q.split(separator: " ").allSatisfy { hay.contains($0) }
    }
}

/// Окно настроек: слева поиск и разделы по группам, справа крупный заголовок и страница.
struct SettingsView: View {
    @AppStorage("settings.section") private var selectedRaw = SettingsSection.appearance.rawValue
    @Environment(\.look) private var look
    @State private var query = ""

    private var selected: SettingsSection { SettingsSection(rawValue: selectedRaw) ?? .appearance }
    private var found: [SettingsSection] { SettingsSection.allCases.filter { $0.matches(query) } }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 236 * min(look.scale, 1.15))
                .background(sidebarBackground)
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                header
                detail
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .id(selected)
                    .transition(.opacity)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(nsColor: .windowBackgroundColor))
            .animation(look.animation(.easeInOut(duration: 0.18)), value: selected)
        }
        .frame(minWidth: 820, idealWidth: 920, minHeight: 560, idealHeight: 660)
        .background(SettingsWindowChrome())
    }

    /// Полупрозрачная подложка списка; в облегчённом режиме — сплошная.
    @ViewBuilder private var sidebarBackground: some View {
        if look.lightMode {
            Color(nsColor: .controlBackgroundColor)
        } else {
            Rectangle().fill(.thinMaterial)
        }
    }

    // MARK: Левый список

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary).font(.system(size: 12))
                TextField("", text: $query, prompt: Text("Поиск по настройкам"))
                    .textFieldStyle(.plain)
                    .labelsHidden()
                    .accessibilityLabel("Поиск по настройкам")
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .accessibilityLabel("Очистить поиск")
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.primary.opacity(0.06)))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
            .padding(.horizontal, 12).padding(.top, 44).padding(.bottom, 10)

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if found.isEmpty {
                        Text("Ничего не найдено")
                            .font(.system(size: 12.5)).foregroundStyle(.secondary)
                            .padding(.horizontal, 20).padding(.top, 8)
                    }
                    ForEach(SettingsSection.groups, id: \.self) { group in
                        let items = found.filter { $0.group == group }
                        if !items.isEmpty {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(group).font(.system(size: 11.5, weight: .medium)).foregroundStyle(.secondary)
                                    .padding(.horizontal, 20).padding(.bottom, 3)
                                ForEach(items) { s in
                                    SettingsNavRow(section: s, selected: s == selected) { selectedRaw = s.rawValue }
                                }
                            }
                        }
                    }
                }
                .padding(.bottom, 16)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(selected.title).font(.system(size: 26 * look.scale, weight: .bold))
            Text(selected.subtitle).font(.system(size: 13.5 * look.scale)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: 680, alignment: .leading)
        .padding(.horizontal, 32).padding(.top, 40).padding(.bottom, 18)
        .frame(maxWidth: .infinity, alignment: .center)
    }

    @ViewBuilder
    private var detail: some View {
        switch selected {
        case .appearance: AppearanceSettingsView()
        case .search: SearchSettingsView()
        case .account: AccountSettingsView()
        case .data: DataSettingsView()
        case .exclusions: ExclusionsSettingsView()
        case .outreach: OutreachSettingsView()
        case .reports: ReportSettingsView()
        case .updates: UpdateSettingsView()
        }
    }
}

private struct SettingsNavRow: View {
    @Environment(\.look) private var look
    let section: SettingsSection
    let selected: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: section.icon).font(.system(size: 14 * look.scale)).frame(width: 20)
                    .foregroundStyle(selected ? look.accentColor : .secondary)
                Text(section.title).font(.system(size: 13.5 * look.scale, weight: selected ? .semibold : .regular))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(selected ? Color.primary.opacity(0.1) : (hover ? Color.primary.opacity(0.05) : .clear)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 10)
        .onHover { hover = $0 }
        .accessibilityLabel(section.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Внешний вид

struct AppearanceSettingsView: View {
    @Environment(\.look) private var look
    @State private var allFonts: [String] = []

    var body: some View {
        @Bindable var look = look
        SettingsPage {
            SettingsGroup(title: "Тема") {
                SettingBlock(title: "Тема оформления", detail: "Светлая, тёмная или как настроено в macOS") {
                    HStack(spacing: 14) {
                        ForEach(ThemeMode.allCases) { mode in
                            ThemeTile(mode: mode, selected: look.theme == mode) { look.theme = mode }
                        }
                    }
                }
                RowDivider()
                SettingRow(title: "Цветовая схема", detail: "Цвет кнопок, выделения и переключателей. «Как в системе» берёт цвет из настроек macOS") {
                    MenuPicker(selection: $look.accentSelection) {
                        Label { Text("Как в системе") } icon: { AccentSwatch(choice: nil) }.tag(AccentChoice?.none)
                        Divider()
                        ForEach(AccentChoice.allCases) { a in
                            Label { Text(a.title) } icon: { AccentSwatch(choice: a) }.tag(AccentChoice?.some(a))
                        }
                    }
                }
            }
            SettingsGroup(title: "Шрифты", footer: "Показаны шрифты, установленные на этом Mac. Новый шрифт можно добавить через «Шрифты» в macOS.") {
                SettingRow(title: "Шрифт интерфейса") {
                    MenuPicker(selection: $look.fontFamily) {
                        Text("Системный (SF Pro)").tag(AppearanceSettings.systemFont)
                        let rec = AppearanceSettings.recommended.filter { allFonts.contains($0) }
                        if !rec.isEmpty {
                            Divider()
                            ForEach(rec, id: \.self) { Text($0).font(.custom($0, size: 13)).tag($0) }
                        }
                        Divider()
                        ForEach(allFonts.filter { !AppearanceSettings.recommended.contains($0) }, id: \.self) { Text($0).tag($0) }
                    }
                }
                RowDivider()
                SettingRow(title: "Моноширинный шрифт", detail: "Журналы и технические данные") {
                    MenuPicker(selection: $look.monoFamily) {
                        Text("Системный (SF Mono)").tag(AppearanceSettings.systemFont)
                        ForEach(AppearanceSettings.recommendedMono.filter { allFonts.contains($0) }, id: \.self) { Text($0).tag($0) }
                    }
                }
            }
            SettingsGroup(title: "Масштаб и плотность") {
                SettingBlock(title: "Масштаб интерфейса", detail: "Сочетания клавиш: ⌘+  ⌘−  ⌘0") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("А").font(.system(size: 11))
                            Slider(value: $look.scale, in: AppearanceSettings.scaleRange, step: 0.05)
                            Text("А").font(.system(size: 18))
                            Text("\(Int((look.scale * 100).rounded()))%")
                                .monospacedDigit().frame(width: 48, alignment: .trailing)
                        }
                        HStack(spacing: 8) {
                            ForEach([0.9, 1.0, 1.1, 1.25, 1.5], id: \.self) { v in
                                Button("\(Int(v * 100))%") { look.scale = v }
                                    .buttonStyle(PillButtonStyle(kind: abs(look.scale - v) < 0.01 ? .prominent : .regular))
                            }
                        }
                    }
                }
                RowDivider()
                SettingRow(title: "Плотность строк") {
                    Picker("", selection: $look.density) {
                        ForEach(Density.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented).labelsHidden().fixedSize()
                }
            }
            LightModeGroup()
            SettingsGroup(title: "Предпросмотр") {
                PreviewRow().padding(.vertical, 12)
            }
        }
        .onAppear { allFonts = AppearanceSettings.installedFamilies }
    }
}

/// Облегчённый режим: когда включается, при каком заряде и что именно отключается.
private struct LightModeGroup: View {
    @Environment(\.look) private var look

    var body: some View {
        @Bindable var look = look
        SettingsGroup(title: "Облегчённый режим",
                      footer: "В облегчённом режиме отключаются анимации и прозрачность, остальное работает как обычно: поиск, список лидов и все кнопки на месте.") {
            SettingRow(title: "Включать автоматически", detail: "При режиме энергосбережения macOS или низком заряде батареи") {
                Toggle("", isOn: $look.lightModeAuto).labelsHidden().toggleStyle(.switch)
            }
            RowDivider()
            SettingRow(title: "Порог заряда", detail: "Ниже этого заряда (если Mac не на зарядке) включится облегчённый режим") {
                MenuPicker(selection: $look.lightModeThreshold) {
                    ForEach(Array(stride(from: 10, through: 50, by: 5)), id: \.self) { Text("\($0)%").tag($0) }
                }
                .disabled(!look.lightModeAuto)
            }
            RowDivider()
            statusRow
        }
    }

    private var statusRow: some View {
        SoftCard(tint: look.lightMode ? .green : nil) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: look.lightMode ? "leaf.fill" : "bolt.fill")
                    .foregroundStyle(look.lightMode ? Color.green : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(look.lightMode ? "Сейчас включён" : "Сейчас выключен").font(.system(size: 13, weight: .semibold))
                    Text(look.lightModeReason?.explanation ?? currentPowerText)
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 12)
    }

    private var currentPowerText: String {
        if let p = look.power.batteryPercent {
            return "Заряд батареи: \(p)%\(look.power.charging == true ? ", идёт зарядка" : ""). Режим энергосбережения системы выключен."
        }
        return "Сведений о батарее нет, учитывается только режим энергосбережения системы."
    }
}

// MARK: - Поиск

struct SearchSettingsView: View {
    @Environment(\.appModel) private var model
    @AppStorage(BackgroundMode.key) private var keepRunning = true

    var body: some View {
        @Bindable var model = model
        SettingsPage {
            SoftCard {
                Text("Поиск идёт прямо на этом Mac: приложение само обращается к источникам, без GitHub и без своего сервера. Источники, ключевые слова, каналы и регионы настраиваются в разделе «Источники».")
                    .font(.system(size: 12.5)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            SettingsGroup(title: "Автоматически",
                          footer: "Проверяются только те источники, у которых подошёл их интервал. «Проверить сейчас» и кнопка «Найти лиды» проверяют все включённые источники сразу.") {
                SettingRow(title: "Проверять источники") {
                    MenuPicker(selection: $model.autoSearchMinutes) {
                        Text("Выключено").tag(0)
                        Text("Каждые 15 минут").tag(15)
                        Text("Каждые 30 минут").tag(30)
                        Text("Каждый час").tag(60)
                        Text("Каждые 3 часа").tag(180)
                    }
                }
                RowDivider()
                SettingRow(title: model.searching ? "Идёт поиск" : "Проверить сейчас",
                           detail: model.lastSearchAt.map { "Последний поиск: \($0.fullRu)" }) {
                    HStack(spacing: 8) {
                        if model.searching { ProgressView().controlSize(.small) }
                        Button(model.searching ? "Остановить поиск" : "Проверить сейчас") {
                            if model.searching { model.stopSearch() } else { model.runSearch() }
                        }
                        .buttonStyle(.pill)
                    }
                }
            }
            SettingsGroup(title: "После закрытия окна",
                          footer: keepRunning
                              ? "Если закрыть окно, приложение остаётся в строке меню и продолжает искать лиды по расписанию. Открыть окно или завершить работу можно через значок в строке меню."
                              : "Закрытие окна завершает приложение, поиск по расписанию останавливается.") {
                SettingRow(title: "Продолжать работу в фоне") {
                    Toggle("", isOn: $keepRunning).labelsHidden().toggleStyle(.switch)
                }
            }
        }
    }
}

// MARK: - Учётная запись

struct AccountSettingsView: View {
    @Environment(\.appModel) private var model
    @Environment(\.session) private var session
    @State private var old = ""
    @State private var new = ""
    @State private var again = ""
    @State private var result: String?
    @State private var ok = false

    var body: some View {
        if model.isCloud { CloudAccountSettingsView() } else { localPage }
    }

    private var localPage: some View {
        SettingsPage {
            SettingsGroup(title: "Профиль") {
                HStack(spacing: 14) {
                    Text(String(model.displayName.first.map { String($0) } ?? "?").uppercased())
                        .font(.system(size: 26, weight: .medium)).foregroundStyle(.secondary)
                        .frame(width: 60, height: 60)
                        .background(Circle().fill(.quaternary))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.displayName).font(.system(size: 16, weight: .semibold))
                        Text("Локальная учётная запись, только этот Mac").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 14)
                RowDivider()
                SettingRow(title: "Запомнить вход на этом Mac", detail: "Не спрашивать пароль при следующем запуске") {
                    Toggle("", isOn: Binding(get: { session.remembered }, set: { session.setRemembered($0) }))
                        .labelsHidden().toggleStyle(.switch)
                }
                RowDivider()
                SettingRow(title: "Выйти из учётной записи") {
                    Button("Выйти") { session.logout() }.buttonStyle(.pill)
                }
            }
            SettingsGroup(title: "Смена пароля") {
                VStack(alignment: .leading, spacing: 10) {
                    passwordField("Текущий пароль", $old)
                    passwordField("Новый пароль", $new, prompt: "не меньше 8 символов")
                    passwordField("Повторите новый пароль", $again)
                    HStack {
                        Button("Сменить пароль") {
                            result = session.changePassword(old: old, new: new, confirm: again)
                            ok = result == nil
                            if ok { old = ""; new = ""; again = "" }
                        }
                        .buttonStyle(.pillProminent)
                        .disabled(old.isEmpty || new.isEmpty)
                        if ok { Label("Пароль изменён", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
                    }
                    if let result { Text(result).font(.caption).foregroundStyle(.red) }
                }
                .padding(.vertical, 12)
            }
            SoftCard {
                Text("Учётные записи сейчас хранятся только на этом Mac, у каждого пользователя своя база лидов и свои настройки поиска. Восстановить забытый пароль нельзя — делайте резервные копии базы.")
                    .font(.system(size: 12.5)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func passwordField(_ title: String, _ text: Binding<String>, prompt: String = "") -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.callout)
            SecureField("", text: text, prompt: Text(prompt))
                .labelsHidden()
                .accessibilityLabel(title)
                .inputField()
                .frame(maxWidth: 320)
        }
    }
}

// MARK: - Данные

struct DataSettingsView: View {
    @Environment(\.appModel) private var model
    @State private var backups: [URL] = []
    @State private var integrations: IntegrationsController?

    var body: some View {
        @Bindable var model = model
        Form {
            Section("База данных") {
                LabeledContent("Расположение") {
                    Text(model.databasePath.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                        .textSelection(.enabled).lineLimit(2).truncationMode(.middle)
                }
                LabeledContent("Размер", value: ByteCountFormatter.string(fromByteCount: model.databaseSize, countStyle: .file))
                LabeledContent("Лидов", value: "\(model.leads.count)")
                HStack {
                    Button("Показать в Finder") {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: model.databasePath)])
                    }
                    Button("Перенести в другую папку…") {
                        if let dir = chooseFolder() { model.moveDatabase(to: dir) }
                    }
                    .disabled(model.searching)
                }
                Text("База и настройки лежат отдельно от программы: обновление приложения их не удаляет.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Резервные копии") {
                Toggle("Делать копию раз в сутки при запуске", isOn: $model.autoBackup)
                Stepper("Хранить копий: \(model.keepBackups)", value: $model.keepBackups, in: 1...60)
                LabeledContent("Папка") {
                    Text(model.backupDirectory.replacingOccurrences(of: NSHomeDirectory(), with: "~")).lineLimit(1).truncationMode(.middle)
                }
                HStack {
                    Button("Изменить папку…") { if let d = chooseFolder() { model.backupDirectory = d.path } }
                    Button("Создать копию сейчас") { model.backupNow(); backups = model.backups() }
                    Button("Восстановить из файла…") {
                        let p = NSOpenPanel()
                        p.allowedContentTypes = [UTType(filenameExtension: "db") ?? .data]
                        if p.runModal() == .OK, let url = p.url { model.restore(from: url) }
                    }
                    .disabled(model.searching)
                }
                ForEach(backups.prefix(8), id: \.self) { url in
                    HStack {
                        Image(systemName: "archivebox").foregroundStyle(.secondary)
                        Text(url.lastPathComponent).font(.callout)
                        Spacer()
                        Button("Восстановить") { model.restore(from: url) }.disabled(model.searching)
                    }
                }
            }
            CloudBackupSection()
            // Те же диски, что в «Интеграциях» меню учётной записи: подключение по кнопке.
            Section("Подключить облачный диск") {
                if let integrations {
                    DriveIntegrationsList(controller: integrations, backupFile: {
                        let url = model.backupNow()
                        backups = model.backups()
                        return url
                    })
                }
            }
            Section("Перенос на другой Mac") {
                Text("Скопируйте файл базы (или любую резервную копию) на новый Mac и выберите его в «Восстановить из файла…». Ключ VK в копию не попадает — введите его заново в разделе «Источники».")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
        .settingsForm()
        .onAppear {
            backups = model.backups()
            if integrations?.user != model.username {
                integrations = IntegrationsController(user: model.username, inert: model.isInert)
            }
        }
    }

    private func chooseFolder() -> URL? {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.canCreateDirectories = true
        return p.runModal() == .OK ? p.url : nil
    }
}

// MARK: - Исключения

struct ExclusionsSettingsView: View {
    @Environment(\.appModel) private var model
    @State private var value = ""

    private var trimmed: String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Как приложение поймёт введённое значение (показывается под полем).
    private var detected: String {
        guard !trimmed.isEmpty else { return "Домен, телефон, email или название организации: формат определится сам" }
        return "Будет добавлено как: \((ExclusionKind.detect(trimmed) ?? .name).title.lowercased())"
    }

    var body: some View {
        SettingsPage {
            SettingsGroup(title: "Добавить исключение", footer: "Из файла берутся все ячейки с email, телефонами и доменами. Такие лиды попадают в раздел «Исключённые» и не мешают в общем списке.") {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        TextField("", text: $value, prompt: Text("example.ru, +7 843 000-00-00, name@mail.ru или название"))
                            .labelsHidden()
                            .accessibilityLabel("Значение исключения")
                            .inputField()
                            .onSubmit(add)
                        Button("Добавить", action: add).buttonStyle(.pillProminent).disabled(trimmed.isEmpty)
                    }
                    Text(detected).font(.system(size: 12)).foregroundStyle(.secondary)
                }
                .padding(.vertical, 12)
                RowDivider()
                SettingRow(title: "Импорт базы своих клиентов", detail: "CSV или текстовый файл") {
                    Button("Выбрать файл…") {
                        let p = NSOpenPanel()
                        p.allowedContentTypes = [.commaSeparatedText, .plainText]
                        if p.runModal() == .OK, let url = p.url { model.importExclusions(from: url) }
                    }
                    .buttonStyle(.pill)
                }
            }
            SettingsGroup(title: "Правила: \(model.exclusions.count)") {
                if model.exclusions.isEmpty {
                    Text("Исключений нет").foregroundStyle(.secondary).padding(.vertical, 12)
                }
                ForEach(model.exclusions) { e in
                    HStack {
                        Text(e.kind.title).foregroundStyle(.secondary).frame(width: 90, alignment: .leading)
                        Text(e.value).textSelection(.enabled)
                        Spacer()
                        Button { model.removeExclusion(e.id) } label: { Image(systemName: "trash") }
                            .buttonStyle(.borderless).help("Убрать из исключений")
                    }
                    .padding(.vertical, 8)
                    RowDivider()
                }
            }
        }
    }

    private func add() {
        guard !trimmed.isEmpty else { return }
        model.exclude(trimmed)
        value = ""
    }
}

// MARK: - Обращения

struct OutreachSettingsView: View {
    @Environment(\.appModel) private var model
    @State private var mail: MailController?

    var body: some View {
        Form {
            if let mail { MailSettingsSection(mail: mail) }
            Section {
                Text("Черновики собираются по шаблонам из проверенных фактов о лиде, без внешних AI-сервисов. Отправляете вы сами: массовой рассылки в приложении нет и не будет.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
        .settingsForm()
        .onAppear {
            if mail?.user != model.username.lowercased() { mail = MailController(user: model.username, inert: model.isInert) }
        }
    }
}

private struct ThemeTile: View {
    let mode: ThemeMode
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                ZStack {
                    switch mode {
                    case .light: mini(bg: .white, side: Color(white: 0.95), fg: Color(white: 0.85))
                    case .dark: mini(bg: Color(white: 0.11), side: Color(white: 0.16), fg: Color(white: 0.3))
                    case .system:
                        HStack(spacing: 0) {
                            mini(bg: .white, side: Color(white: 0.95), fg: Color(white: 0.85))
                            mini(bg: Color(white: 0.11), side: Color(white: 0.16), fg: Color(white: 0.3))
                        }
                    }
                }
                .frame(width: 120, height: 74)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? Color.accentColor : Color.gray.opacity(0.3), lineWidth: selected ? 2.5 : 1))
                Text(mode.title).font(.callout).foregroundStyle(selected ? .primary : .secondary)
            }
        }
        .buttonStyle(.plain)
    }

    private func mini(bg: Color, side: Color, fg: Color) -> some View {
        HStack(spacing: 0) {
            side.frame(maxWidth: 30)
            VStack(alignment: .leading, spacing: 5) {
                ForEach(0..<4, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 2).fill(i == 0 ? Color.accentColor.opacity(0.8) : fg).frame(height: 5)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(bg)
        }
    }
}

private struct PreviewRow: View {
    @Environment(\.look) private var look
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "star.fill").foregroundStyle(.yellow)
            VStack(alignment: .leading, spacing: 2) {
                Text("Студия красоты «Лаванда»").appFont(13, .medium)
                Text("Организация · ул. Баумана, 44 · Казань").appFont(11.5).foregroundStyle(.secondary)
            }
            Spacer()
            Tag(text: "Нет сайта", color: .red)
            ScoreView(score: 84)
        }
        .padding(.vertical, look.density.rowPadding * look.scale + 4)
        .padding(.horizontal, 10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(0.08)))
        .tint(look.accentColor)
    }
}

