"""Значки Dock (тёмная и светлая плитка) и шаблонный значок строки меню."""
from pathlib import Path

from PIL import Image

ICONS = Path(__file__).resolve().parent.parent / "desktop" / "src-tauri" / "icons"


def test_dock_variants_differ_only_in_tile():
    dark = Image.open(ICONS / "dock-dark.png").convert("RGBA")
    light = Image.open(ICONS / "dock-light.png").convert("RGBA")
    assert dark.size == light.size == (512, 512)
    # В углу плитки тёмный и светлый варианты контрастны, в обоих плитка не прозрачна.
    d, l = dark.getpixel((256, 60)), light.getpixel((256, 60))
    assert d[3] == 255 and l[3] == 255
    assert sum(l[:3]) > sum(d[:3]) + 300


def test_tray_template_is_black_on_transparent():
    img = Image.open(ICONS / "tray-template.png").convert("RGBA")
    pixels = list(img.getdata())
    assert any(p[3] == 0 for p in pixels), "фон должен быть прозрачным"
    assert any(p[3] > 200 for p in pixels), "буква должна быть видна"
    assert all(p[:3] == (0, 0, 0) for p in pixels if p[3] > 0), "шаблонный значок чёрный: macOS перекрашивает сам"
