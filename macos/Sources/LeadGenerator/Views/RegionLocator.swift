import CoreLocation
import Foundation
import LeadGenCore
import Observation

/// Определяет город пользователя по местоположению (только по нажатию кнопки). Если доступ запрещён или
/// определить не удалось, сообщает об этом, и регион выбирается вручную.
@MainActor
@Observable
final class RegionLocator: NSObject, CLLocationManagerDelegate {
    var busy = false
    var suggestion: String?
    var problem: String?

    @ObservationIgnored private let manager = CLLocationManager()
    @ObservationIgnored private let geocoder = CLGeocoder()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    func locate() {
        problem = nil
        suggestion = nil
        guard CLLocationManager.locationServicesEnabled() else {
            problem = "Службы геолокации выключены. Введите регион вручную."
            return
        }
        busy = true
        switch manager.authorizationStatus {
        case .denied, .restricted:
            fail("Доступ к местоположению запрещён в настройках macOS. Введите регион вручную.")
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        default:
            manager.requestLocation()
        }
    }

    private func fail(_ text: String) { busy = false; problem = text }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            guard self.busy else { return }
            switch status {
            case .denied, .restricted: self.fail("Доступ к местоположению не выдан. Введите регион вручную.")
            case .notDetermined: break
            default: self.manager.requestLocation()
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in await self.resolve(location) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.fail("Не удалось определить местоположение. Введите регион вручную.") }
    }

    private func resolve(_ location: CLLocation) async {
        do {
            let marks = try await geocoder.reverseGeocodeLocation(location, preferredLocale: Locale(identifier: "ru_RU"))
            busy = false
            let p = marks.first
            if let name = RegionSuggestion.name(locality: p?.locality, subAdministrativeArea: p?.subAdministrativeArea,
                                                administrativeArea: p?.administrativeArea) {
                suggestion = name
            } else {
                problem = "Регион по местоположению не определился. Введите его вручную."
            }
        } catch {
            fail("Не удалось определить город по местоположению. Введите регион вручную.")
        }
    }
}
