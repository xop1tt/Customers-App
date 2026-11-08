using System.Runtime.InteropServices;
using Windows.Devices.Geolocation;

namespace Customers.Ui;

/// <summary>Результат определения региона: либо название, либо понятная причина, почему не вышло (тогда регион вводят вручную).</summary>
internal sealed record RegionLookup(string? Region, string? Problem);

/// <summary>
/// Определяет город по местоположению компьютера (Windows Location) и обратному геокодированию OpenStreetMap.
/// Ничего не подставляется молча: вызывающий показывает результат и даёт его принять или заменить вручную.
/// </summary>
internal static class RegionLocator
{
    public static async Task<RegionLookup> LocateAsync(IHttpTransport transport, CancellationToken ct = default)
    {
        try
        {
            var access = await Geolocator.RequestAccessAsync();
            if (access != GeolocationAccessStatus.Allowed)
            {
                return new RegionLookup(null, "Доступ к местоположению выключен в параметрах Windows (Конфиденциальность → Расположение). Введите регион вручную.");
            }

            var locator = new Geolocator { DesiredAccuracyInMeters = 5000 };
            var position = await locator.GetGeopositionAsync(TimeSpan.FromMinutes(10), TimeSpan.FromSeconds(12)).AsTask(ct);
            var point = position.Coordinate.Point.Position;
            var region = await RegionSuggestion.ReverseAsync(transport, point.Latitude, point.Longitude, ct);
            return region is null
                ? new RegionLookup(null, "Не удалось узнать название города по координатам (нет сети или сервис недоступен). Введите регион вручную.")
                : new RegionLookup(region, null);
        }
        catch (Exception e) when (e is COMException or UnauthorizedAccessException or InvalidOperationException or TimeoutException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return new RegionLookup(null, "Местоположение недоступно на этом компьютере. Введите регион вручную.");
        }
    }
}
