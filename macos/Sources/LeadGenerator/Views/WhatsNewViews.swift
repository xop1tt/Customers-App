import LeadGenCore
import LeadSearch
import SwiftUI

/// Окно «Что нового»: только то, что важно пользователю macOS, короткими фразами и с живыми превью.
/// Описание релиза проходит через `WhatsNewDigest`: без README, вики, рефакторинга и ссылок на GitHub.
struct WhatsNewSheet: View {
    @Environment(\.look) private var look
    let content: WhatsNewContent
    let onClose: () -> Void

    private var features: [WhatsNewFeature] { WhatsNewDigest.build(content.text, platform: .macOS) }

    var body: some View {
        VStack(spacing: 0) {
            hero
            ScrollView {
                VStack(spacing: 14) {
                    if features.isEmpty {
                        Text("Улучшили работу приложения и исправили ошибки.")
                            .foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 8)
                    }
                    ForEach(features) { FeatureCard(feature: $0) }
                }
                .padding(.horizontal, 24).padding(.vertical, 4)
            }
            .frame(minHeight: 200, maxHeight: 420)
            HStack {
                Spacer()
                Button("Продолжить", action: onClose)
                    .buttonStyle(.pillProminent)
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.horizontal, 24).padding(.vertical, 16)
        }
        .frame(width: 560)
        .accessibilityIdentifier("whats-new")
    }

    private var hero: some View {
        VStack(spacing: 6) {
            Image(systemName: "sparkles").font(.system(size: 30, weight: .semibold)).foregroundStyle(look.accentColor)
            Text("Что нового").font(.system(size: 24, weight: .bold))
            Text("Версия \(content.version)").font(.system(size: 13)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 26).padding(.bottom, 16)
    }
}

private struct FeatureCard: View {
    @Environment(\.look) private var look
    let feature: WhatsNewFeature

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            if let preview = feature.preview {
                WhatsNewPreviewView(kind: preview).frame(width: 190, height: 118)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(feature.title).font(.system(size: 14.5 * look.scale, weight: .semibold))
                ForEach(feature.items, id: \.self) { item in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Circle().fill(look.accentColor).frame(width: 5, height: 5).offset(y: -1)
                        Text(item).font(.system(size: 12.5 * look.scale)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.primary.opacity(0.045)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
    }
}

// MARK: - Превью

/// Небольшая анимация, показывающая новую возможность в действии. Кадр считается по времени, без состояния.
/// В облегчённом режиме анимации нет: показывается один выразительный кадр.
struct WhatsNewPreviewView: View {
    @Environment(\.look) private var look
    let kind: WhatsNewPreview

    private var period: Double {
        switch kind {
        case .sidebar: return 4.6
        case .exclusions: return 7.5
        case .power: return 6
        case .update: return 5
        default: return 4.5
        }
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: look.lightMode)) { ctx in
            let t = look.lightMode ? staticFrame : ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period)
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(nsColor: .windowBackgroundColor))
                demo(t)
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.primary.opacity(0.1)))
        }
        .accessibilityHidden(true)
    }

    private var staticFrame: Double {
        switch kind {
        case .sidebar: return 2.4
        case .exclusions: return 2.6
        case .power: return 4.6
        case .update: return 1.2
        default: return 1.5
        }
    }

    @ViewBuilder private func demo(_ t: Double) -> some View {
        switch kind {
        case .sidebar: SidebarDemo(t: t)
        case .settings: SettingsDemo(t: t)
        case .exclusions: ExclusionDemo(t: t)
        case .categories: CategoriesDemo(t: t)
        case .power: PowerDemo(t: t)
        case .update: UpdateDemo(t: t)
        case .adaptive: SettingsDemo(t: t)
        case .cloud: CloudDemo(t: t)
        }
    }
}

private func seg(_ t: Double, _ a: Double, _ b: Double) -> Double { min(max((t - a) / (b - a), 0), 1) }
private func ease(_ x: Double) -> Double { x * x * (3 - 2 * x) }

/// Курсор подходит к левому краю — панель выезжает, уходит — панель убирается.
private struct SidebarDemo: View {
    let t: Double
    @Environment(\.look) private var look

