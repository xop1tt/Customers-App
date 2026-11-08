using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Customers.Core;

/// <summary>RSS/Atom-ленты (FL.ru и любые другие публичные ленты заказов).</summary>
public sealed class FeedSourceSettings
{
    public bool Enabled { get; set; } = true;
    public double IntervalHours { get; set; } = 2;
    public List<string> Feeds { get; set; } = ["https://www.fl.ru/rss/all.xml"];

    /// <summary>Пусто — в оценку идут все записи.</summary>
    public List<string> Keywords { get; set; } = [];
}

/// <summary>Публичные Telegram-каналы через веб-превью t.me/s/&lt;канал&gt;.</summary>
public sealed class TelegramSourceSettings
{
    public bool Enabled { get; set; } = true;
    public double IntervalHours { get; set; } = 3;
    public List<string> Channels { get; set; } = ["teleworko", "vacanciesbest", "freetasks", "theyseeku"];
    public int MaxPages { get; set; } = 3;
    public List<string> Keywords { get; set; } = [.. SearchDefaults.OrderKeywords];
}

/// <summary>Открытые сообщества ВКонтакте (wall.get с бесплатным сервисным ключом).</summary>
public sealed class VKSourceSettings
{
    public bool Enabled { get; set; }
    public double IntervalHours { get; set; } = 3;
    public List<string> Communities { get; set; } = [];
    public int PageSize { get; set; } = 50;
    public int MaxPages { get; set; } = 2;

    public List<string> Keywords { get; set; } =
        ["сайт", "бот", "приложени", "разработ", "программист", "автоматизац", "crm", "парсер", "интеграц"];
}

/// <summary>Категория организаций OpenStreetMap.</summary>
public sealed class OSMCategory
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    public string Group { get; set; } = "";
    public List<string> Filters { get; set; } = [];
    public bool Enabled { get; set; } = true;
    public double Weight { get; set; } = 10;
}

/// <summary>Организации из OpenStreetMap через Overpass API.</summary>
public sealed class OSMSourceSettings
{
    public bool Enabled { get; set; } = true;
    public double IntervalHours { get; set; } = 120;
    public List<string> Regions { get; set; } = ["Ереван"];
    public List<OSMCategory> Categories { get; set; } = SearchDefaults.OsmCategories();
    public bool CheckWebsites { get; set; } = true;

    /// <summary>Одинаковый запрос регион × категория не чаще, чем раз в N дней.</summary>
    public double RefreshDays { get; set; } = 7;

    /// <summary>Повторная проверка уже известной организации.</summary>
    public double RecheckDays { get; set; } = 60;

    public int MaxNewPerRun { get; set; } = 40;
    public string Endpoint { get; set; } = "https://overpass-api.de/api/interpreter";
}

/// <summary>
/// Все настройки поиска пользователя. Хранятся в базе как JSON с теми же именами полей, что у macOS-версии
/// (camelCase): так настройки одинаково читаются на обеих платформах и синхронизируются через облако.
/// </summary>
public sealed class SearchSettings
{
    private static readonly JsonSerializerOptions Options = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    [JsonPropertyName("rss")]
    public FeedSourceSettings Rss { get; set; } = new();

    [JsonPropertyName("telegram")]
    public TelegramSourceSettings Telegram { get; set; } = new();

    [JsonPropertyName("vk")]
    public VKSourceSettings Vk { get; set; } = new();

    [JsonPropertyName("osm")]
    public OSMSourceSettings Osm { get; set; } = new();

    public bool IsEnabled(string key) => key switch {
        SourceKey.Rss => Rss.Enabled,
        SourceKey.Telegram => Telegram.Enabled,
        SourceKey.Vk => Vk.Enabled,
        SourceKey.Osm => Osm.Enabled,
        _ => false,
    };

    public double IntervalHours(string key) => key switch {
        SourceKey.Rss => Rss.IntervalHours,
        SourceKey.Telegram => Telegram.IntervalHours,
        SourceKey.Vk => Vk.IntervalHours,
        SourceKey.Osm => Osm.IntervalHours,
        _ => 24,
    };

    /// <summary>
    /// Настройки нового пользователя: регионы, каналы и слова пустые, их выбирает сам человек
    /// (мастер предлагает регион по геолокации). Остальное как по умолчанию.
    /// </summary>
    public static SearchSettings BlankStart()
    {
        var s = new SearchSettings();
        s.Osm.Regions = [];
        s.Telegram.Channels = [];
        s.Telegram.Keywords = [];
        return s;
    }

