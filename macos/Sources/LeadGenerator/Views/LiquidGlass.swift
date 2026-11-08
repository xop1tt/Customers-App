import AppKit
import SwiftUI

// Liquid Glass — дизайн macOS 26 и новее: стеклянные элементы управления, которые преломляют содержимое под
// собой, светятся при нажатии и сливаются друг с другом. Внешний вид подстраивается под систему:
// • macOS 26+ (приложение собрано с SDK macOS 26): настоящие системные API — `glassEffect`,
//   `GlassEffectContainer`, стили кнопок `.glass` / `.glassProminent`, системный переключатель, крупные скругления.
// • macOS 14–15: стекло не имитируется. Элементы выглядят как принято в этих версиях: сплошные кнопки
//   со скруглёнными углами, материал у всплывающих элементов, обычный системный переключатель.
// • Облегчённый режим: без прозрачности и теней на любой системе.
//
// Правило Apple: стекло — для слоя управления и навигации (кнопки, панели, всплывающие окна),
// а не для содержимого (таблицы, карточки с данными). Карточки остаются плотными.

enum LiquidGlass {
    /// Доступен ли Liquid Glass на этом Mac (macOS 26+ и приложение собрано с SDK macOS 26).
    static var isNative: Bool {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) { return true }
        #endif
        return false
    }

    /// Радиусы скругления по системе: в Liquid Glass они крупнее, вложенные концентричны внешним.
    static var panelRadius: CGFloat { isNative ? 26 : 12 }
    static var cardRadius: CGFloat { isNative ? 16 : 10 }
    static var controlRadius: CGFloat { isNative ? 10 : 6 }
    /// Поле ввода, сообщение, полоска прогресса: капсула в Liquid Glass, скруглённый прямоугольник раньше.
    static var fieldRadius: CGFloat { isNative ? 18 : 8 }
}

/// Подложка элемента управления: стекло на macOS 26+, системный вид прежних версий на macOS 14–15.
struct GlassBackground<S: InsettableShape>: ViewModifier {
    @Environment(\.look) private var look
    let shape: S
    var tint: Color?
    /// Сплошная подложка акцентного цвета (главная кнопка), а не лёгкий оттенок.
    var prominent = false
    /// Отклик на нажатие и наведение (для кнопок).
    var interactive = false
    /// Плавающий элемент (сообщение поверх содержимого): на macOS 14–15 — материал, как у всплывающих панелей.
    var floating = false

    @ViewBuilder func body(content: Content) -> some View {
        if look.lightMode {
            classic(content, material: false)
        } else {
            glass(content)
        }
    }

    @ViewBuilder private func glass(_ content: Content) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            content.glassEffect(systemGlass, in: shape)
        } else {
            classic(content, material: floating)
        }
        #else
        classic(content, material: floating)
        #endif
    }

    #if compiler(>=6.2)
    @available(macOS 26.0, *)
    private var systemGlass: Glass {
        var g = Glass.regular
        if let tint { g = g.tint(prominent ? tint : tint.opacity(0.35)) }
        return g.interactive(interactive)
    }
    #endif

    /// Вид macOS 14–15 и облегчённого режима: сплошная заливка и тонкая рамка (или материал у плавающих).
    @ViewBuilder private func classic(_ content: Content, material: Bool) -> some View {
        if material {
            content
                .background(shape.fill(.regularMaterial))
                .overlay(shape.strokeBorder(.separator))
                .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
        } else {
            content
                .background(shape.fill(fill))
                .overlay(shape.strokeBorder(Color.primary.opacity(prominent ? 0 : 0.14), lineWidth: 1))
        }
    }

    private var fill: Color {
        if prominent, let tint { return tint }
        if let tint { return tint.opacity(0.10) }
        if floating { return Color(nsColor: .windowBackgroundColor) }
        return Color.primary.opacity(0.05)
    }
}

extension View {
    /// Подложка элемента управления заданной формы.
    func glassBackground<S: InsettableShape>(_ shape: S, tint: Color? = nil, prominent: Bool = false,
                                             interactive: Bool = false, floating: Bool = false) -> some View {
        modifier(GlassBackground(shape: shape, tint: tint, prominent: prominent, interactive: interactive, floating: floating))
    }

    /// Подложка в форме капсулы.
    func glassBackground(tint: Color? = nil, prominent: Bool = false, interactive: Bool = false) -> some View {
        glassBackground(Capsule(), tint: tint, prominent: prominent, interactive: interactive)
    }

    /// Крупная панель (всплывающее окно): стекло на macOS 26+, сплошное окно на прежних системах.
    func glassPanel<S: InsettableShape>(_ shape: S) -> some View {
        modifier(GlassPanel(shape: shape))
    }

    /// Главная кнопка формы: стеклянная акцентная на macOS 26+, обычная выделенная на прежних системах.
    @ViewBuilder func prominentGlassButton() -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) { self.buttonStyle(.glassProminent) } else { self.buttonStyle(.borderedProminent) }
        #else
        self.buttonStyle(.borderedProminent)
        #endif
    }

    /// Обычная кнопка: стеклянная на macOS 26+, обрамлённая на прежних системах.
    @ViewBuilder func glassButton() -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) { self.buttonStyle(.glass) } else { self.buttonStyle(.bordered) }
        #else
        self.buttonStyle(.bordered)
        #endif
    }
}

/// Группа стеклянных элементов: на macOS 26+ они преломляют друг друга и сливаются при сближении.
/// На прежних системах — просто содержимое.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 8
    @ViewBuilder var content: Content

    var body: some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
        #else
        content
        #endif
    }
}

private struct GlassPanel<S: InsettableShape>: ViewModifier {
    @Environment(\.look) private var look
    @Environment(\.colorScheme) private var scheme
    let shape: S

    @ViewBuilder func body(content: Content) -> some View {
        if look.lightMode {
            classic(content, shadow: false)
        } else {
            panel(content)
        }
    }

    @ViewBuilder private func panel(_ content: Content) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            content
                .clipShape(shape)
                .glassEffect(.regular, in: shape)
                .shadow(color: .black.opacity(scheme == .dark ? 0.35 : 0.18), radius: 30, y: 12)
        } else {
            classic(content, shadow: true)
        }
        #else
        classic(content, shadow: true)
        #endif
    }

    /// Как лист или окно macOS 14–15: сплошной фон окна, рамка и тень.
    private func classic(_ content: Content, shadow: Bool) -> some View {
        content
            .background(shape.fill(Color(nsColor: .windowBackgroundColor)))
            .clipShape(shape)
            .overlay(shape.strokeBorder(.separator))
            .shadow(color: .black.opacity(shadow ? 0.25 : 0), radius: 24, y: 10)
    }
}

// MARK: Переключатель

/// Переключатель всегда системный и потому сам подстраивается под версию macOS: на macOS 26+ это стеклянная
/// капсула-ползунок Liquid Glass, на 14–15 — переключатель этих версий. Отдельный стиль — чтобы все
/// переключатели приложения были одного вида.
struct GlassSwitchStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Toggle(configuration).toggleStyle(.switch)
    }
}

extension ToggleStyle where Self == GlassSwitchStyle {
    static var glassSwitch: GlassSwitchStyle { GlassSwitchStyle() }
}