    var body: some View {
        let x: Double = t < 1.2 ? 170 - 164 * ease(seg(t, 0.4, 1.2))
            : (t < 3.0 ? 6 + 44 * ease(seg(t, 2.0, 2.6)) : 50 + 120 * ease(seg(t, 3.0, 3.8)))
        let panel: Double = t < 3.4 ? ease(seg(t, 1.4, 1.9)) : 1 - ease(seg(t, 3.9, 4.4))
        ZStack(alignment: .topLeading) {
            VStack(alignment: .leading, spacing: 7) {
                ForEach(0..<5, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 3).fill(Color.primary.opacity(i == 0 ? 0.18 : 0.09)).frame(width: i == 0 ? 90 : 130 - Double(i) * 12, height: 8)
                }
            }
            .padding(.leading, 16).padding(.top, 16)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(0..<4, id: \.self) { i in
                    HStack(spacing: 6) {
                        Circle().fill(i == 0 ? look.accentColor : Color.primary.opacity(0.25)).frame(width: 7, height: 7)
                        RoundedRectangle(cornerRadius: 2).fill(Color.primary.opacity(0.2)).frame(width: 30, height: 6)
                    }
                }
            }
            .padding(10)
            .frame(width: 70, height: 118, alignment: .topLeading)
            .background(Rectangle().fill(.regularMaterial))
            .overlay(Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 1), alignment: .trailing)
            .offset(x: -70 * (1 - panel))
            Image(systemName: "cursorarrow").font(.system(size: 15)).foregroundStyle(.primary)
                .offset(x: x, y: 52)
        }
        .frame(width: 190, height: 118, alignment: .topLeading)
    }
}

/// Окно настроек: строки подсвечиваются по очереди.
private struct SettingsDemo: View {
    let t: Double
    @Environment(\.look) private var look

    var body: some View {
        let active = Int(t / 1.1) % 4
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: 4).fill(Color.primary.opacity(0.1)).frame(height: 10)
                ForEach(0..<4, id: \.self) { i in
                    HStack(spacing: 5) {
                        Circle().fill(i == active ? look.accentColor : Color.primary.opacity(0.25)).frame(width: 6, height: 6)
                        RoundedRectangle(cornerRadius: 2).fill(Color.primary.opacity(i == active ? 0.35 : 0.15)).frame(height: 6)
                    }
                    .padding(.horizontal, 4).padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 5).fill(i == active ? Color.primary.opacity(0.1) : .clear))
                }
                Spacer(minLength: 0)
            }
            .padding(8).frame(width: 66).background(Color.primary.opacity(0.05))
            VStack(alignment: .leading, spacing: 8) {
                RoundedRectangle(cornerRadius: 3).fill(Color.primary.opacity(0.4)).frame(width: 60, height: 9)
                ForEach(0..<3, id: \.self) { i in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            RoundedRectangle(cornerRadius: 2).fill(Color.primary.opacity(0.25)).frame(width: 46, height: 6)
                            RoundedRectangle(cornerRadius: 2).fill(Color.primary.opacity(0.12)).frame(width: 64, height: 5)
                        }
                        Spacer()
                        Capsule().fill(((Int(t * 1.5) + i) % 2 == 0) ? look.accentColor : Color.primary.opacity(0.2)).frame(width: 18, height: 10)
                    }
                    Divider()
                }
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }
}

/// В поле вводятся значения разных форматов, формат определяется настоящей функцией приложения.
private struct ExclusionDemo: View {
    let t: Double
    private let samples = ["example.ru", "+7 843 212-48-90", "name@mail.ru"]

    var body: some View {
        let slot = 2.5
        let index = Int(t / slot) % samples.count
        let local = t.truncatingRemainder(dividingBy: slot)
        let sample = samples[index]
        let typed = Int(Double(sample.count) * min(local / 1.4, 1))
        let text = String(sample.prefix(typed))
        let kind = typed == sample.count ? ExclusionKind.detect(sample)?.title : nil
        VStack(alignment: .leading, spacing: 10) {
            Text("Исключение").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            HStack(spacing: 0) {
                Text(text + (Int(t * 2) % 2 == 0 && kind == nil ? "|" : "")).font(.system(size: 11.5, design: .monospaced))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.07)))
            HStack(spacing: 6) {
                Image(systemName: kind == nil ? "ellipsis" : "checkmark.circle.fill").foregroundStyle(kind == nil ? Color.secondary : .green)
                Text(kind.map { "Определено: \($0)" } ?? "Определяю формат…").font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
        .padding(14).frame(width: 190, height: 118, alignment: .topLeading)
    }
}

