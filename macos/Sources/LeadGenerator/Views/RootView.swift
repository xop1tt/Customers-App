import LeadGenCore
import LeadSearch
import SwiftUI

struct RootView: View {
    @Environment(\.appModel) private var model
    @Environment(\.look) private var look
    @State private var welcomeShown = false
    @State private var whatsNew = WhatsNewController.shared
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var reveal = SidebarRevealModel.shared
    @AppStorage(SidebarKeys.hover) private var hoverReveal = true

    /// Левая панель свёрнута кнопкой в панели инструментов.
    private var collapsed: Bool { columnVisibility == .detailOnly }

    var body: some View {
        @Bindable var model = model
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 200, ideal: 240 * look.scale, max: 360)
        } detail: {
            ZStack(alignment: .bottom) {
                content
                    // Содержимое панели инструментов и правой панели AppKit размещает в отдельных
                    // контейнерах; окружение передаём явно, иначе SwiftUI может не найти модель
                    // при перерисовке и аварийно завершить приложение.
                    .toolbar {
                        ToolbarItem(placement: .principal) { SearchButton(model: model) }
                        // Последний элемент панели — у её правого края.
                        ToolbarItem(placement: .primaryAction) {
                            Button { model.inspectorShown.toggle() } label: {
                                Label(model.inspectorShown ? "Скрыть правую панель" : "Показать правую панель",
                                      systemImage: "sidebar.right")
                            }
                            .help(model.inspectorShown ? "Скрыть правую панель (⌥⌘I)" : "Показать правую панель (⌥⌘I)")
                        }
                    }
                    .inspector(isPresented: $model.inspectorShown) {
                        InspectorView()
                            .environment(\.appModel, model)
                            .environment(\.look, look)
                            .inspectorColumnWidth(min: 300, ideal: 380 * look.scale, max: 560)
                    }
                if let err = model.lastError {
                    Toast(text: err, isError: true) { model.lastError = nil }.padding(.bottom, 16)
                } else if let msg = model.lastMessage {
                    Toast(text: msg, isError: false) { model.lastMessage = nil }
                        .padding(.bottom, 16)
                        .task(id: msg) {
                            try? await Task.sleep(nanoseconds: 5_000_000_000)
                            if model.lastMessage == msg { model.lastMessage = nil }
                        }
                }
            }
            // Свёрнутая панель выезжает при подведении курсора к левому краю окна.
            .overlay(alignment: .leading) { hoverSidebar }
        }
        .onChange(of: collapsed) { _, now in if !now { reveal.reset() } }
        .onChange(of: hoverReveal) { _, on in if !on { reveal.reset() } }
        .sheet(item: $model.exportTab) { tab in
            ExportSheet(items: model.exportItems, tab: tab)
                .environment(\.appModel, model)
                .environment(\.look, look)
        }
        .sheet(item: Binding(get: { whatsNew.content }, set: { if $0 == nil { whatsNew.dismiss() } })) { c in
            WhatsNewSheet(content: c) { whatsNew.dismiss() }
        }
        .task(id: model.username) { presentStartupScreens() }
        .overlay {
            if welcomeShown {
                WelcomeView(model: model) {
                    WelcomeGate.markDone(model)
                    welcomeShown = false
                    model.section = .home
                }
                .environment(\.appModel, model)
                .environment(\.look, look)
                .transition(.opacity)
            }
        }
        .overlay {
            if let e = model.startupError {
                ContentUnavailableView("База недоступна", systemImage: "externaldrive.badge.exclamationmark", description: Text(e))
                    .background(.background)
            }
        }
    }

    /// Узкая зона у левого края и сама выехавшая панель. Зона не перехватывает нажатия.
    @ViewBuilder private var hoverSidebar: some View {
        if collapsed && hoverReveal {
            ZStack(alignment: .leading) {
                EdgeHoverArea { reveal.edge($0) }
                    .frame(width: 8)
                    .frame(maxHeight: .infinity)
                if reveal.revealed {
                    RevealedSidebar(pin: { pin() }, reveal: reveal)
                        .environment(\.appModel, model)
                        .environment(\.look, look)
                        .environment(\.session, SessionModel.shared)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                }
            }
            .frame(maxHeight: .infinity)
            .animation(look.animation(.smooth(duration: 0.22)), value: reveal.revealed)
        }
    }

    /// «Закрепить»: панель остаётся раскрытой, как после нажатия кнопки в панели инструментов.
    private func pin() {
        reveal.reset()
        columnVisibility = .all
    }

    /// Первый запуск: мастер настройки; иначе после обновления — «Что нового». Одновременно оба не показываются.
    private func presentStartupScreens() {
        guard model.startupError == nil, !model.isInert else { return }
        let existing = SessionModel.shared.existingInstallAtLaunch
        if WelcomeGate.isNeeded(model) {
            // Новичку список изменений не нужен: версия запоминается молча.
            WhatsNewController.shared.evaluate(existingInstall: false)
            welcomeShown = true
        } else {
            WhatsNewController.shared.evaluate(existingInstall: existing)
        }
    }

    @ViewBuilder private var content: some View {
        switch model.section {
        case .home: DashboardView()
        case .sources: SourcesView()
        case .runs: SearchLogView()
        default: LeadsView()
        }
    }
}

/// Правая панель: содержимое зависит от раздела и выбранного объекта.
struct InspectorView: View {
    @Environment(\.appModel) private var model
    var body: some View {
        Group {
            if model.section.isLeadList || model.section == .home {
                if let lead = model.selectedLead {
                    LeadInspector(lead: lead)
                } else if model.selection.count > 1 {
                    ContentUnavailableView("Выбрано: \(model.selection.count)", systemImage: "checklist",
                                           description: Text("Действия с выбранными — на панели над таблицей и в контекстном меню."))
                } else {
                    ContentUnavailableView("Лид не выбран", systemImage: "sidebar.right",
                                           description: Text("Выберите лид, чтобы увидеть оценку, контакты и черновик обращения."))
                }
            } else if model.section == .sources {
                SourcesInspector()
            } else {
                SearchLogInspector()
            }
        }
    }
}

/// Зелёная кнопка поиска в центре верхней панели.
struct SearchButton: View {
    let model: AppModel

    var body: some View {
        Button {
            if model.searching { model.stopSearch() } else { model.runSearch() }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: model.searching ? "stop.fill" : "magnifyingglass")
                    .font(.system(size: 11.5, weight: .bold))
                Text(model.searching ? (model.searchProgress ?? "Идёт поиск…") : "Найти лиды")
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .frame(height: 28)
            .frame(minWidth: 150)
            .background(Capsule().fill(Color(red: 0.16, green: 0.70, blue: 0.33)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(model.searching ? "Остановить поиск (⌘R)" : "Найти новые лиды во всех включённых источниках (⌘R)")
    }
}
