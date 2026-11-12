#!/usr/bin/env python3
"""Собирает значки приложения из desktop/src-tauri/icons/source.png (нужен Pillow).

macOS (Human Interface Guidelines, App Icons): холст 1024 с плиткой 824 и прозрачным полем, в icon.icns
все размеры 16, 32, 128, 256, 512 и их версии @2x (до 1024).
Windows (https://learn.microsoft.com/ru-ru/windows/win32/menurc/about-icons): плитка занимает почти весь холст,
в icon.ico размеры 16, 20, 24, 32, 40, 48, 64, 256; те же заполненные PNG используются для окна и Microsoft Store.
"""
import io
import struct
import sys
from pathlib import Path

from PIL import Image

ICONS = Path(__file__).resolve().parent.parent / "desktop" / "src-tauri" / "icons"
WINDOWS_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
# Тип записи icns → сторона квадрата в пикселях (PNG): обычные и @2x.
ICNS_TYPES = [("icp4", 16), ("icp5", 32), ("ic11", 32), ("icp6", 64), ("ic12", 64), ("ic07", 128), ("ic13", 256), ("ic08", 256), ("ic14", 512), ("ic09", 512), ("ic10", 1024)]
# Заполненная плитка для Windows: поле 4 % вместо 10 % у macOS.
WIN_CROP = (80, 80, 944, 944)


def png(im: Image.Image, size: int) -> bytes:
    buf = io.BytesIO()
    im.resize((size, size), Image.LANCZOS).save(buf, "PNG", optimize=True)
    return buf.getvalue()


def build_icns(master: Image.Image) -> bytes:
    body = b""
    for kind, size in ICNS_TYPES:
        data = png(master, size)
        body += kind.encode() + struct.pack(">I", len(data) + 8) + data
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main() -> None:
    master = Image.open(ICONS / "source.png").convert("RGBA")
    (ICONS / "icon.icns").write_bytes(build_icns(master))

    win = master.crop(WIN_CROP)
    win.resize((256, 256), Image.LANCZOS).save(
        ICONS / "icon.ico", format="ICO", sizes=[(s, s) for s in WINDOWS_SIZES], bitmap_format="bmp")
    for name, size in [("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512),
                       ("StoreLogo.png", 50)] + [(f"Square{s}x{s}Logo.png", s) for s in (30, 44, 71, 89, 107, 142, 150, 284, 310)]:
        (ICONS / name).write_bytes(png(win, size))
    print("Готово:", ", ".join(sorted(p.name for p in ICONS.iterdir())))


if __name__ == "__main__":
    sys.exit(main())