/// Группы категорий OpenStreetMap появляются по очереди; числа взяты из настоящего каталога.
private struct CategoriesDemo: View {
    let t: Double
    private var groups: [(String, Int)] {
        var counts: [String: Int] = [:]
        for c in SearchDefaults.osmCategories { counts[c.group, default: 0] += 1 }
        return counts.sorted { $0.value > $1.value }.prefix(6).map { (SearchDefaults.osmGroupTitles[$0.key] ?? $0.key, $0.value) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Категории организаций: \(SearchDefaults.osmCategories.count)")
                .font(.system(size: 10.5, weight: .semibold)).foregroundStyle(.secondary)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 5), GridItem(.flexible(), spacing: 5)], spacing: 5) {
                ForEach(Array(groups.enumerated()), id: \.offset) { i, g in
                    let shown = ease(seg(t, Double(i) * 0.3, Double(i) * 0.3 + 0.4))
                    HStack(spacing: 4) {
                        Text(g.0).lineLimit(1)
                        Text("\(g.1)").foregroundStyle(.secondary)
                    }
                    .font(.system(size: 9.5, weight: .medium))
                    .padding(.horizontal, 6).padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.15)))
                    .opacity(shown).scaleEffect(0.9 + 0.1 * shown)
                }
            }
        }
        .padding(12).frame(width: 190, height: 118, alignment: .topLeading)
    }
}

/// Заряд падает; ниже порога включается облегчённый режим (решает настоящая политика приложения).
private struct PowerDemo: View {
    let t: Double

    var body: some View {
        let percent = Int(45 - 30 * ease(seg(t, 0.5, 4.5)))
        let reason = PowerPolicy.evaluate(PowerState(batteryPercent: percent, charging: false), automatic: true, threshold: PowerPolicy.defaultThreshold)
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: percent < 20 ? "battery.25" : "battery.50").font(.system(size: 22))
                    .foregroundStyle(percent < 20 ? Color.orange : .primary)
                Text("\(percent)%").font(.system(size: 18, weight: .semibold)).monospacedDigit()
            }
            HStack(spacing: 6) {
                Image(systemName: reason == nil ? "sparkles" : "leaf.fill").foregroundStyle(reason == nil ? Color.accentColor : .green)
                Text(reason == nil ? "Все эффекты включены" : "Облегчённый режим").font(.system(size: 11, weight: .medium))
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Capsule().fill((reason == nil ? Color.accentColor : Color.green).opacity(0.14)))
        }
        .frame(width: 190, height: 118)
    }
}

/// Кнопка «Обновить»: загрузка, затем установка.
private struct UpdateDemo: View {
    let t: Double

    var body: some View {
        let progress = ease(seg(t, 0.6, 3.4))
        VStack(spacing: 10) {
            HStack(spacing: 6) {
                if progress < 1 { ProgressView(value: progress).progressViewStyle(.circular).controlSize(.small) }
                else { Image(systemName: "arrow.down.circle.fill") }
                Text(progress < 1 ? "Загрузка…" : "Обновить").font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(progress < 1 ? Color.primary : .white)
            .padding(.horizontal, 16).padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 8).fill(progress < 1 ? Color.primary.opacity(0.08) : Color.accentColor))
            Capsule().fill(Color.primary.opacity(0.1)).frame(width: 110, height: 4)
                .overlay(alignment: .leading) { Capsule().fill(Color.accentColor).frame(width: 110 * progress, height: 4) }
        }
        .frame(width: 190, height: 118)
    }
}

private struct CloudDemo: View {
    let t: Double

    var body: some View {
        let pulse = 0.5 + 0.5 * sin(t * 2.4)
        ZStack {
            Image(systemName: "icloud.fill").font(.system(size: 44)).foregroundStyle(Color.accentColor.opacity(0.35 + 0.35 * pulse))
            Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                .rotationEffect(.degrees(t * 90))
        }
        .frame(width: 190, height: 118)
    }
}