    /// <summary>Сохранённые настройки, а для нового пользователя (в базе ничего нет) пустой старт.</summary>
    public static SearchSettings Stored(string? json) => string.IsNullOrWhiteSpace(json) ? BlankStart() : Decode(json);

    /// <summary>Читает настройки; любой сбой — настройки по умолчанию (как в macOS-версии).</summary>
    public static SearchSettings Decode(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return new SearchSettings();
        }

        try
        {
            var settings = JsonSerializer.Deserialize<SearchSettings>(json, Options) ?? new SearchSettings();
            settings.Osm.Categories = SearchDefaults.MergeCategories(settings.Osm.Categories);
            return settings;
        }
        catch (JsonException)
        {
            return new SearchSettings();
        }
    }

    public string Encoded() => JsonStable.Serialize(JsonSerializer.SerializeToNode(this, Options));

    public SearchSettings Clone() => Decode(Encoded());
}

/// <summary>Секреты, которые нужны источникам. Хранит их приложение (защищённое хранилище), а не настройки.</summary>
public sealed record SearchSecrets(string? VkToken = null);

public static class SearchDefaults
{
    public static readonly string[] OrderKeywords =
    [
        "сайт", "бот", "приложени", "разработ", "программист", "автоматизац", "crm", "срм", "парсер", "интеграц",
        "лендинг", "верстк", "доработ", "интернет-магазин", "telegram", "телеграм", "python", "api",
    ];

