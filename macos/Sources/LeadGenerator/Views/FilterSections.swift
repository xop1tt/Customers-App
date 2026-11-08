import LeadGenCore
import LeadSearch
import SwiftUI

/// Telegram-каналы и ключевые слова. Одни и те же секции стоят в разделе «Источники» и в мастере первой настройки:
/// логика и подсказки одинаковые, а приложение ничего не подставляет за пользователя.
struct TelegramChannelsSection: View {
    @Binding var channels: [String]
    var footer = "Читается веб-превью t.me/s/канал — только публичные каналы. Приватные каналы и чаты недоступны. Каналов по умолчанию нет: добавьте те, где публикуют заказы."

    var body: some View {
        Section {
            TokenListEditor(title: "Каналы", placeholder: "имя, @имя или ссылка t.me/имя",
                            items: $channels, normalize: SourceInput.telegramChannel,
                            invalidHint: "Имя канала: латиница, цифры и _, от 4 символов")
        } header: { Text("Публичные каналы") } footer: { Text(footer) }
    }
}

struct KeywordsSection: View {
    @Binding var keywords: [String]
    let footer: String

    var body: some View {
        Section {
            TokenListEditor(title: "Ключевые слова", placeholder: "слово или несколько через запятую",
                            items: $keywords, normalize: SourceInput.keyword, invalidHint: nil)
        } header: { Text("Ключевые слова") } footer: { Text(footer) }
    }
}

/// Регион для поиска организаций. Если регион ещё не задан, можно определить его по местоположению;
/// ничего не подставляется само, а ручной ввод доступен всегда.
struct RegionSection: View {
    @Binding var regions: [String]
    @State private var locator = RegionLocator()

    var body: some View {
        Section {
            TokenListEditor(title: "Города и регионы", placeholder: "например, Казань",
                            items: $regions, normalize: SourceInput.region,
                            invalidHint: "Название города или региона")
            HStack(spacing: 10) {
                Button { locator.locate() } label: { Label("Определить по местоположению", systemImage: "location") }
                    .disabled(locator.busy)
                if locator.busy { ProgressView().controlSize(.small) }
            }
            if let suggestion = locator.suggestion {
                HStack {
                    Label("Похоже, вы в регионе «\(suggestion)»", systemImage: "mappin.and.ellipse")
                    Spacer()
                    Button("Добавить") {
                        if !regions.contains(suggestion) { regions.append(suggestion) }
                        locator.suggestion = nil
                    }
                }
            }
            if let problem = locator.problem {
                Text(problem).font(.caption).foregroundStyle(.orange)
            }
        } header: { Text("Где искать организации") } footer: {
            Text("Название как в OpenStreetMap: на местном языке, по-русски или по-английски. Регион по умолчанию не задан: определите его по местоположению или введите вручную.")
        }
    }
}
