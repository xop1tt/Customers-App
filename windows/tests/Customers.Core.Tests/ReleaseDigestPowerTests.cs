using System.Text.RegularExpressions;

namespace Customers.Core.Tests;

public sealed class WhatsNewDigestTests
{
    private static string[] Texts(IEnumerable<WhatsNewFeature> features) => features.SelectMany(f => f.Items).ToArray();

    [Fact]
    public void TechnicalAndServiceLinesAreDropped()
    {
        const string md = """
            ## Что изменилось
            - Обновили README и вики
            - Рефакторинг модуля поиска
            - Исправили тесты CI
            - Bump pillow from 12 to 13 by @dependabot in https://github.com/x/y/pull/42
            - Новое окно настроек с поиском по разделам

            **Full Changelog**: https://github.com/x/y/compare/v1...v2
            """;
        var items = Texts(WhatsNewDigest.Build(md, ReleasePlatform.Windows));
        Assert.Equal(["Новое окно настроек с поиском по разделам"], items);
    }

    [Fact]
    public void OtherPlatformChangesAreHidden()
    {
        const string md = """
            - Windows: значок в области уведомлений
            - macOS: боковая панель выезжает при наведении
            - Общий поиск стал быстрее
            - Мастер на Windows и macOS спрашивает регион
            """;
        var mac = Texts(WhatsNewDigest.Build(md, ReleasePlatform.MacOS));
        var win = Texts(WhatsNewDigest.Build(md, ReleasePlatform.Windows));
        Assert.DoesNotContain(mac, t => t.Contains("значок в области", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(mac, t => t.Contains("боковая панель", StringComparison.Ordinal));
        Assert.Contains(win, t => t.Contains("значок в области", StringComparison.Ordinal));
        Assert.DoesNotContain(win, t => t.Contains("боковая панель", StringComparison.Ordinal));
        Assert.Contains(win, t => t.Contains("Общий поиск", StringComparison.Ordinal));
        Assert.Contains(win, t => t.Contains("Мастер на Windows и macOS", StringComparison.Ordinal));
    }

    [Fact]
    public void PlatformSectionHeadingScopesItsBullets()
    {
        const string md = "## Windows\n- Адаптивная сетка карточек\n## macOS\n- Новая иконка в строке меню";
        Assert.Equal(["Адаптивная сетка карточек"], Texts(WhatsNewDigest.Build(md, ReleasePlatform.Windows)));
        Assert.Equal(["Новая иконка в строке меню"], Texts(WhatsNewDigest.Build(md, ReleasePlatform.MacOS)));
    }

    [Fact]
    public void InstallationSectionsAreServiceInformation()
    {
        const string md = "## Изменилось\n- Облегчённый режим при низком заряде\n## Установка\n- Скачайте Customers-Setup.exe и запустите";
        var items = Texts(WhatsNewDigest.Build(md, ReleasePlatform.Windows));
        Assert.Single(items);
        Assert.Contains("Облегчённый", items[0], StringComparison.Ordinal);
    }

    [Fact]
    public void BoldLeadBecomesShortPhraseAndInlineBoldKeepsPhrase()
    {
        var f = WhatsNewDigest.Build("- **Исключения.** Одно поле для домена, телефона и почты, формат определяется сам. Старые правила сохранены.", ReleasePlatform.Windows);
        Assert.Equal(["Одно поле для домена, телефона и почты, формат определяется сам"], Assert.Single(f).Items);
        var inline = Texts(WhatsNewDigest.Build("- **Быстрее** запуск приложения", ReleasePlatform.Windows));
        Assert.Equal(["Быстрее запуск приложения"], inline);
    }

    [Fact]
    public void RelatedChangesAreGroupedUnderOneTopic()
    {
        const string md = "- Адаптивное расположение элементов\n- Обновлённое окно настроек\n- Улучшенное поведение боковых панелей\n- Поиск по категориям OpenStreetMap стал богаче";
        var features = WhatsNewDigest.Build(md, ReleasePlatform.Windows);
        var ui = features.First(f => f.Topic == WhatsNewTopic.Interface);
        Assert.Equal(3, ui.Items.Count);
        Assert.Equal("Улучшили и доработали интерфейс", ui.Title);
        Assert.Single(features.First(f => f.Topic == WhatsNewTopic.Search).Items);
    }

    [Fact]
    public void ItemsAreLimitedDeduplicatedAndShortened()
    {
        var md = "- Энергосбережение: облегчённый режим при низком заряде\n" + string.Concat(Enumerable.Range(1, 9).Select(i => $"- Окно {i} стало удобнее\n"));
        var features = WhatsNewDigest.Build(md, ReleasePlatform.Windows);
        Assert.Equal([WhatsNewTopic.Interface, WhatsNewTopic.Power], features.Select(f => f.Topic).ToArray());
        Assert.Equal(WhatsNewDigest.MaxItemsPerTopic, features[0].Items.Count);

        var longText = string.Concat(Enumerable.Repeat("очень длинное описание ", 20));
        var items = Texts(WhatsNewDigest.Build($"- Поиск стал быстрее\n- поиск стал быстрее\n- {longText}", ReleasePlatform.Windows));
        Assert.Single(items, t => t.Equals("поиск стал быстрее", StringComparison.OrdinalIgnoreCase));
        Assert.All(items, t => Assert.True(t.Length <= WhatsNewDigest.MaxItemLength + 1));
    }

    [Theory]
    [InlineData("Одно поле для исключений", WhatsNewPreview.Exclusions)]
    [InlineData("Облегчённый режим при низком заряде", WhatsNewPreview.Power)]
    [InlineData("Больше категорий организаций на карте", WhatsNewPreview.Categories)]
    [InlineData("Боковая панель раскрывается шире", WhatsNewPreview.Sidebar)]
    [InlineData("Адаптивная сетка карточек", WhatsNewPreview.Adaptive)]
    [InlineData("Новое окно настроек", WhatsNewPreview.Settings)]
    public void PreviewMatchesWhatTheFeatureDoes(string line, WhatsNewPreview expected) =>
        Assert.Equal(expected, WhatsNewDigest.Build("- " + line, ReleasePlatform.Windows).First().Preview);

    [Fact]
    public void EmptyOrOnlyTechnicalNotesGiveNothingAndGitHubNotesAreCleaned()
    {
        Assert.Empty(WhatsNewDigest.Build("", ReleasePlatform.Windows));
        Assert.Empty(WhatsNewDigest.Build(null, ReleasePlatform.Windows));
        Assert.Empty(WhatsNewDigest.Build("- Обновили wiki\n- Рефакторинг", ReleasePlatform.Windows));
        const string md = "## What's Changed\n* Новая кнопка обновления с прогрессом by @xop1tt in https://github.com/xop1tt/Customers-App/pull/63\n**Full Changelog**: https://github.com/a/b/compare/v1...v2";
        Assert.Equal(["Новая кнопка обновления с прогрессом"], Texts(WhatsNewDigest.Build(md, ReleasePlatform.Windows)));
    }
}

public sealed class PowerPolicyTests
{
    [Fact]
    public void SystemSaverTurnsLightModeOnEvenWhenCharging() =>
        Assert.IsType<LightModeReason.SystemSaver>(PowerPolicy.Evaluate(new PowerState(true, 100, true), true, 20));

    [Fact]
    public void BatteryBelowThresholdTurnsItOnAtOrAboveKeepsNormal()
    {
        Assert.Equal(new LightModeReason.LowBattery(19, 20), PowerPolicy.Evaluate(new PowerState(false, 19, false), true, 20));
        Assert.Null(PowerPolicy.Evaluate(new PowerState(false, 20, false), true, 20));
        Assert.Null(PowerPolicy.Evaluate(new PowerState(false, 21, false), true, 20));
    }

    [Fact]
    public void ChargingIsNotLowBatteryAndUnknownChargingStillCounts()
    {
        Assert.Null(PowerPolicy.Evaluate(new PowerState(false, 5, true), true, 20));
        Assert.NotNull(PowerPolicy.Evaluate(new PowerState(false, 5, null), true, 20));
    }

    [Fact]
    public void MissingBatteryInfoUsesOnlySystemSaver()
    {
        Assert.Null(PowerPolicy.Evaluate(new PowerState(false, null, null), true, 20));
        Assert.NotNull(PowerPolicy.Evaluate(new PowerState(true, null, null), true, 20));
    }

    [Fact]
    public void DisabledAutomaticModeNeverActivates() =>
        Assert.Null(PowerPolicy.Evaluate(new PowerState(true, 1, false), false, 50));

    [Fact]
    public void RecoveryRestoresNormalMode()
    {
        var state = new PowerState(false, 10, false);
        Assert.NotNull(PowerPolicy.Evaluate(state, true, 20));
        state = state with { BatteryPercent = 35 };
        Assert.Null(PowerPolicy.Evaluate(state, true, 20));
        state = state with { SystemSaver = true };
        Assert.NotNull(PowerPolicy.Evaluate(state, true, 20));
        state = state with { SystemSaver = false };
        Assert.Null(PowerPolicy.Evaluate(state, true, 20));
    }

    [Fact]
    public void ThresholdDefaultsToTwentyAndIsClamped()
    {
        Assert.Equal(20, PowerPolicy.DefaultThreshold);
        Assert.Equal(5, PowerPolicy.Clamp(0));
        Assert.Equal(50, PowerPolicy.Clamp(99));
        Assert.NotNull(PowerPolicy.Evaluate(new PowerState(false, 49, false), true, 99));
        Assert.Null(PowerPolicy.Evaluate(new PowerState(false, 50, false), true, 99));
    }

    [Fact]
    public void ExplanationsTellTheReason()
    {
        Assert.Contains("экономии", new LightModeReason.SystemSaver().Explanation, StringComparison.Ordinal);
        var low = new LightModeReason.LowBattery(18, 20).Explanation;
        Assert.Contains("18%", low, StringComparison.Ordinal);
        Assert.Contains("20%", low, StringComparison.Ordinal);
    }
}

public sealed class ExclusionDetectionTests
{
    [Theory]
    [InlineData("example.ru", ExclusionKind.Domain)]
    [InlineData("https://www.Example.ru/page?x=1", ExclusionKind.Domain)]
    [InlineData("+7 (843) 212-48-90", ExclusionKind.Phone)]
    [InlineData("8 843 2124890", ExclusionKind.Phone)]
    [InlineData("name@mail.ru", ExclusionKind.Email)]
    [InlineData("  Name@Mail.RU  ", ExclusionKind.Email)]
    public void DetectsEveryFormat(string value, ExclusionKind expected) => Assert.Equal(expected, EnumText.DetectExclusion(value));

    [Theory]
    [InlineData("Студия красоты Лаванда")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("12.5")]
    [InlineData("212-48-90")]
    [InlineData("не email @ почта")]
    public void UnknownFormatIsNull(string value) => Assert.Null(EnumText.DetectExclusion(value));

    [Fact]
    public void OneFieldStoresEveryFormatNormalized()
    {
        using var dir = new TempDir();
        using var store = new LeadStore(dir.File("x.db"));
        foreach (var raw in new[] { "https://www.Example.ru/x", "+7 (843) 212-48-90", "Name@Mail.ru", "Студия «Лаванда»" })
        {
            store.AddExclusion(EnumText.DetectExclusion(raw) ?? ExclusionKind.Name, raw);
        }

        var rules = store.Exclusions().Select(e => (e.Kind, e.Value)).ToHashSet();
        Assert.Contains((ExclusionKind.Domain, "example.ru"), rules);
        Assert.Contains((ExclusionKind.Phone, "8432124890"), rules);
        Assert.Contains((ExclusionKind.Email, "name@mail.ru"), rules);
        Assert.Contains((ExclusionKind.Name, "студия лаванда"), rules);
    }
}

public sealed class RegionSuggestionTests
{
    [Fact]
    public void PrefersLocalityThenDistrictThenRegion()
    {
        Assert.Equal("Казань", RegionSuggestion.Name("Казань", "Вахитовский", "Татарстан"));
        Assert.Equal("Пестречинский район", RegionSuggestion.Name(null, "Пестречинский район", "Татарстан"));
        Assert.Equal("Татарстан", RegionSuggestion.Name(" ", null, "Татарстан"));
        Assert.Null(RegionSuggestion.Name(null));
        Assert.Null(RegionSuggestion.Name("", "", null));
    }

    [Fact]
    public void StripsAdministrativeWords()
    {
        Assert.Equal("Сочи", RegionSuggestion.Name("городской округ Сочи"));
        Assert.Equal("Пермь", RegionSuggestion.Name("город Пермь"));
        Assert.Equal("Сочи", RegionSuggestion.Name("Сочи городской округ"));
    }

    [Fact]
    public void SuggestionNeverOverwritesUserChoice()
    {
        Assert.Equal(["Казань"], RegionSuggestion.Applying("Казань", []));
        Assert.Equal(["Ереван"], RegionSuggestion.Applying("Казань", ["Ереван"]));
        Assert.Empty(RegionSuggestion.Applying(null, []));
    }

    [Fact]
    public async Task ReverseGeocodingAsksNominatimAndFallsBackToNullWhenOffline()
    {
        var ok = new MockTransport(_ => MockTransport.Ok("""{"address":{"city":"Казань","state":"Татарстан"}}"""));
        Assert.Equal("Казань", await RegionSuggestion.ReverseAsync(ok, 55.79, 49.12));
        var url = Assert.Single(ok.Requests).Url.AbsoluteUri;
        Assert.StartsWith("https://nominatim.openstreetmap.org/reverse?", url, StringComparison.Ordinal);
        Assert.Contains("lat=55.79&lon=49.12", url, StringComparison.Ordinal);
        Assert.Contains("accept-language=ru", url, StringComparison.Ordinal);

        Assert.Null(await RegionSuggestion.ReverseAsync(new MockTransport(_ => MockTransport.Status(503)), 55.79, 49.12));
        Assert.Null(await RegionSuggestion.ReverseAsync(new MockTransport(_ => throw new HttpFailure("нет сети")), 55.79, 49.12));
        var never = new MockTransport(_ => MockTransport.Ok("{}"));
        Assert.Null(await RegionSuggestion.ReverseAsync(never, 120, 49.12)); // координаты вне диапазона: в сеть не ходим
        Assert.Empty(never.Requests);
    }

    [Fact]
    public void ParsesNominatimReverseGeocoding()
    {
        Assert.Equal("Казань", RegionSuggestion.FromNominatim("""{"address":{"city":"Казань","state":"Татарстан"}}"""));
        Assert.Equal("Дербышки", RegionSuggestion.FromNominatim("""{"address":{"village":"Дербышки","state":"Татарстан"}}"""));
        Assert.Equal("Татарстан", RegionSuggestion.FromNominatim("""{"address":{"state":"Татарстан"}}"""));
        Assert.Null(RegionSuggestion.FromNominatim("""{"error":"Unable to geocode"}"""));
        Assert.Null(RegionSuggestion.FromNominatim("не json"));
        Assert.Null(RegionSuggestion.FromNominatim(null));
    }
}

public sealed class OsmCatalogTests
{
    private static readonly List<OSMCategory> All = SearchDefaults.OsmCategories();

    [Fact]
    public void CatalogIsMuchLargerThanTheOriginalEightAndNewOnesAreOff()
    {
        Assert.True(All.Count >= 40);
        Assert.Equal(["beauty", "dance", "restaurant", "cafe", "education", "medical", "fitness", "shops"], All.Take(8).Select(c => c.Key).ToArray());
        Assert.All(All.Take(8), c => Assert.True(c.Enabled));
        Assert.All(All.Skip(8), c => Assert.False(c.Enabled));
    }

    [Fact]
    public void KeysLabelsAndFiltersAreUnique()
    {
        Assert.Equal(All.Count, All.Select(c => c.Key).Distinct().Count());
        Assert.Equal(All.Count, All.Select(c => c.Label).Distinct().Count());
        var filters = All.SelectMany(c => c.Filters).ToList();
        Assert.Equal(filters.Count, filters.Distinct().Count());
    }

    [Fact]
    public void EveryFilterIsAWellFormedOverpassCondition()
    {
        var rx = new Regex(@"^(\[""[a-z_:]+""(=|!=)""[a-z_]+""\])+$");
        var keys = new[] { "shop", "amenity", "office", "craft", "leisure", "tourism", "healthcare", "sport" };
        foreach (var c in All)
        {
            Assert.NotEmpty(c.Filters);
            foreach (var f in c.Filters)
            {
                Assert.Matches(rx, f);
                Assert.Contains(keys, k => f.StartsWith($"[\"{k}\"", StringComparison.Ordinal));
            }
        }
    }

    [Fact]
    public void EveryCategoryHasGroupTitleAndSaneWeight()
    {
        foreach (var c in All)
        {
            Assert.True(SearchDefaults.OsmGroupTitles.ContainsKey(c.Group), c.Group);
            Assert.InRange(c.Weight, 1, 30);
            Assert.NotEmpty(c.Label);
        }
    }

    [Fact]
    public void QueryContainsEveryFilterOfACategory()
    {
        var c = All.First(x => x.Key == "pools");
        var q = OsmSource.BuildQuery("Казань", c.Filters);
        foreach (var f in c.Filters)
        {
            Assert.Contains($"nwr{f}(area.a);", q, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void StoredSettingsGetNewCategoriesWithoutChangingChoices()
    {
        var old = new SearchSettings();
        old.Osm.Categories = SearchDefaults.OsmCategories().Take(8).ToList();
        old.Osm.Categories[0].Enabled = false;
        var decoded = SearchSettings.Decode(old.Encoded());
        Assert.Equal(All.Count, decoded.Osm.Categories.Count);
        Assert.False(decoded.Osm.Categories[0].Enabled);
        Assert.All(decoded.Osm.Categories.Skip(8), c => Assert.False(c.Enabled));
        Assert.Equal(All.Count, SearchSettings.Decode(decoded.Encoded()).Osm.Categories.Count);
    }

    [Fact]
    public void NewUserHasNothingPreselectedAndSavedFiltersAreKept()
    {
        var s = SearchSettings.Stored(null);
        Assert.Equal(SearchSettings.BlankStart().Encoded(), SearchSettings.Stored("  ").Encoded());
        Assert.Empty(s.Osm.Regions);
        Assert.Empty(s.Telegram.Channels);
        Assert.Empty(s.Telegram.Keywords);
        s.Telegram.Channels = ["mychannel"];
        s.Telegram.Keywords = ["сайт"];
        s.Osm.Regions = ["Казань"];
        var back = SearchSettings.Decode(s.Encoded());
        Assert.Equal(["mychannel"], back.Telegram.Channels);
        Assert.Equal(["сайт"], back.Telegram.Keywords);
        Assert.Equal(["Казань"], back.Osm.Regions);
    }
}
