"""Каталог категорий OpenStreetMap одинаков в приложениях для macOS (Swift) и Windows (C#).

Файлы настроек читают обе платформы и синхронизируют их через облако, поэтому ключи, названия, группы,
условия Overpass, вес и включённость по умолчанию обязаны совпадать. Тест читает исходники, ничего не запускает.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SWIFT = ROOT / "macos/Sources/LeadSearch/SearchSettings.swift"
CSHARP = ROOT / "windows/src/Customers.Core/Search/SearchSettings.cs"
FILTER_RX = re.compile(r'^(\["[a-z_:]+"(=|!=)"[a-z_]+"\])+$')


def swift_catalog():
    text = SWIFT.read_text(encoding="utf-8")
    start = text.index("static let osmCategories")
    end = text.index("osmGroupTitles", start)
    body = text[start:end]
    items = []
    for m in re.finditer(r"OSMCategory\(key: \"(?P<key>[^\"]+)\"(?P<rest>.*?)\),?\n", body, re.S):
        rest = m.group("rest")
        label = re.search(r'label: "([^"]+)"', rest).group(1)
        group = re.search(r'group: "([^"]+)"', rest).group(1)
        filters = re.findall(r'#"(.*?)"#', rest)
        enabled = re.search(r"enabled: (true|false)", rest)
        weight = re.search(r"weight: (\d+)", rest)
        items.append((m.group("key"), label, group, tuple(filters), enabled is None or enabled.group(1) == "true", int(weight.group(1))))
    return items


def csharp_catalog():
    text = CSHARP.read_text(encoding="utf-8")
    start = text.index("OsmCategories() =>")
    end = text.index("OsmGroupTitles", start)
    items = []
    for line in text[start:end].splitlines():
        m = re.search(r'new\(\) \{ Key = "([^"]+)", Label = "([^"]+)", Group = "([^"]+)", Filters = \[(.*?)\],(?: Enabled = (true|false),)? Weight = (\d+) \}', line)
        if not m:
            continue
        filters = tuple(f.replace('\\"', '"') for f in re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(4)))
        items.append((m.group(1), m.group(2), m.group(3), filters, m.group(5) is None or m.group(5) == "true", int(m.group(6))))
    return items


def test_catalogs_are_identical():
    swift, csharp = swift_catalog(), csharp_catalog()
    assert len(swift) >= 40
    assert swift == csharp


def test_catalog_has_no_duplicates_and_valid_filters():
    for items in (swift_catalog(), csharp_catalog()):
        keys = [i[0] for i in items]
        labels = [i[1] for i in items]
        filters = [f for i in items for f in i[3]]
        assert len(keys) == len(set(keys))
        assert len(labels) == len(set(labels))
        assert len(filters) == len(set(filters))
        for f in filters:
            assert FILTER_RX.match(f), f


def test_original_eight_stay_first_and_enabled():
    for items in (swift_catalog(), csharp_catalog()):
        assert [i[0] for i in items[:8]] == ["beauty", "dance", "restaurant", "cafe", "education", "medical", "fitness", "shops"]
        assert all(i[4] for i in items[:8])
        assert not any(i[4] for i in items[8:])
