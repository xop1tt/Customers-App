"""Проверки значка приложения: один тёмный значок, буква C по центру, без подмены в Dock.

Исправление «значок становится светлым при закрытии приложения»: подмена значка в коде слетала при выходе,
поэтому значок теперь один, тёмный, из пакета. Эти тесты не дают вернуть светлый вариант или подмену.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from PIL import Image

ICONS = Path(__file__).resolve().parent.parent / "desktop" / "src-tauri" / "icons"
ICON = ICONS / "source.png"
TILE_FROM, TILE_TO = 100, 924  # плитка macOS внутри холста 1024


@pytest.fixture(scope="module")
def letter():
    im = Image.open(ICON).convert("RGB")
    px = im.load()
    xs, ys = [], []
    for y in range(im.height):
        for x in range(im.width):
            r, g, b = px[x, y]
            if b > 200 and b - r > 80:  # синий цвет буквы
                xs.append(x)
                ys.append(y)
    return im, (min(xs), min(ys), max(xs), max(ys))


def test_icon_size_and_format():
    im = Image.open(ICON)
    assert im.size == (1024, 1024)


def test_letter_is_centered_both_ways(letter):
    _, (x0, y0, x1, y1) = letter
    assert abs((y0 + y1) / 2 - 511.5) <= 2, "по вертикали ровно по центру"
    assert abs((x0 + x1) / 2 - 511.5) <= 2, "по горизонтали по центру"


def test_letter_has_even_padding_inside_the_tile(letter):
    _, (x0, y0, x1, y1) = letter
    left, right, top, bottom = x0 - TILE_FROM, TILE_TO - x1, y0 - TILE_FROM, TILE_TO - y1
    assert abs(left - right) <= 3 and abs(top - bottom) <= 3
    assert min(left, right, top, bottom) >= 100, "отступ от краёв плитки есть"
    assert max(left, right, top, bottom) <= 200, "но он небольшой"


def test_letter_is_upright_not_tilted(letter):
    im, (x0, y0, x1, y1) = letter
    # Верх и низ симметричны: зеркальное отражение по вертикали совпадает с исходным в области буквы.
    box = (x0, y0, x1 + 1, y1 + 1)
    crop = im.crop(box).convert("L")
    flipped = crop.transpose(Image.FLIP_TOP_BOTTOM)
    diff = sum(abs(a - b) for a, b in zip(crop.getdata(), flipped.getdata())) / (crop.width * crop.height)
    assert diff < 40, "буква симметрична сверху вниз, то есть без наклона"


def test_letter_color_is_blue_like_the_old_icon(letter):
    im, (x0, y0, x1, y1) = letter
    r, g, b = im.getpixel((x0 + 55, (y0 + y1) // 2))  # середина левой части штриха
    assert b > 200 and r < 100 and g > 100


def test_tile_is_dark(letter):
    im, _ = letter
    for x, y in [(130, 512), (512, 130), (512, 900), (900, 512), (200, 200)]:
        assert sum(im.getpixel((x, y))[:3]) / 3 < 60, f"плитка тёмная в точке {x},{y}"


def test_there_is_no_light_variant_or_dark_override():
    root = ICONS.parents[2]
    assert not list(ICONS.glob("*Dark*")), "светлого и тёмного вариантов нет, значок один"
    # Значок в пакете один, тёмный. Подмена на светлый в Dock допустима только в macOS-коде оболочки и только пока
    # приложение запущено (по просьбе пользователя значок следует теме системы); закрытое приложение показывает пакетный.
    for path in (ICONS.parent / "src").rglob("*.rs"):
        text = path.read_text(encoding="utf-8")
        if path.name == "shell.rs":
            assert re.search(r'#\[cfg\(target_os = "macos"\)\]\s*pub fn set_dock_icon', text), "подмена значка Dock только на macOS"
            continue
        assert not re.search(r"set_(dock_)?icon\s*\(", text), f"{path.name}: значок приложения не подменяется"
    conf = (ICONS.parent / "tauri.conf.json").read_text(encoding="utf-8")
    assert "icons/icon.icns" in conf and "icons/icon.ico" in conf
    assert (root / "desktop" / "src-tauri" / "icons" / "icon.png").exists()


def _icns_entries(data: bytes) -> dict[str, int]:
    import struct

    assert data[:4] == b"icns" and struct.unpack(">I", data[4:8])[0] == len(data)
    out, pos = {}, 8
    while pos < len(data):
        kind, size = data[pos : pos + 4].decode(), struct.unpack(">I", data[pos + 4 : pos + 8])[0]
        payload = data[pos + 8 : pos + size]
        assert payload[:8] == b"\x89PNG\r\n\x1a\n", f"{kind}: запись PNG"
        out[kind] = Image.open(__import__("io").BytesIO(payload)).width
        pos += size
    return out


def test_windows_ico_has_the_sizes_microsoft_recommends():
    ico = Image.open(ICONS / "icon.ico")
    assert {s[0] for s in ico.ico.sizes()} >= {16, 20, 24, 32, 40, 48, 64, 256}


def test_macos_icns_has_every_size_and_retina_version():
    sizes = sorted(set(_icns_entries((ICONS / "icon.icns").read_bytes()).values()))
    assert sizes == [16, 32, 64, 128, 256, 512, 1024]


def test_windows_icon_fills_the_canvas_more_than_the_macos_one():
    mac = Image.open(ICONS / "source.png").convert("RGBA").getchannel("A").getbbox()
    win = Image.open(ICONS / "icon.png").convert("RGBA").getchannel("A").getbbox()
    assert (mac[2] - mac[0]) / 1024 < (win[2] - win[0]) / 512, "у macOS поля шире, чем у Windows"
