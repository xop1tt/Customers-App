import AppKit
import LeadGenCore
import Observation
import SwiftUI

/// Раскрытие свёрнутой боковой панели при наведении на левый край окна. Правила (задержки, «не мерцать»,
/// «не закрываться, пока открыто меню») живут в `HoverReveal` из ядра и проверяются тестами; здесь только таймер.
@MainActor
@Observable
final class SidebarRevealModel {
    static let shared = SidebarRevealModel()

    private(set) var revealed = false
    @ObservationIgnored private var machine = HoverReveal()
    @ObservationIgnored private var task: Task<Void, Never>?

    private static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    func edge(_ inside: Bool) { machine.setEdge(inside, now: Self.now); sync() }
    func panel(_ inside: Bool) { machine.setPanel(inside, now: Self.now); sync() }
    /// Открыто меню или окно из панели (учётная запись, настройка панели): панель не сворачивается.
    func busy(_ value: Bool) { machine.setBusy(value, now: Self.now); sync() }
    /// Свернуть сразу: панель закреплена, функция выключена.
    func reset() { machine.reset(); task?.cancel(); if revealed { revealed = false } }

    private func sync() {
        if machine.revealed != revealed { revealed = machine.revealed }
        task?.cancel()
        guard let delay = machine.nextDelay(now: Self.now) else { return }
        task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.machine.tick(now: Self.now)
            self.sync()
        }
    }
}

/// Невидимая полоса у края окна, которая сообщает о входе и выходе курсора, но не перехватывает нажатия.
struct EdgeHoverArea: NSViewRepresentable {
    let onChange: (Bool) -> Void

    func makeNSView(context: Context) -> TrackingView {
        let v = TrackingView()
        v.onChange = onChange
        return v
    }

    func updateNSView(_ view: TrackingView, context: Context) { view.onChange = onChange }

    final class TrackingView: NSView {
        var onChange: ((Bool) -> Void)?

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            for area in trackingAreas { removeTrackingArea(area) }
            addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                           owner: self, userInfo: nil))
        }

        override func mouseEntered(with event: NSEvent) { onChange?(true) }
        override func mouseExited(with event: NSEvent) { onChange?(false) }
    }
}

/// Раскрывшаяся при наведении панель поверх содержимого: с ней можно работать, пока курсор над ней.
struct RevealedSidebar: View {
    @Environment(\.look) private var look
    let pin: () -> Void
    let reveal: SidebarRevealModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button(action: pin) { Label("Закрепить", systemImage: "pin") .labelStyle(.titleAndIcon) }
                    .buttonStyle(.plain)
                    .font(.system(size: 11.5)).foregroundStyle(.secondary)
                    .help("Оставить панель раскрытой")
                    .accessibilityIdentifier("sidebar-pin-button")
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
            SidebarView()
        }
        .frame(width: 252 * look.scale)
        .background(panelBackground)
        .clipShape(UnevenRoundedRectangle(bottomTrailingRadius: 14, topTrailingRadius: 14, style: .continuous))
        .overlay(UnevenRoundedRectangle(bottomTrailingRadius: 14, topTrailingRadius: 14, style: .continuous)
            .strokeBorder(Color.primary.opacity(0.12)))
        .shadow(color: .black.opacity(look.lightMode ? 0 : 0.22), radius: 18, x: 4)
        .onHover { reveal.panel($0) }
    }

    /// Полупрозрачная подложка; в облегчённом режиме сплошная, без размытия.
    @ViewBuilder private var panelBackground: some View {
        if look.lightMode {
            Color(nsColor: .windowBackgroundColor)
        } else {
            Rectangle().fill(.regularMaterial)
        }
    }
}

/// Настройка боковой панели: какие разделы показывать и как панель себя ведёт. Всплывает у кнопки в нижней части панели.
struct SidebarCustomizeView: View {
    @Environment(\.look) private var look
    @AppStorage("sidebar.hidden") private var hiddenRaw = ""
    @AppStorage(SidebarKeys.counts) private var showCounts = true
    @AppStorage(SidebarKeys.sources) private var showSources = true
    @AppStorage(SidebarKeys.hover) private var hoverReveal = true
    let done: () -> Void

    private var hidden: Set<String> { SidebarPrefs.parse(hidden: hiddenRaw) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Настройка панели").font(.system(size: 14, weight: .semibold)).padding(.horizontal, 16).padding(.top, 14)
            Text("Что показывать слева и как панель ведёт себя").font(.system(size: 11.5)).foregroundStyle(.secondary)
                .padding(.horizontal, 16).padding(.top, 2).padding(.bottom, 8)
            Divider()
            VStack(spacing: 0) {
                ForEach(SidebarKeys.configurable) { s in
                    toggleRow(s.title, icon: s.icon, isOn: Binding(get: { !hidden.contains(s.rawValue) }, set: { show in
                        var h = hidden
                        if show { h.remove(s.rawValue) } else { h.insert(s.rawValue) }
                        hiddenRaw = SidebarPrefs.serialize(hidden: h)
                    }))
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            Divider()
            VStack(spacing: 0) {
                toggleRow("Счётчики у разделов", icon: "number", isOn: $showCounts)
                toggleRow("Список источников", icon: "cylinder.split.1x2", isOn: $showSources)
                toggleRow("Раскрывать при наведении", icon: "cursorarrow.motionlines", isOn: $hoverReveal)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            Text("Когда панель свёрнута, она выезжает при подведении курсора к левому краю окна и убирается, когда курсор уходит.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16).padding(.bottom, 8)
            Button(action: done) { Text("Готово").frame(maxWidth: .infinity) }
                .buttonStyle(.pillProminent)
                .keyboardShortcut(.defaultAction)
                .padding(.horizontal, 16).padding(.bottom, 14)
        }
        .frame(width: 290)
    }

    private func toggleRow(_ title: String, icon: String, isOn: Binding<Bool>) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon).frame(width: 20).foregroundStyle(.secondary)
            Text(title).font(.system(size: 13))
            Spacer()
            Toggle("", isOn: isOn).labelsHidden().toggleStyle(.switch).controlSize(.small)
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

enum SidebarKeys {
    static let counts = "sidebar.counts"
    static let sources = "sidebar.sources"
    static let hover = "sidebar.hover"
    /// Разделы, которые можно скрыть.
    static let configurable: [NavSection] = [.home, .new, .favorites, .sources, .runs, .archive, .excluded]
}