    public static List<OSMCategory> OsmCategories() =>
    [
        new() { Key = "beauty", Label = "Салоны красоты", Group = "beauty", Filters = ["[\"shop\"=\"beauty\"]", "[\"shop\"=\"hairdresser\"]"], Weight = 20 },
        new() { Key = "dance", Label = "Танцевальные студии", Group = "dance", Filters = ["[\"leisure\"=\"dance\"]", "[\"amenity\"=\"dancing_school\"]"], Weight = 20 },
        new() { Key = "restaurant", Label = "Рестораны", Group = "restaurant", Filters = ["[\"amenity\"=\"restaurant\"]"], Weight = 12 },
        new() { Key = "cafe", Label = "Кафе", Group = "restaurant", Filters = ["[\"amenity\"=\"cafe\"]"], Weight = 10 },
        new() { Key = "education", Label = "Образовательные центры", Group = "education", Filters = ["[\"amenity\"=\"language_school\"]", "[\"amenity\"=\"training\"]", "[\"amenity\"=\"music_school\"]"], Weight = 15 },
        new() { Key = "medical", Label = "Медицина и косметология", Group = "medical", Filters = ["[\"amenity\"=\"dentist\"]", "[\"healthcare\"=\"clinic\"]", "[\"amenity\"=\"clinic\"]"], Weight = 15 },
        new() { Key = "fitness", Label = "Спорт и фитнес", Group = "fitness", Filters = ["[\"leisure\"=\"fitness_centre\"]", "[\"leisure\"=\"sports_centre\"]"], Weight = 15 },
        new() { Key = "shops", Label = "Магазины", Group = "shop", Filters = ["[\"shop\"=\"clothes\"]", "[\"shop\"=\"gift\"]", "[\"shop\"=\"florist\"]"], Weight = 10 },
        new() { Key = "massage", Label = "Массаж и SPA", Group = "beauty", Filters = ["[\"shop\"=\"massage\"]", "[\"leisure\"=\"sauna\"]"], Enabled = false, Weight = 15 },
        new() { Key = "tattoo", Label = "Тату-салоны", Group = "beauty", Filters = ["[\"shop\"=\"tattoo\"]"], Enabled = false, Weight = 14 },
        new() { Key = "cosmetics", Label = "Косметика и парфюмерия", Group = "beauty", Filters = ["[\"shop\"=\"cosmetics\"]", "[\"shop\"=\"perfumery\"]"], Enabled = false, Weight = 10 },
        new() { Key = "doctors", Label = "Частные врачи", Group = "medical", Filters = ["[\"amenity\"=\"doctors\"]", "[\"healthcare\"=\"doctor\"]"], Enabled = false, Weight = 14 },
        new() { Key = "physio", Label = "Реабилитация и физиотерапия", Group = "medical", Filters = ["[\"healthcare\"=\"physiotherapist\"]", "[\"healthcare\"=\"alternative\"]"], Enabled = false, Weight = 13 },
        new() { Key = "optics", Label = "Оптики", Group = "medical", Filters = ["[\"shop\"=\"optician\"]"], Enabled = false, Weight = 12 },
        new() { Key = "vet", Label = "Ветеринарные клиники", Group = "medical", Filters = ["[\"amenity\"=\"veterinary\"]"], Enabled = false, Weight = 13 },
        new() { Key = "pharmacy", Label = "Аптеки", Group = "medical", Filters = ["[\"amenity\"=\"pharmacy\"]"], Enabled = false, Weight = 8 },
        new() { Key = "fastfood", Label = "Фастфуд", Group = "restaurant", Filters = ["[\"amenity\"=\"fast_food\"]"], Enabled = false, Weight = 8 },
        new() { Key = "bar", Label = "Бары и пабы", Group = "restaurant", Filters = ["[\"amenity\"=\"bar\"]", "[\"amenity\"=\"pub\"]"], Enabled = false, Weight = 10 },
        new() { Key = "bakery", Label = "Пекарни и кондитерские", Group = "restaurant", Filters = ["[\"shop\"=\"bakery\"]", "[\"shop\"=\"confectionery\"]"], Enabled = false, Weight = 10 },
        new() { Key = "catering", Label = "Кейтеринг", Group = "restaurant", Filters = ["[\"craft\"=\"caterer\"]"], Enabled = false, Weight = 12 },
        new() { Key = "hotel", Label = "Отели и гостевые дома", Group = "hospitality", Filters = ["[\"tourism\"=\"hotel\"]", "[\"tourism\"=\"guest_house\"]", "[\"tourism\"=\"hostel\"]", "[\"tourism\"=\"motel\"]"], Enabled = false, Weight = 16 },
        new() { Key = "apartments", Label = "Апартаменты и посуточная аренда", Group = "hospitality", Filters = ["[\"tourism\"=\"apartment\"]", "[\"tourism\"=\"chalet\"]"], Enabled = false, Weight = 14 },
        new() { Key = "travel", Label = "Турагентства", Group = "hospitality", Filters = ["[\"shop\"=\"travel_agency\"]"], Enabled = false, Weight = 14 },
        new() { Key = "kindergarten", Label = "Детские сады и центры", Group = "education", Filters = ["[\"amenity\"=\"kindergarten\"]", "[\"amenity\"=\"childcare\"]"], Enabled = false, Weight = 12 },
        new() { Key = "driving", Label = "Автошколы", Group = "education", Filters = ["[\"amenity\"=\"driving_school\"]"], Enabled = false, Weight = 15 },
        new() { Key = "tutoring", Label = "Репетиторы и учебные центры", Group = "education", Filters = ["[\"office\"=\"educational_institution\"]", "[\"amenity\"=\"prep_school\"]"], Enabled = false, Weight = 13 },
        new() { Key = "yoga", Label = "Йога и студии", Group = "fitness", Filters = ["[\"sport\"=\"yoga\"]", "[\"sport\"=\"pilates\"]"], Enabled = false, Weight = 15 },
        new() { Key = "pools", Label = "Бассейны и водный спорт", Group = "fitness", Filters = ["[\"leisure\"=\"swimming_pool\"][\"access\"!=\"private\"]", "[\"leisure\"=\"water_park\"]"], Enabled = false, Weight = 9 },
        new() { Key = "martial", Label = "Единоборства и спортивные секции", Group = "fitness", Filters = ["[\"sport\"=\"martial_arts\"]", "[\"sport\"=\"boxing\"]", "[\"sport\"=\"karate\"]"], Enabled = false, Weight = 13 },
        new() { Key = "carrepair", Label = "Автосервисы", Group = "auto", Filters = ["[\"shop\"=\"car_repair\"]", "[\"craft\"=\"mechanic\"]"], Enabled = false, Weight = 16 },
        new() { Key = "cardealer", Label = "Автосалоны", Group = "auto", Filters = ["[\"shop\"=\"car\"]"], Enabled = false, Weight = 14 },
        new() { Key = "carparts", Label = "Автозапчасти и шины", Group = "auto", Filters = ["[\"shop\"=\"car_parts\"]", "[\"shop\"=\"tyres\"]"], Enabled = false, Weight = 12 },
        new() { Key = "carwash", Label = "Автомойки", Group = "auto", Filters = ["[\"amenity\"=\"car_wash\"]"], Enabled = false, Weight = 12 },
        new() { Key = "lawyer", Label = "Юристы и нотариусы", Group = "services", Filters = ["[\"office\"=\"lawyer\"]", "[\"office\"=\"notary\"]"], Enabled = false, Weight = 16 },
        new() { Key = "accountant", Label = "Бухгалтерия и аудит", Group = "services", Filters = ["[\"office\"=\"accountant\"]", "[\"office\"=\"tax_advisor\"]"], Enabled = false, Weight = 15 },
        new() { Key = "realty", Label = "Агентства недвижимости", Group = "services", Filters = ["[\"office\"=\"estate_agent\"]"], Enabled = false, Weight = 18 },
        new() { Key = "insurance", Label = "Страхование", Group = "services", Filters = ["[\"office\"=\"insurance\"]"], Enabled = false, Weight = 12 },
        new() { Key = "itcompany", Label = "IT-компании", Group = "services", Filters = ["[\"office\"=\"it\"]"], Enabled = false, Weight = 10 },
        new() { Key = "advertising", Label = "Рекламные и маркетинговые агентства", Group = "services", Filters = ["[\"office\"=\"advertising_agency\"]", "[\"office\"=\"marketing\"]"], Enabled = false, Weight = 14 },
        new() { Key = "architect", Label = "Архитекторы и дизайнеры", Group = "services", Filters = ["[\"office\"=\"architect\"]"], Enabled = false, Weight = 15 },
        new() { Key = "photo", Label = "Фотостудии и фотографы", Group = "services", Filters = ["[\"craft\"=\"photographer\"]", "[\"shop\"=\"photo\"]"], Enabled = false, Weight = 14 },
        new() { Key = "print", Label = "Типографии и копицентры", Group = "services", Filters = ["[\"shop\"=\"copyshop\"]", "[\"craft\"=\"printer\"]"], Enabled = false, Weight = 12 },
        new() { Key = "cleaning", Label = "Прачечные и химчистки", Group = "services", Filters = ["[\"shop\"=\"laundry\"]", "[\"shop\"=\"dry_cleaning\"]"], Enabled = false, Weight = 10 },
        new() { Key = "tailor", Label = "Ателье и пошив", Group = "services", Filters = ["[\"craft\"=\"tailor\"]", "[\"shop\"=\"tailor\"]", "[\"shop\"=\"fabric\"]"], Enabled = false, Weight = 11 },
        new() { Key = "repair", Label = "Ремонт техники и телефонов", Group = "services", Filters = ["[\"craft\"=\"electronics_repair\"]", "[\"shop\"=\"mobile_phone\"]"], Enabled = false, Weight = 12 },
        new() { Key = "construction", Label = "Строительство и ремонт", Group = "construction", Filters = ["[\"office\"=\"construction_company\"]", "[\"craft\"=\"builder\"]", "[\"craft\"=\"carpenter\"]"], Enabled = false, Weight = 15 },
        new() { Key = "engineering", Label = "Электрики, сантехники, отопление", Group = "construction", Filters = ["[\"craft\"=\"electrician\"]", "[\"craft\"=\"plumber\"]", "[\"craft\"=\"hvac\"]"], Enabled = false, Weight = 12 },
        new() { Key = "furniture", Label = "Мебель и интерьер", Group = "home", Filters = ["[\"shop\"=\"furniture\"]", "[\"shop\"=\"interior_decoration\"]", "[\"shop\"=\"kitchen\"]"], Enabled = false, Weight = 14 },
        new() { Key = "hardware", Label = "Стройматериалы и инструменты", Group = "home", Filters = ["[\"shop\"=\"doityourself\"]", "[\"shop\"=\"hardware\"]", "[\"shop\"=\"trade\"]"], Enabled = false, Weight = 10 },
        new() { Key = "electronics", Label = "Электроника и компьютеры", Group = "retail", Filters = ["[\"shop\"=\"electronics\"]", "[\"shop\"=\"computer\"]", "[\"shop\"=\"appliance\"]"], Enabled = false, Weight = 10 },
        new() { Key = "jewelry", Label = "Ювелирные магазины", Group = "retail", Filters = ["[\"shop\"=\"jewelry\"]"], Enabled = false, Weight = 11 },
        new() { Key = "pets", Label = "Зоомагазины", Group = "retail", Filters = ["[\"shop\"=\"pet\"]", "[\"shop\"=\"pet_grooming\"]"], Enabled = false, Weight = 11 },
        new() { Key = "kids", Label = "Детские товары и игрушки", Group = "retail", Filters = ["[\"shop\"=\"toys\"]", "[\"shop\"=\"baby_goods\"]"], Enabled = false, Weight = 9 },
        new() { Key = "sports", Label = "Спортивные товары и велосипеды", Group = "retail", Filters = ["[\"shop\"=\"sports\"]", "[\"shop\"=\"bicycle\"]"], Enabled = false, Weight = 9 },
        new() { Key = "books", Label = "Книги и канцелярия", Group = "retail", Filters = ["[\"shop\"=\"books\"]", "[\"shop\"=\"stationery\"]"], Enabled = false, Weight = 8 },
        new() { Key = "events", Label = "Мероприятия и праздники", Group = "leisure", Filters = ["[\"amenity\"=\"events_venue\"]", "[\"shop\"=\"party\"]"], Enabled = false, Weight = 13 },
        new() { Key = "entertainment", Label = "Квесты, боулинг, кинотеатры", Group = "leisure", Filters = ["[\"leisure\"=\"escape_game\"]", "[\"leisure\"=\"bowling_alley\"]", "[\"amenity\"=\"cinema\"]"], Enabled = false, Weight = 11 },
        new() { Key = "nightclub", Label = "Ночные клубы", Group = "leisure", Filters = ["[\"amenity\"=\"nightclub\"]"], Enabled = false, Weight = 10 },
    ];

