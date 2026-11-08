import Foundation
import IOKit.ps
import LeadGenCore

/// Следит за режимом энергосбережения macOS и зарядом батареи и сообщает об этом настройкам внешнего вида.
/// Заряд читается из IOKit; на Mac без батареи (настольный) известен только режим энергосбережения.
@MainActor
final class PowerMonitor {
    static let shared = PowerMonitor()
    private var timer: Timer?
    private var observer: NSObjectProtocol?
    private weak var look: AppearanceSettings?

    func start(look: AppearanceSettings) {
        self.look = look
        guard timer == nil else { return }
        refresh()
        // Смена режима энергосбережения приходит уведомлением, заряд проверяется раз в полминуты.
        observer = NotificationCenter.default.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() { look?.updatePower(Self.read()) }

    nonisolated static func read() -> PowerState {
        var state = PowerState(systemSaver: ProcessInfo.processInfo.isLowPowerModeEnabled)
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { return state }
        for source in list {
            guard let d = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
                  d[kIOPSTypeKey] as? String == kIOPSInternalBatteryType else { continue }
            if let cur = d[kIOPSCurrentCapacityKey] as? Int, let max = d[kIOPSMaxCapacityKey] as? Int, max > 0 {
                state.batteryPercent = Swift.min(100, cur * 100 / max)
            }
            if let isCharging = d[kIOPSIsChargingKey] as? Bool {
                state.charging = isCharging || d[kIOPSPowerSourceStateKey] as? String == kIOPSACPowerValue
            }
            break
        }
        return state
    }
}
