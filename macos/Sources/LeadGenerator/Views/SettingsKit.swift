import AppKit
import SwiftUI

// Детали дизайн-системы окна настроек: страница с крупным заголовком, группы с разделителем, строки «текст слева,
// элемент справа», кнопки с состояниями наведения, нажатия и недоступности. Те же кнопки и карточки
// используются в боковой панели и мастере, поэтому вид единый по всему приложению.

/// Страница настроек: прокручиваемая колонка ограниченной ширины.
struct SettingsPage<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) { content }
                .frame(maxWidth: 680, alignment: .leading)
                .padding(.horizontal, 32)
                .padding(.top, 8)
                .padding(.bottom, 36)
                .frame(maxWidth: .infinity, alignment: .center)
        }
        .scrollContentBackground(.hidden)
    }
}

/// Группа строк: заголовок и тонкая линия под ним.
struct SettingsGroup<Content: View>: View {
    @Environment(\.look) private var look
    let title: String
    var footer: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.system(size: 15 * look.scale, weight: .semibold))
                .padding(.bottom, 8)
            Divider()
            VStack(alignment: .leading, spacing: 0) { content }
            if let footer {
                Text(footer).font(.system(size: 11.5 * look.scale)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            }
        }
    }
}

/// Строка настройки: название и пояснение слева, элемент управления справа. В узком окне элемент уходит под текст.
struct SettingRow<Control: View>: View {
    @Environment(\.look) private var look
    let title: String
    var detail: String?
    var badge: String?
    @ViewBuilder var control: Control

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 16) {
                text
                Spacer(minLength: 12)
                control
            }
            VStack(alignment: .leading, spacing: 8) {
                text
                control
            }
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var text: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(title).font(.system(size: 13.5 * look.scale, weight: .medium))
                if let badge { SettingsBadge(text: badge) }
            }
            if let detail {
                Text(detail).font(.system(size: 12 * look.scale)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Строка-блок: заголовок и пояснение сверху, содержимое на всю ширину ниже (плитки темы, ползунок).
struct SettingBlock<Content: View>: View {
    @Environment(\.look) private var look
    let title: String
    var detail: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 13.5 * look.scale, weight: .medium))
                if let detail {
                    Text(detail).font(.system(size: 12 * look.scale)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            content
        }
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SettingsBadge: View {
    let text: String
    var body: some View {
        Text(text).font(.system(size: 10.5, weight: .medium)).foregroundStyle(.secondary)
            .padding(.horizontal, 6).padding(.vertical, 1.5)
            .background(RoundedRectangle(cornerRadius: 5).fill(.quaternary))
    }
}

/// Тонкая линия между строками внутри группы.
struct RowDivider: View {
    var body: some View { Divider().opacity(0.6) }
}

/// Кнопка окна настроек: скруглённая, с наведением, нажатием и недоступным состоянием.
struct PillButtonStyle: ButtonStyle {
    enum Kind { case regular, prominent, destructive }
    var kind: Kind = .regular
    @Environment(\.isEnabled) private var enabled
    @Environment(\.look) private var look
    @State private var hover = false

    func makeBody(configuration: Configuration) -> some View {
        let tint: Color = kind == .destructive ? .red : look.accentColor
        configuration.label
            .font(.system(size: 12.5 * look.scale, weight: .medium))
            .foregroundStyle(kind == .prominent ? Color.white : (kind == .destructive ? Color.red : Color.primary))
            .padding(.horizontal, 12).padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(fill(tint, pressed: configuration.isPressed))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(kind == .prominent ? Color.clear : Color.primary.opacity(hover ? 0.22 : 0.14), lineWidth: 1)
            )
            .opacity(enabled ? 1 : 0.4)
            .scaleEffect(configuration.isPressed && !look.lightMode ? 0.97 : 1)
            .animation(look.animation(.easeOut(duration: 0.12)), value: configuration.isPressed)
            .onHover { hover = $0 && enabled }
            .contentShape(RoundedRectangle(cornerRadius: 8))
    }

    private func fill(_ tint: Color, pressed: Bool) -> Color {
        switch kind {
        case .prominent: return tint.opacity(pressed ? 0.75 : (hover ? 0.92 : 1))
        case .destructive: return Color.red.opacity(pressed ? 0.2 : (hover ? 0.14 : 0.08))
        case .regular: return Color.primary.opacity(pressed ? 0.14 : (hover ? 0.09 : 0.05))
        }
    }
}

extension ButtonStyle where Self == PillButtonStyle {
    static var pill: PillButtonStyle { PillButtonStyle() }
    static var pillProminent: PillButtonStyle { PillButtonStyle(kind: .prominent) }
    static var pillDestructive: PillButtonStyle { PillButtonStyle(kind: .destructive) }
}

/// Раскрывающийся список в стиле справочных снимков: рамка со скруглением и стрелкой.
struct MenuPicker<Value: Hashable, Options: View>: View {
    @Environment(\.look) private var look
    @Binding var selection: Value
    @ViewBuilder var options: Options

    var body: some View {
        Picker("", selection: $selection) { options }
            .labelsHidden()
            .pickerStyle(.menu)
            .fixedSize()
            .tint(look.accentColor)
    }
}

/// Цветной кружок схемы: у «Как в системе» (nil) он разноцветный.
struct AccentSwatch: View {
    let choice: AccentChoice?
    var size: CGFloat = 12
    var body: some View {
        Group {
            if let choice {
                Circle().fill(choice.color)
            } else {
                Circle().fill(AngularGradient(colors: [.blue, .purple, .pink, .orange, .green, .blue], center: .center))
            }
        }
        .frame(width: size, height: size)
    }
}

/// Карточка с мягкой подложкой для встроенных блоков (состояние, пояснение).
struct SoftCard<Content: View>: View {
    @Environment(\.look) private var look
    var tint: Color?
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill((tint ?? Color.primary).opacity(tint == nil ? 0.05 : 0.1)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder((tint ?? Color.primary).opacity(0.1)))
    }
}

/// Стиль окна настроек: прозрачный заголовок, содержимое под ним, перетаскивание за фон.
struct SettingsWindowChrome: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async { Self.style(v.window) }
        return v
    }

    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async { Self.style(view.window) }
    }

    @MainActor
    private static func style(_ window: NSWindow?) {
        guard let window else { return }
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.styleMask.insert(.fullSizeContentView)
        window.isMovableByWindowBackground = true
    }
}

extension View {
    /// Форма в стиле окна настроек: без плотной подложки, колонка ограниченной ширины по центру.
    func settingsForm() -> some View {
        self.formStyle(.grouped)
            .scrollContentBackground(.hidden)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
    }
}
