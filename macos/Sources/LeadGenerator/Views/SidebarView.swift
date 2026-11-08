import LeadGenCore
import LeadSearch
import Observation
import SwiftUI

/// Режим настройки боковой панели. «Настроить панель» включает его прямо в панели: у пунктов появляются
/// ручки для перетаскивания и кнопки «показать/скрыть». Изменения копятся в черновике и сохраняются
/// кнопкой «Готово»; «Отменить» (Esc) возвращает прежний вид.
@MainActor
@Observable
final class SidebarEditModel {
    static let shared = SidebarEditModel()

    private(set) var editing = false
    var hidden: Set<String> = []
    var hiddenSources: Set<String> = []
    var order: [String] = []
    var sourceOrder: [String] = []
    var showCounts = true
    var showSources = true
    var hoverReveal = true

    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func begin() {
        hidden = SidebarPrefs.parse(hidden: defaults.string(forKey: SidebarKeys.hidden) ?? "")
        hiddenSources = SidebarPrefs.parse(hidden: defaults.string(forKey: SidebarKeys.hiddenSources) ?? "")
        order = SidebarPrefs.parse(order: defaults.string(forKey: SidebarKeys.order) ?? "")
        sourceOrder = SidebarPrefs.parse(order: defaults.string(forKey: SidebarKeys.sourceOrder) ?? "")
        showCounts = defaults.object(forKey: SidebarKeys.counts) as? Bool ?? true
        showSources = defaults.object(forKey: SidebarKeys.sources) as? Bool ?? true
        hoverReveal = defaults.object(forKey: SidebarKeys.hover) as? Bool ?? true
        editing = true
    }

    /// «Готово»: черновик становится настройками панели.
    func commit() {
        guard editing else { return }
        defaults.set(SidebarPrefs.serialize(hidden: hidden), forKey: SidebarKeys.hidden)
        defaults.set(SidebarPrefs.serialize(hidden: hiddenSources), forKey: SidebarKeys.hiddenSources)
        defaults.set(SidebarPrefs.serialize(order: order), forKey: SidebarKeys.order)
        defaults.set(SidebarPrefs.serialize(order: sourceOrder), forKey: SidebarKeys.sourceOrder)
        defaults.set(showCounts, forKey: SidebarKeys.counts)
        defaults.set(showSources, forKey: SidebarKeys.sources)
        defaults.set(hoverReveal, forKey: SidebarKeys.hover)
        editing = false
    }

    /// «Отменить»: черновик отбрасывается.
    func cancel() { editing = false }

    func sections(_ group: [NavSection]) -> [NavSection] {
        SidebarPrefs.ordered(group.map(\.rawValue), by: order).compactMap(NavSection.init(rawValue:))
    }

    func move(in group: [NavSection], from offsets: IndexSet, to destination: Int) {
        let current = sections(group).map(\.rawValue)
        let moved = SidebarPrefs.move(current, from: offsets, to: destination)
        // Порядок других категорий сохраняется: меняется только эта.
        order = order.filter { id in !current.contains(id) } + moved
    }

    func sources(_ all: [String]) -> [String] { SidebarPrefs.ordered(all, by: sourceOrder) }

    func moveSources(_ all: [String], from offsets: IndexSet, to destination: Int) {
        sourceOrder = SidebarPrefs.move(sources(all), from: offsets, to: destination)
    }

    func setVisible(_ section: NavSection, _ visible: Bool) {
        hidden = SidebarPrefs.toggled(hidden, section.rawValue, visible: visible)
    }

    func setSourceVisible(_ source: String, _ visible: Bool) {
        hiddenSources = SidebarPrefs.toggled(hiddenSources, source, visible: visible)
    }
}

struct SidebarView: View {
    @Environment(\.appModel) private var model
    @Environment(\.look) private var look
    @Environment(\.session) private var session
    @AppStorage(SidebarKeys.hidden) private var hiddenRaw = ""
    @AppStorage(SidebarKeys.hiddenSources) private var hiddenSourcesRaw = ""
    @AppStorage(SidebarKeys.order) private var orderRaw = ""
    @AppStorage(SidebarKeys.sourceOrder) private var sourceOrderRaw = ""
    @AppStorage(SidebarKeys.counts) private var showCounts = true
    @AppStorage(SidebarKeys.sources) private var showSources = true
    @State private var editor = SidebarEditModel.shared

    private var hidden: Set<String> { SidebarPrefs.parse(hidden: hiddenRaw) }
    private var hiddenSources: Set<String> { SidebarPrefs.parse(hidden: hiddenSourcesRaw) }
    private var editing: Bool { editor.editing }

    private func sections(_ group: [NavSection]) -> [NavSection] {
        if editing { return editor.sections(group) }
        let order = SidebarPrefs.parse(order: orderRaw)
        return SidebarPrefs.ordered(group.map(\.rawValue), by: order).compactMap(NavSection.init(rawValue:))
            .filter { !hidden.contains($0.rawValue) }
    }

