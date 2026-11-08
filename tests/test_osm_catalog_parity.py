"""Каталог категорий OpenStreetMap: единый файл desktop/src-tauri/data/osm_catalog.json.

Раньше каталог дублировался в приложениях для macOS (Swift) и Windows (C#), и тест сверял их между собой. Теперь приложение
одно, и каталог лежит в одном файле, который читают и Rust-ядро, и интерфейс. Настройки синхронизируются через облако,
поэтому ключи, названия, группы, условия Overpass, вес и включённость по умолчанию должны оставаться корректными.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "desktop/src-tauri/data/osm_catalog.json"
FILTER_RX = re.compile(r'^(\["[a-z_:]+"(=|!=)"[a-z_]+"\])+$')


def catalog():
    data = json.loads(CATALOG.read_text(encoding="utf-8"))
    items = [
        (c["key"], c["label"], c["group"], tuple(c["filters"]), bool(c["enabled"]), c["weight"])
        for c in data["categories"]
    ]
    return items, data["groupTitles"]


def test_catalog_is_large_enough_and_groups_are_titled():
    items, groups = catalog()
    assert len(items) >= 40
    assert {i[2] for i in items} <= set(groups)


def test_catalog_has_no_duplicates_and_valid_filters():
    items, _ = catalog()
    keys = [i[0] for i in items]
    labels = [i[1] for i in items]
    filters = [f for i in items for f in i[3]]
    assert len(keys) == len(set(keys))
    assert len(labels) == len(set(labels))
    assert len(filters) == len(set(filters))
    for f in filters:
        assert FILTER_RX.match(f), f
    assert all(i[3] and i[5] > 0 for i in items)


def test_original_eight_stay_first_and_enabled():
    items, _ = catalog()
    assert [i[0] for i in items[:8]] == ["beauty", "dance", "restaurant", "cafe", "education", "medical", "fitness", "shops"]
    assert all(i[4] for i in items[:8])
    assert not any(i[4] for i in items[8:])