    /// <summary>Названия групп категорий OpenStreetMap для интерфейса.</summary>
    public static readonly IReadOnlyDictionary<string, string> OsmGroupTitles = new Dictionary<string, string> {
        ["beauty"] = "Красота и уход",
        ["dance"] = "Танцы",
        ["restaurant"] = "Питание",
        ["education"] = "Образование",
        ["medical"] = "Здоровье",
        ["fitness"] = "Спорт и фитнес",
        ["shop"] = "Магазины",
        ["retail"] = "Розница",
        ["hospitality"] = "Отели и туризм",
        ["auto"] = "Авто",
        ["services"] = "Услуги и офисы",
        ["construction"] = "Строительство",
        ["home"] = "Дом и интерьер",
        ["leisure"] = "Досуг и мероприятия",
    };

    /// <summary>Сохранённые категории пользователя плюс новые из каталога (выключенные): выбор пользователя не меняется.</summary>
    public static List<OSMCategory> MergeCategories(IEnumerable<OSMCategory> stored)
    {
        var list = stored.ToList();
        var known = list.Select(c => c.Key).ToHashSet();
        list.AddRange(OsmCategories().Where(c => !known.Contains(c.Key)));
        return list;
    }
}

/// <summary>Приведение того, что вводит пользователь, к виду, который понимает источник.</summary>
public static partial class SourceInput
{
    [GeneratedRegex(@"^[A-Za-z][A-Za-z0-9_]{3,31}$")]
    private static partial Regex ChannelRx();

