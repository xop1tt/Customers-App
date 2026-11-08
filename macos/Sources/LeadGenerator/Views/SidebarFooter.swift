import AppKit
import LeadGenCore
import SwiftUI

/// Нижняя строка боковой панели: учётная запись (меню по нажатию на имя) и справка «?».
struct SidebarFooter: View {
    let model: AppModel
    let session: SessionModel
    let look: AppearanceSettings
    @Environment(\.openSettings) private var openSettings
    @State private var accountShown = false
    @State private var helpShown = false
    @State private var integrationsShown = false
    @State private var customizeShown = false
    @State private var updates = UpdateController.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Кнопка «Обновить» одна на все состояния обновления и появляется, только когда есть что делать.
            updateButton
            // Настройка панели стоит выше учётной записи, отдельной строкой: нажатия не пересекаются с «Обновить».
            customizeRow
            footerRow
        }
        .scaledPadding(.horizontal, 8)
        .padding(.bottom, updates.buttonState == .hidden ? 0 : 4)
        // Окружение передаётся явно: лист живёт в отдельном NSHostingView.
        .sheet(isPresented: $integrationsShown) {
            IntegrationsSheet(model: model)
                .environment(\.appModel, model)
                .environment(\.session, session)
                .environment(\.look, look)
        }
        .onAppear { updates.refreshRecentReleases() }
        // Пока открыто любое окно из панели, раскрытая наведением панель не сворачивается.
        .onChange(of: accountShown || helpShown || integrationsShown || customizeShown) { _, busy in
            SidebarRevealModel.shared.busy(busy)
        }
    }

    // MARK: Обновление

    @ViewBuilder private var updateButton: some View {
        switch updates.buttonState {
        case .hidden:
            EmptyView()
        case .available(let version):
            updateAction("Обновить", icon: "arrow.down.circle.fill", detail: version,
                         help: "Скачать версию \(version) и установить, затем перезапустить приложение")
        case .ready(let version):
            updateAction("Обновить", icon: "arrow.down.circle.fill", detail: version,
                         help: "Установить версию \(version) и перезапустить приложение")
        case .retry(let version):
            updateAction("Повторить обновление", icon: "arrow.clockwise.circle.fill", detail: version,
                         help: "Не удалось скачать или установить версию \(version). Нажмите, чтобы повторить")
        case .downloading(let version):
            updateProgress("Загрузка обновления…", version: version)
        case .installing:
            updateProgress("Установка…", version: nil)
        }
    }

    private func updateAction(_ title: String, icon: String, detail: String, help: String) -> some View {
        Button { updates.performButtonAction() } label: {
            HStack(spacing: 6) {
                Image(systemName: icon)
                Text(title).appFont(12, .semibold)
                Spacer(minLength: 4)
                Text(detail).appFont(11).opacity(0.85)
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.pillProminent)
        .help(help)
        .accessibilityIdentifier("update-ready-button")
        .accessibilityLabel("\(title), версия \(detail)")
    }

    private func updateProgress(_ title: String, version: String?) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(title).appFont(12, .medium)
            Spacer(minLength: 4)
            if let version { Text(version).appFont(11).foregroundStyle(.secondary) }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.06)))
        .accessibilityIdentifier("update-progress")
    }

    // MARK: Настройка панели

    private var customizeRow: some View {
        Button { customizeShown.toggle() } label: {
            HStack(spacing: 8) {
                Image(systemName: "slider.horizontal.3").font(.system(size: 12.5 * look.scale)).frame(width: 18)
                Text("Настроить панель").appFont(12.5)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(FooterButtonStyle(active: customizeShown))
        .help("Какие разделы показывать и как ведёт себя панель")
        .accessibilityIdentifier("sidebar-customize-button")
        .popover(isPresented: $customizeShown, arrowEdge: .top) {
            SidebarCustomizeView { customizeShown = false }.environment(\.look, look)
        }
    }

    private var footerRow: some View {
        HStack(spacing: 6) {
            Button { accountShown.toggle() } label: {
                HStack(spacing: 8) {
                    Avatar(name: model.displayName, size: 22 * look.scale)
                    Text(model.displayName).appFont(13, .semibold).lineLimit(1).truncationMode(.middle)
                    Image(systemName: "chevron.down").font(.system(size: 9 * look.scale, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 6).padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(FooterButtonStyle(active: accountShown))
            .help("Учётная запись и настройки")
            .popover(isPresented: $accountShown, arrowEdge: .top) {
                accountMenu.environment(\.look, look)
            }

            Spacer(minLength: 4)
            if model.searching { ProgressView().controlSize(.small).help(model.searchProgress ?? "Идёт поиск…") }

            Button { helpShown.toggle() } label: {
                Image(systemName: "questionmark.circle").font(.system(size: 15 * look.scale))
                    .frame(width: 26 * look.scale, height: 26 * look.scale)
                    .contentShape(Rectangle())
            }
            .buttonStyle(FooterButtonStyle(active: helpShown))
            .help("Справка и что нового")
            .popover(isPresented: $helpShown, arrowEdge: .top) {
                helpMenu.environment(\.look, look)
            }
        }
        .frame(height: 48 * look.scale)
    }

    // MARK: Учётная запись

    private var accountMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Avatar(name: model.displayName, size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.displayName).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                    Text(model.isCloud ? "Облачная учётная запись" : "Локальная учётная запись, только этот Mac")
                        .font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .padding(12)

            VStack(alignment: .leading, spacing: 4) {
                if model.searching {
                    Label(model.searchProgress ?? "Идёт поиск…", systemImage: "magnifyingglass")
                } else {
                    Label(model.lastSearchAt.map { "Поиск: \($0.shortRelative)" } ?? "Поиск ещё не запускался",
                          systemImage: "magnifyingglass")
                }
                if let sync = session.sync { Label(sync.summary, systemImage: sync.icon) }
            }
            .font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(2)
            .padding(.horizontal, 14).padding(.bottom, 10)

            Divider()
            VStack(spacing: 0) {
                MenuRow("Настройки…", icon: "gearshape") { accountShown = false; openSettings() }
                MenuRow("Интеграции…", icon: "puzzlepiece.extension") { accountShown = false; integrationsShown = true }
                if let sync = session.sync {
                    MenuRow("Синхронизировать сейчас", icon: "arrow.triangle.2.circlepath") { accountShown = false; sync.syncNow() }
                }
            }
            .padding(6)
            Divider()
            MenuRow("Выйти", icon: "rectangle.portrait.and.arrow.right") { accountShown = false; session.logout() }
                .padding(6)
        }
        .frame(width: 280)
    }

    // MARK: Справка

    private var helpMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            MenuRow("Получить поддержку", icon: "bubble.left") { helpShown = false; NSWorkspace.shared.open(Updates.wikiPage) }
                .padding(6)
            Divider()
            MenuRow("Что нового в этой версии", icon: "sparkles") { helpShown = false; WhatsNewController.shared.presentCurrent() }
                .padding(6)
            Divider()
            Text("Все выпуски").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
                .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 4)
            VStack(alignment: .leading, spacing: 0) {
                if let releases = updates.recentReleases, !releases.isEmpty {
                    ForEach(releases, id: \.tagName) { r in
                        MenuRow(r.title, icon: nil, detail: r.publishedDate?.shortRelative, timeline: true,
                                current: AppVersion(r.tagName) != nil && AppVersion(r.tagName) == updates.current) {
                            helpShown = false
                            NSWorkspace.shared.open(r.htmlURL ?? Updates.releasesPage)
                        }
                    }
                } else if updates.recentFailed {
                    Text("Не удалось загрузить список релизов").font(.system(size: 12)).foregroundStyle(.secondary)
                        .padding(.horizontal, 14).padding(.vertical, 6)
                } else {
                    HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Загрузка…").foregroundStyle(.secondary) }
                        .font(.system(size: 12)).padding(.horizontal, 14).padding(.vertical, 6)
                }
                MenuRow("Все релизы", icon: "shippingbox") { helpShown = false; NSWorkspace.shared.open(Updates.releasesPage) }
            }
            .padding(.horizontal, 6).padding(.bottom, 6)
        }
        .frame(width: 290)
        .onAppear { updates.refreshRecentReleases() }
    }
}

