import LeadGenCore
import Observation
import SwiftUI

/// Показаны ли настройки. Одно состояние на приложение: меню, строка меню и кнопки внутри окна
/// открывают одно и то же всплывающее окно.
@MainActor
@Observable
final class SettingsPresenter {
    static let shared = SettingsPresenter()

    private(set) var shown = false

    func present() { shown = true }
    func dismiss() { shown = false }
}

/// Размер окна настроек внутри главного окна: крупное, по центру, с полями по краям.
/// Отдельно от представления, чтобы проверить тестами.
enum SettingsOverlayLayout {
    static let maxSize = CGSize(width: 1240, height: 900)
    static let minSize = CGSize(width: 720, height: 480)
    static let margin: CGFloat = 28

    static func size(in container: CGSize) -> CGSize {
        func side(_ available: CGFloat, _ share: CGFloat, _ lower: CGFloat, _ upper: CGFloat) -> CGFloat {
            let room = max(available - margin * 2, 0)
            let wanted = min(max(available * share, lower), upper)
            return max(min(wanted, room), 0)
        }
        return CGSize(width: side(container.width, 0.84, minSize.width, maxSize.width),
                      height: side(container.height, 0.86, minSize.height, maxSize.height))
    }
}

/// Настройки поверх главного окна, как в Notion: затемнение вокруг, окно по центру. Окно нельзя перетащить,
/// оно закрывается нажатием на затемнённую область, крестиком или клавишей Esc.
struct SettingsOverlay: View {
    @Environment(\.look) private var look
    let presenter: SettingsPresenter

    var body: some View {
        ZStack {
            // Затемнение на всё окно, под панелью инструментов тоже.
            Color.black.opacity(look.lightMode ? 0.32 : 0.22)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { presenter.dismiss() }
                .accessibilityLabel("Закрыть настройки")
                .accessibilityAddTraits(.isButton)

            GeometryReader { geo in
                let size = SettingsOverlayLayout.size(in: geo.size)
                card
                    .frame(width: size.width, height: size.height)
                    .position(x: geo.size.width / 2, y: geo.size.height / 2)
            }
        }
        .transition(.opacity.combined(with: .scale(scale: 0.98)))
        .accessibilityAddTraits(.isModal)
    }

    private var card: some View {
        let shape = RoundedRectangle(cornerRadius: LiquidGlass.panelRadius, style: .continuous)
        return SettingsView()
            // Нажатия по пустым местам окна не доходят до затемнения и не закрывают его.
            .background(Color.clear.contentShape(shape).onTapGesture {})
            .glassPanel(shape)
            .overlay(alignment: .topTrailing) {
                Button { presenter.dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .frame(width: 26, height: 26)
                        .glassBackground(Circle(), interactive: true)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .keyboardShortcut(.cancelAction)
                .help("Закрыть настройки (Esc)")
                .accessibilityLabel("Закрыть настройки")
                .accessibilityIdentifier("settings-close-button")
                .padding(14)
            }
    }
}
