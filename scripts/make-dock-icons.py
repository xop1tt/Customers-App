#!/usr/bin/env python3
"""Значки, которые зависят от темы macOS, из desktop/src-tauri/icons/source.png (нужны Pillow и NumPy).

- dock-dark.png: исходный значок (чёрная плитка, синяя буква).
- dock-light.png: та же буква на белой плитке. Приложение ставит один из двух значков в Dock в зависимости от темы системы.
- tray-template.png: чёрная буква на прозрачном фоне, 44 px. macOS красит такой «шаблонный» значок сама
  (светлым в тёмной строке меню и тёмным в светлой), поэтому фона у него нет.
"""
from pathlib import Path

import numpy as np
from PIL import Image

ICONS = Path(__file__).resolve().parent.parent / "desktop" / "src-tauri" / "icons"


def letter_mask(rgba: np.ndarray) -> np.ndarray:
    """Насколько пиксель принадлежит синей букве (0..1): у плитки цвет почти серый, у буквы заметно синий."""
    r, g, b = (rgba[..., i].astype(float) for i in range(3))
    return np.clip((b - np.maximum(r, g) - 12) / 70, 0, 1)


def light_variant(master: Image.Image) -> Image.Image:
    a = np.array(master.convert("RGBA")).astype(float)
    k = letter_mask(a)[..., None]
    lum = a[..., :3].mean(axis=2, keepdims=True)
    # Плитка: яркость 15..60 → 255..238, лёгкий вертикальный градиент сохраняется.
    tile = 255 - np.clip((lum - 15) / 45, 0, 1) * 17
    tile = np.repeat(tile, 3, axis=2)
    out = a.copy()
    out[..., :3] = tile * (1 - k) + a[..., :3] * k
    return Image.fromarray(out.round().astype("uint8"), "RGBA")


def tray_template(master: Image.Image, size: int = 44) -> Image.Image:
    a = np.array(master.convert("RGBA")).astype(float)
    k = letter_mask(a) * (a[..., 3] / 255)
    ys, xs = np.where(k > 0.5)
    box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
    glyph = Image.fromarray((k * 255).round().astype("uint8"), "L").crop(box)
    target = int(size * 0.66)
    scale = target / max(glyph.size)
    glyph = glyph.resize((max(1, round(glyph.width * scale)), max(1, round(glyph.height * scale))), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    black = Image.new("RGBA", glyph.size, (0, 0, 0, 255))
    black.putalpha(glyph)
    out.alpha_composite(black, ((size - glyph.width) // 2, (size - glyph.height) // 2))
    return out


def main() -> None:
    master = Image.open(ICONS / "source.png").convert("RGBA")
    master.resize((512, 512), Image.LANCZOS).save(ICONS / "dock-dark.png", optimize=True)
    light_variant(master).resize((512, 512), Image.LANCZOS).save(ICONS / "dock-light.png", optimize=True)
    tray_template(master).save(ICONS / "tray-template.png", optimize=True)
    print("значки темы записаны в", ICONS)


if __name__ == "__main__":
    main()
