using System.Text.RegularExpressions;

namespace Customers.Core;

/// <summary>Платформа, для которой показывается «Что нового».</summary>
public enum ReleasePlatform
{
    MacOS,
    Windows,
}

/// <summary>Тема группы изменений в окне «Что нового».</summary>
public enum WhatsNewTopic
{
    Interface,
    Search,
    Data,
    Updates,
    Power,
    Other,
}

/// <summary>Что показывает превью рядом с группой изменений.</summary>
public enum WhatsNewPreview
{
    Sidebar,
    Settings,
    Adaptive,
    Exclusions,
    Categories,
    Power,
    Update,
    Cloud,
}

public sealed record WhatsNewFeature(WhatsNewTopic Topic, IReadOnlyList<string> Items, WhatsNewPreview? Preview)
{
    public string Title => WhatsNewDigest.TopicTitle(Topic);
}

/// <summary>
/// Превращает описание релиза в короткий список полезных пользователю изменений для одной платформы: без README, вики,
/// рефакторинга, CI, ссылок на GitHub и изменений другой платформы, со сгруппированными и переформулированными пунктами.
/// Правила те же, что у macOS-версии (WhatsNewDigest.swift).
/// </summary>
public static partial class WhatsNewDigest
{
    public const int MaxItemsPerTopic = 4;
    public const int MaxItemLength = 110;

    public static string TopicTitle(WhatsNewTopic topic) => topic switch {
        WhatsNewTopic.Interface => "Улучшили и доработали интерфейс",
        WhatsNewTopic.Search => "Стало удобнее искать лиды",
        WhatsNewTopic.Data => "Данные, облако и интеграции",
        WhatsNewTopic.Updates => "Запуск и обновления",
        WhatsNewTopic.Power => "Экономия энергии",
        _ => "Другие улучшения",
    };

    public static IReadOnlyList<WhatsNewFeature> Build(string? markdown, ReleasePlatform platform)
    {
        var byTopic = new Dictionary<WhatsNewTopic, List<string>>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var sectionOk = true;
        ReleasePlatform? sectionPlatform = null;
        var sectionTitleLow = "";

        var text = (markdown ?? "").Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
        foreach (var raw in text.Split('\n'))
        {
            var trimmed = raw.Trim();
            if (trimmed.Length == 0)
            {
                continue;
            }

            if (trimmed.StartsWith('#'))
            {
                var head = Clean(trimmed.TrimStart('#', ' ')).ToLowerInvariant();
                sectionTitleLow = head;
                sectionOk = !IsServiceSection(head);
                sectionPlatform = Only(head);
                continue;
            }

            if (!sectionOk || ParseBullet(trimmed) is not { } item)
            {
                continue;
            }

            var itemLow = item.Full.ToLowerInvariant().Replace('ё', 'е');
            if ((Only(item.Full.ToLowerInvariant()) ?? sectionPlatform) is { } p && p != platform)
            {
                continue;
            }

            if (IsTechnical(itemLow))
            {
                continue;
            }

            var shortText = Shorten(item);
            if (shortText.Length == 0 || !seen.Add(shortText))
            {
                continue;
            }

            var low = (sectionTitleLow + " " + item.Full).ToLowerInvariant().Replace('ё', 'е');
            var topic = TopicOf(low);
            if (!byTopic.TryGetValue(topic, out var list))
            {
                byTopic[topic] = list = [];
            }

            list.Add(shortText);
        }

        var result = new List<WhatsNewFeature>();
        foreach (var topic in Enum.GetValues<WhatsNewTopic>())
        {
            if (byTopic.TryGetValue(topic, out var items) && items.Count > 0)
            {
                var kept = items.Take(MaxItemsPerTopic).ToList();
                result.Add(new WhatsNewFeature(topic, kept, PreviewFor(topic, kept, platform)));
            }
        }

        return result;
    }

    // MARK: Разбор

    private sealed record Bullet(string? Lead, string Rest, string Full);