    private var sourceRows: [String] {
        if editing { return editor.sources(model.allSources) }
        return SidebarPrefs.ordered(model.allSources, by: SidebarPrefs.parse(order: sourceOrderRaw))
            .filter { !hiddenSources.contains($0) }
    }

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            List(selection: Binding(get: { editing ? nil : Optional(model.section) },
                                    set: { if !editing, let s = $0, s != model.section { model.section = s } })) {
                Section {
                    ForEach(sections(SidebarKeys.mainGroup)) { row($0) }
                        .onMove(perform: mover(SidebarKeys.mainGroup))
                }
                Section("Работа") {
                    ForEach(sections(SidebarKeys.workGroup)) { row($0) }
                        .onMove(perform: mover(SidebarKeys.workGroup))
                }
                if (editing || showSources), !model.allSources.isEmpty {
                    Section("Источники лидов") {
                        ForEach(sourceRows, id: \.self) { src in sourceRow(src) }
                            .onMove(perform: sourceMover)
                    }
                    .opacity(editing && !editor.showSources ? 0.5 : 1)
                }
                if editing { viewOptions }
            }
            .listStyle(.sidebar)
            .animation(look.animation(.smooth(duration: 0.2)), value: editing)
            .contextMenu {
                if !editing {
                    Button("Настроить панель") { editor.begin() }
                }
            }
            Divider()
            SidebarFooter(model: model, session: session, look: look)
        }
    }

    // MARK: Пункты

    /// Перетаскивание работает только в режиме настройки.
    private func mover(_ group: [NavSection]) -> ((IndexSet, Int) -> Void)? {
        guard editing else { return nil }
        let editor = editor
        return { offsets, destination in editor.move(in: group, from: offsets, to: destination) }
    }

    private var sourceMover: ((IndexSet, Int) -> Void)? {
        guard editing else { return nil }
        let editor = editor, all = model.allSources
        return { offsets, destination in editor.moveSources(all, from: offsets, to: destination) }
    }

    @ViewBuilder
    private func row(_ s: NavSection) -> some View {
        if editing {
            editRow(title: s.title, hidden: editor.hidden.contains(s.rawValue),
                    canHide: SidebarKeys.configurable.contains(s), setVisible: { editor.setVisible(s, $0) }) {
                Label(s.title, systemImage: s.icon).appFont(13).lineLimit(1)
            }
        } else {
            Label {
                HStack {
                    Text(s.title).appFont(13)
                    Spacer()
                    if alert(s) { Circle().fill(.orange).frame(width: 6, height: 6) }
                    if showCounts, let count = count(s), count > 0 {
                        if s == .new {
                            Text("\(count)").appFont(10.5, .semibold).foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Capsule().fill(.tint))
                        } else {
                            Text("\(count)").appFont(11.5).foregroundStyle(.secondary).monospacedDigit()
                        }
                    }
                }
            } icon: { Image(systemName: s.icon) }
            .tag(s)
        }
    }

    @ViewBuilder
    private func sourceRow(_ src: String) -> some View {
        if editing {
            editRow(title: SourceCatalog.title(src), hidden: editor.hiddenSources.contains(src), canHide: true,
                    setVisible: { editor.setSourceVisible(src, $0) }) {
                SourceBadge(source: src)
            }
        } else {
            Button {
                model.section = .all
                model.filter.source = model.filter.source == src ? nil : src
            } label: {
                HStack {
                    SourceBadge(source: src)
                    Spacer()
                    if model.filter.source == src { Image(systemName: "checkmark").foregroundStyle(.tint) }
                }
            }
            .buttonStyle(.plain)
        }
    }

    /// Пункт в режиме настройки: ручка для перетаскивания, название и кнопка «показать/скрыть».
    private func editRow<L: View>(title: String, hidden: Bool, canHide: Bool, setVisible: @escaping (Bool) -> Void,
                                  @ViewBuilder label: () -> L) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "line.3.horizontal").font(.system(size: 11 * look.scale, weight: .medium))
                .foregroundStyle(.tertiary)
                .help("Перетащите, чтобы изменить порядок")
            label().opacity(hidden ? 0.4 : 1)
            Spacer(minLength: 4)
            if canHide {
                Button { setVisible(hidden) } label: {
                    Image(systemName: hidden ? "eye.slash" : "eye")
                        .font(.system(size: 12 * look.scale))
                        .frame(width: 24, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(hidden ? Color.secondary : look.accentColor)
                .help(hidden ? "Показать «\(title)»" : "Скрыть «\(title)»")
                .accessibilityLabel(hidden ? "Показать \(title)" : "Скрыть \(title)")
            } else {
                Image(systemName: "lock").font(.system(size: 10.5 * look.scale)).foregroundStyle(.tertiary)
                    .frame(width: 24, height: 20)
                    .help("Этот раздел всегда на месте")
            }
        }
        .contentShape(Rectangle())
    }

    /// Что ещё показывать в панели — тоже меняется в режиме настройки и сохраняется кнопкой «Готово».
    private var viewOptions: some View {
        Section("Вид панели") {
            option("Счётчики у разделов", icon: "number", isOn: $editor.showCounts)
            option("Список источников", icon: "cylinder.split.1x2", isOn: $editor.showSources)
            option("Раскрывать при наведении", icon: "cursorarrow.motionlines", isOn: $editor.hoverReveal)
                .help("Свёрнутая панель выезжает при подведении курсора к левому краю окна")
        }
    }

    private func option(_ title: String, icon: String, isOn: Binding<Bool>) -> some View {
        HStack(spacing: 8) {
            Label(title, systemImage: icon).appFont(12.5).lineLimit(1)
            Spacer(minLength: 4)
            Toggle("", isOn: isOn).labelsHidden().toggleStyle(.glassSwitch).controlSize(.mini)
        }
    }

    private func count(_ s: NavSection) -> Int? {
        switch s {
        case .all, .new, .favorites, .archive, .excluded: return model.count(s)
        default: return nil
        }
    }

    private func alert(_ s: NavSection) -> Bool {
        s == .sources && model.sources.contains { $0.consecutiveFailures > 0 || $0.status != "ok" }
    }
}
