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
    /// Открыто меню или окно из панели (учётная запись) или идёт настройка панели: панель не сворачивается.
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
        .modifier(RevealedPanelChrome())
        .onHover { reveal.panel($0) }
    }
}

/// Вид выехавшей панели по системе: на macOS 26+ — плавающая стеклянная панель с отступом от краёв окна,
/// как боковая панель Liquid Glass; на 14–15 — панель у края окна на материале, как было в этих версиях.
private struct RevealedPanelChrome: ViewModifier {
    @Environment(\.look) private var look

    @ViewBuilder func body(content: Content) -> some View {
        if LiquidGlass.isNative {
            content
                .glassPanel(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .padding(.vertical, 8).padding(.leading, 8)
        } else {
            let shape = UnevenRoundedRectangle(bottomTrailingRadius: 14, topTrailingRadius: 14, style: .continuous)
            content
                .background(look.lightMode ? AnyShapeStyle(Color(nsColor: .windowBackgroundColor)) : AnyShapeStyle(.regularMaterial))
                .clipShape(shape)
                .overlay(shape.strokeBorder(Color.primary.opacity(0.12)))
                .shadow(color: .black.opacity(look.lightMode ? 0 : 0.22), radius: 18, x: 4)
        }
    }
}

enum SidebarKeys {
    static let hidden = "sidebar.hidden"
    static let hiddenSources = "sidebar.hiddenSources"
    /// Порядок разделов внутри категорий и порядок источников.
    static let order = "sidebar.order"
    static let sourceOrder = "sidebar.sourceOrder"
    static let counts = "sidebar.counts"
    static let sources = "sidebar.sources"
    static let hover = "sidebar.hover"
    /// Разделы, которые можно скрыть.
    static let configurable: [NavSection] = [.home, .new, .favorites, .sources, .runs, .archive, .excluded]
    /// Категории панели: пункты переставляются только внутри своей категории.
    static let mainGroup: [NavSection] = [.home, .all, .new, .favorites]
    static let workGroup: [NavSection] = [.sources, .runs, .archive, .excluded]
}