    private static Bullet? ParseBullet(string line)
    {
        var m = BulletRx().Match(line);
        if (!m.Success)
        {
            return null;
        }

        var body = m.Groups[1].Value;
        // «**Название.** Описание»: жирное начало с точкой или двоеточием — заголовок пункта.
        // Жирное слово посреди фразы («**Быстрее** запуск») — просто выделение, фраза остаётся целой.
        if (BoldLeadRx().Match(body) is { Success: true } b)
        {
            var titleStyle = b.Groups[2].Value.Trim().Length > 0 || (b.Groups[1].Value.Length > 0 && ".:—".Contains(b.Groups[1].Value[^1], StringComparison.Ordinal));
            if (titleStyle)
            {
                var lead = Clean(b.Groups[1].Value).Trim('.', ':', '—', ' ');
                return new Bullet(lead.Length == 0 ? null : lead, Clean(b.Groups[3].Value), Clean(body));
            }
        }

        var c = Clean(body);
        return c.Length == 0 ? null : new Bullet(null, c, c);
    }

    /// <summary>Убирает разметку, ссылки, адреса и подписи «by @автор in …» из автоматических заметок GitHub.</summary>
    internal static string Clean(string s)
    {
        var t = AuthorRx().Replace(s, "");
        t = LinkRx().Replace(t, "$1");
        t = UrlRx().Replace(t, "");
        t = PullRefRx().Replace(t, "");
        t = t.Replace("**", "", StringComparison.Ordinal).Replace("__", "", StringComparison.Ordinal).Replace("`", "", StringComparison.Ordinal);
        return SpacesRx().Replace(t, " ").Trim();
    }

    private static string Shorten(Bullet b)
    {
        string phrase;
        if (b.Lead is { } lead)
        {
            // Короткий заголовок вроде «Название» без описания беден: добавляем первое предложение описания.
            var sentence = FirstSentence(b.Rest);
            phrase = sentence.Length == 0 ? lead : (lead.Length <= 14 ? sentence : lead);
        }
        else
        {
            phrase = FirstSentence(b.Rest);
        }

        phrase = phrase.Trim(' ', '.', ';', ':');
        if (phrase.Length < 4)
        {
            return "";
        }

        if (phrase.Length > MaxItemLength)
        {
            var cut = phrase[..MaxItemLength];
            var space = cut.LastIndexOf(' ');
            phrase = (space > 0 ? cut[..space] : cut) + "…";
        }

        return char.ToUpperInvariant(phrase[0]) + phrase[1..];
    }

    private static string FirstSentence(string s)
    {
        var m = SentenceEndRx().Match(s);
        return m.Success ? s[..m.Index] : s;
    }

    // MARK: Фильтры

    private static readonly string[] ServiceSections =
        ["установк", "install", "контрольн", "checksum", "sha", "full changelog", "new contributors", "новые участники", "скачать", "файлы", "assets"];

    private static bool IsServiceSection(string head) => ServiceSections.Any(s => head.Contains(s, StringComparison.Ordinal));

    /// <summary>Пункты для разработчиков: документация, CI, тесты, зависимости, внутренняя перестройка.</summary>
    private static readonly string[] TechnicalMarkers =
    [
        "readme", "wiki", "вики", "рефактор", "refactor", "workflow", "github actions", "ci:", " ci ", "dependabot", "bump",
        "зависимост", "автотест", "тесты", "тестов", "тестир", "unit", "test", "lint", "codeql", "swiftpm", "dotnet", ".yml", "pull request", "коммит", "commit",
        "опечатк", "typo", "full changelog", "changelog", "sha-256", "sha256", "контрольн", "sqlite", "миграци базы", "ci/cd",
        "документаци", "покрыти", "сборк", "xcode", "winui", "inno setup",
    ];

    private static bool IsTechnical(string low) => TechnicalMarkers.Any(m => low.Contains(m, StringComparison.Ordinal));

    /// <summary>Платформа, о которой говорит только этот текст; null, если не названа или названы обе.</summary>
    internal static ReleasePlatform? Only(string low)
    {
        var padded = " " + low + " ";
        string[] macWords = ["macos", "mac os", " mac ", "dock", "связк", "liquid glass", "строк меню", "строке меню", "dmg"];
        string[] winWords = ["windows", "винд", "winui", "трей", "проводник"];
        var mac = macWords.Any(w => padded.Contains(w, StringComparison.Ordinal));
        var win = winWords.Any(w => low.Contains(w, StringComparison.Ordinal));
        if (mac && !win)
        {
            return ReleasePlatform.MacOS;
        }

        return win && !mac ? ReleasePlatform.Windows : null;
    }