/// Квадратный значок с первой буквой имени, как у рабочих пространств.
private struct Avatar: View {
    let name: String
    let size: CGFloat
    var body: some View {
        Text(String(name.first.map { String($0) } ?? "?").uppercased())
            .font(.system(size: size * 0.55, weight: .medium))
            .foregroundStyle(.secondary)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: size * 0.22).fill(.quaternary))
    }
}

/// Строка меню во всплывающей панели: значок, текст, подсветка при наведении.
private struct MenuRow: View {
    let title: String
    let icon: String?
    var detail: String?
    var timeline = false
    var current = false
    let action: () -> Void
    @State private var hover = false

    init(_ title: String, icon: String?, detail: String? = nil, timeline: Bool = false, current: Bool = false,
         action: @escaping () -> Void) {
        self.title = title
        self.icon = icon
        self.detail = detail
        self.timeline = timeline
        self.current = current
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if timeline {
                    // Точка на линии времени, как в списке релизов.
                    ZStack {
                        Rectangle().fill(.quaternary).frame(width: 2)
                        Circle().fill(current ? Color.accentColor : .secondary).frame(width: 7, height: 7)
                    }
                    .frame(width: 18)
                } else if let icon {
                    Image(systemName: icon).font(.system(size: 14)).frame(width: 18)
                }
                Text(title).font(.system(size: 13)).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 6)
                if current { Text("установлена").font(.system(size: 11)).foregroundStyle(.secondary) }
                else if let detail { Text(detail).font(.system(size: 11)).foregroundStyle(.secondary) }
            }
            .padding(.horizontal, 8)
            .frame(height: timeline ? 30 : 28)
            .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Color.primary.opacity(0.08) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// Кнопка в нижней строке: подсвечивается при наведении и пока открыто её меню.
private struct FooterButtonStyle: ButtonStyle {
    let active: Bool
    @State private var hover = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(RoundedRectangle(cornerRadius: 6)
                .fill(Color.primary.opacity(active || configuration.isPressed ? 0.1 : hover ? 0.06 : 0)))
            .onHover { hover = $0 }
    }
}