    [GeneratedRegex(@"^[A-Za-z0-9_.]{2,64}$")]
    private static partial Regex VkRx();

    private static string StripPrefixes(string raw, string[] first, string[] second)
    {
        var s = raw.Trim();
        foreach (var p in first)
        {
            if (s.StartsWith(p, StringComparison.OrdinalIgnoreCase))
            {
                s = s[p.Length..];
            }
        }

        foreach (var p in second)
        {
            if (s.StartsWith(p, StringComparison.OrdinalIgnoreCase))
            {
                s = s[p.Length..];
            }
        }

        if (s.StartsWith('@'))
        {
            s = s[1..];
        }

        var cut = s.IndexOfAny(['/', '?']);
        return cut >= 0 ? s[..cut] : s;
    }

    /// <summary>«@name», «t.me/name», «https://t.me/s/name» → «name».</summary>
    public static string? TelegramChannel(string raw)
    {
        var s = StripPrefixes(raw, ["https://", "http://"], ["www.", "t.me/s/", "t.me/", "telegram.me/"]);
        return ChannelRx().IsMatch(s) ? s : null;
    }

    /// <summary>«https://vk.com/name» → «name».</summary>
    public static string? VkCommunity(string raw)
    {
        var s = StripPrefixes(raw, ["https://", "http://"], ["www.", "m.vk.com/", "vk.com/", "vk.ru/"]);
        return VkRx().IsMatch(s) ? s : null;
    }

    /// <summary>Адрес ленты: только публичный http(s).</summary>
    public static string? FeedUrl(string raw)
    {
        var s = raw.Trim();
        if (!s.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !s.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            s = "https://" + s;
        }

        return SiteChecker.IsPublicHttpUrl(s) ? s : null;
    }

    public static string? Keyword(string raw)
    {
        var s = raw.Trim().ToLowerInvariant();
        return s.Length == 0 ? null : s;
    }

    public static string? Region(string raw)
    {
        var s = raw.Trim().Replace("\"", "");
        return s.Length == 0 ? null : s;
    }

    /// <summary>Разбивает ввод на элементы: по запятым, точкам с запятой и строкам.</summary>
    public static List<string> Split(string text) =>
        text.Split([',', ';', '\n', '\r', '\t'], StringSplitOptions.None)
            .Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
}