    // MARK: Темы

    private static WhatsNewTopic TopicOf(string low)
    {
        bool Has(params string[] words) => words.Any(w => low.Contains(w, StringComparison.Ordinal));
        if (Has("энергосбереж", "заряд", "батаре", "облегчен"))
        {
            return WhatsNewTopic.Power;
        }

        if (Has("что нового", "мастер", "первый запуск", "первоначальн", "автообновлен", "обновление приложени"))
        {
            return WhatsNewTopic.Updates;
        }

        if (Has("поиск", "источник", "лид", "категори", "openstreetmap", "osm", "telegram", "телеграм", "регион", "ключев", "исключен"))
        {
            return WhatsNewTopic.Search;
        }

        if (Has("облак", "синхрон", "резервн", "диск", "экспорт", "импорт", "crm", "интеграц", "почт", "звонк"))
        {
            return WhatsNewTopic.Data;
        }

        return Has("интерфейс", "окн", "панел", "дизайн", "оформлен", "темн", "светл", "тема", "темы", "тему", "цвет", "адаптив", "масштаб", "анимац", "кнопк", "меню", "настройк")
            ? WhatsNewTopic.Interface
            : WhatsNewTopic.Other;
    }

    private static WhatsNewPreview? PreviewFor(WhatsNewTopic topic, List<string> items, ReleasePlatform platform)
    {
        var low = string.Join(' ', items).ToLowerInvariant().Replace('ё', 'е');
        bool Has(params string[] words) => words.Any(w => low.Contains(w, StringComparison.Ordinal));
        if (Has("энергосбереж", "заряд", "батаре", "облегчен"))
        {
            return WhatsNewPreview.Power;
        }

        if (Has("исключен"))
        {
            return WhatsNewPreview.Exclusions;
        }

        if (Has("категори", "openstreetmap", "osm"))
        {
            return WhatsNewPreview.Categories;
        }

        if (Has("панел"))
        {
            return WhatsNewPreview.Sidebar;
        }

        if (Has("адаптив"))
        {
            return WhatsNewPreview.Adaptive;
        }

        if (Has("окно настроек", "окна настроек", "настройк"))
        {
            return WhatsNewPreview.Settings;
        }

        if (Has("кнопк", "обновить") && topic == WhatsNewTopic.Updates)
        {
            return WhatsNewPreview.Update;
        }

        return topic switch {
            WhatsNewTopic.Interface => platform == ReleasePlatform.Windows ? WhatsNewPreview.Adaptive : WhatsNewPreview.Settings,
            WhatsNewTopic.Search => WhatsNewPreview.Categories,
            WhatsNewTopic.Data => WhatsNewPreview.Cloud,
            WhatsNewTopic.Updates => WhatsNewPreview.Update,
            WhatsNewTopic.Power => WhatsNewPreview.Power,
            _ => null,
        };
    }

    [GeneratedRegex(@"^(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$")]
    private static partial Regex BulletRx();

    [GeneratedRegex(@"^\*\*(.+?)\*\*(\s*[:.—–-]+\s*)?(.*)$")]
    private static partial Regex BoldLeadRx();

    [GeneratedRegex(@"\s+by\s+@\S+\s+in\s+\S+")]
    private static partial Regex AuthorRx();

    [GeneratedRegex(@"\[([^\]]*)\]\([^)]*\)")]
    private static partial Regex LinkRx();

    [GeneratedRegex(@"https?://\S+")]
    private static partial Regex UrlRx();

    [GeneratedRegex(@"\(?#\d+\)?")]
    private static partial Regex PullRefRx();

    [GeneratedRegex(@"\s+")]
    private static partial Regex SpacesRx();

    [GeneratedRegex(@"[.!?](\s|$)")]
    private static partial Regex SentenceEndRx();
}
