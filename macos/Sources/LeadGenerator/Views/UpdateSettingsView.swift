import LeadGenCore
import SwiftUI

/// «Настройки → Обновления»: версия, проверка и автоматические обновления с GitHub.
struct UpdateSettingsView: View {
    @State private var updates = UpdateController.shared

    var body: some View {
        @Bindable var updates = updates
        SettingsPage {
            SettingsGroup(title: "Версия") {
                SettingRow(title: "Установлена", detail: updates.lastCheck.map { "Последняя проверка: \($0.fullRu)" }) {
                    Text(updates.current?.description ?? "сборка без номера версии")
                        .font(.system(size: 13)).foregroundStyle(.secondary)
                }
                RowDivider()
                SettingRow(title: "Проверить обновления", detail: status.isEmpty ? nil : status) {
                    HStack(spacing: 8) {
                        if busy { ProgressView().controlSize(.small) }
                        Button("Проверить сейчас") { updates.check(manual: true) }
                            .buttonStyle(.pill)
                            .disabled(busy || !updates.canUpdate)
                    }
                }
                if updates.buttonState != .hidden {
                    RowDivider()
                    SettingRow(title: actionTitle, detail: "То же действие, что у кнопки «Обновить» в боковой панели") {
                        Button(actionButton) { updates.performButtonAction() }
                            .buttonStyle(.pillProminent)
                            .disabled(busy)
                    }
                }
            }
            SettingsGroup(title: "Автоматически",
                          footer: "Новая версия скачивается и проверяется, пока вы работаете, и ждёт кнопки «Обновить» в боковой панели. Без вашего согласия приложение не перезапускается. На подключении с экономией трафика фоновая загрузка откладывается.") {
                SettingRow(title: "Проверять обновления автоматически") {
                    Toggle("", isOn: $updates.automatic).labelsHidden().toggleStyle(.switch)
                }
                RowDivider()
                SettingRow(title: "Частота проверки") {
                    MenuPicker(selection: $updates.intervalHours) {
                        ForEach(UpdateController.intervals, id: \.hours) { Text($0.title).tag($0.hours) }
                    }
                    .disabled(!updates.automatic)
                }
                RowDivider()
                SettingRow(title: "Скачивать обновления в фоне") {
                    Toggle("", isOn: $updates.backgroundDownload).labelsHidden().toggleStyle(.switch)
                        .disabled(!updates.automatic)
                }
            }
            SettingsGroup(title: "Как это работает") {
                VStack(alignment: .leading, spacing: 10) {
                    Text("С выбранной частотой приложение спрашивает у GitHub, вышел ли новый релиз. Если вышел, на кнопке «Обновить» появится значок загрузки: приложение скачает установщик, сверит контрольную сумму SHA-256, заменит себя и перезапустится. Без вашего согласия ничего не устанавливается.")
                    Text("Проверка бесплатная и без учётной записи: используется публичная страница релизов. Приложение подписано без сертификата Apple, поэтому подлинность проверяется только по сумме из того же релиза.")
                    Link("Все версии на GitHub", destination: Updates.releasesPage)
                }
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 12)
            }
        }
    }

    private var busy: Bool {
        switch updates.phase {
        case .checking, .downloading, .installing: return true
        default: return false
        }
    }

    private var actionTitle: String {
        switch updates.buttonState {
        case .available(let v): return "Доступна версия \(v)"
        case .ready(let v): return "Версия \(v) готова к установке"
        case .retry(let v): return "Не удалось обновить до \(v)"
        case .downloading: return "Загрузка обновления"
        case .installing: return "Установка"
        case .hidden: return ""
        }
    }

    private var actionButton: String {
        switch updates.buttonState {
        case .ready: return "Установить и перезапустить"
        case .retry: return "Повторить"
        default: return "Скачать и установить"
        }
    }

    private var status: String {
        switch updates.phase {
        case .idle: return ""
        case .checking: return "Проверяю…"
        case .upToDate: return "Установлена последняя версия"
        case .available(let v): return "Доступна версия \(v)"
        case .downloading: return "Скачиваю и проверяю…"
        case .ready(let v): return "Версия \(v) скачана и готова к установке"
        case .installing: return "Устанавливаю…"
        case .failed(let why): return why
        }
    }
}
