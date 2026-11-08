using System.Text.Json;

namespace Customers.Core;

/// <summary>Название региона для поиска организаций по результату определения местоположения.</summary>
public static class RegionSuggestion
{
    private static readonly string[] Prefixes = ["городской округ ", "город ", "г. ", "муниципальный округ "];
    private static readonly string[] Suffixes = [" городской округ", " (город)"];

    /// <summary>
    /// Город или населённый пункт; если его нет — район или область. Лишние слова вроде «городской округ» убираются.
    /// null — местоположение не определилось, регион выбирает пользователь.
    /// </summary>
    public static string? Name(string? locality, string? subAdministrativeArea = null, string? administrativeArea = null)
    {
        foreach (var raw in new[] { locality, subAdministrativeArea, administrativeArea })
        {
            var s = (raw ?? "").Trim().Replace("\"", "", StringComparison.Ordinal);
            if (s.Length == 0)
            {
                continue;
            }

            foreach (var prefix in Prefixes)
            {
                if (s.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    s = s[prefix.Length..];
                }
            }

            foreach (var suffix in Suffixes)
            {
                if (s.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                {
                    s = s[..^suffix.Length];
                }
            }

            s = s.Trim();
            if (s.Length > 0)
            {
                return s;
            }
        }

        return null;
    }

    /// <summary>Добавляет предложенный регион, если пользователь ещё ничего не выбрал: уже заданное не трогаем.</summary>
    public static List<string> Applying(string? suggestion, IReadOnlyList<string> regions) =>
        regions.Count == 0 && !string.IsNullOrEmpty(suggestion) ? [suggestion] : [.. regions];

    /// <summary>Ответ обратного геокодирования Nominatim (accept-language=ru): город, район или область.</summary>
    public static string? FromNominatim(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("address", out var a) || a.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            string? Get(string key) => a.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            return Name(Get("city") ?? Get("town") ?? Get("village") ?? Get("municipality"), Get("county") ?? Get("district"), Get("state"));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Адрес запроса обратного геокодирования Nominatim для координат (город или район, по-русски).</summary>
    public static Uri NominatimUrl(double latitude, double longitude) => new(string.Create(System.Globalization.CultureInfo.InvariantCulture,
        $"https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&accept-language=ru&lat={latitude:0.#####}&lon={longitude:0.#####}"));

    /// <summary>Название региона по координатам или null, если сервис недоступен или ничего не нашёл. Сеть не обязательна: вызывающий предложит ввести вручную.</summary>
    public static async Task<string?> ReverseAsync(IHttpTransport transport, double latitude, double longitude, CancellationToken ct = default)
    {
        if (double.IsNaN(latitude) || double.IsNaN(longitude) || Math.Abs(latitude) > 90 || Math.Abs(longitude) > 180)
        {
            return null;
        }

        var request = new HttpRequestSpec { Url = NominatimUrl(latitude, longitude), Timeout = TimeSpan.FromSeconds(15) };
        request.Headers["User-Agent"] = SourceHttp.UserAgent;
        try
        {
            var response = await transport.SendAsync(request, ct).ConfigureAwait(false);
            return response.Status is >= 200 and < 300 ? FromNominatim(response.Text) : null;
        }
        catch (Exception e) when (e is HttpFailure or HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return null;
        }
    }
}
