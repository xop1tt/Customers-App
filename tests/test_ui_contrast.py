"""Аудит UX/UI (F-18…F-21): контраст токенов обеих тем не ниже порогов WCAG 2.2 (1.4.3: 4.5 : 1 для текста, 1.4.11: 3 : 1 для границ)."""

import re
from pathlib import Path

CSS = (Path(__file__).resolve().parents[1] / "desktop/src/styles/tokens.css").read_text(encoding="utf-8")


def theme_tokens(light: bool) -> dict[str, str]:
    dark_block = CSS[CSS.index(":root {"):CSS.index(":root[data-motion")]
    light_block = CSS[CSS.index(':root[data-theme="light"]'):]
    pick = lambda b: dict(re.findall(r"(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;", b))
    tokens = pick(dark_block)
    if light:
        tokens.update(pick(light_block))
    return tokens


def lum(h: str) -> float:
    ch = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(ch[0]) + 0.7152 * f(ch[1]) + 0.0722 * f(ch[2])


def ratio(a: str, b: str) -> float:
    x, y = sorted((lum(a), lum(b)), reverse=True)
    return (x + 0.05) / (y + 0.05)


SURFACES = ["--bg", "--bg-side", "--bg-raised", "--bg-hover", "--bg-input"]
TEXT = ["--text", "--text-2", "--text-3", "--accent", "--red", "--orange", "--green", "--purple"]
SOFT = {"--red": "--red-soft", "--orange": "--orange-soft", "--green": "--green-soft", "--purple": "--purple-soft"}


def check(light: bool):
    t = theme_tokens(light)
    bad = []
    for fg in TEXT:
        for bg in SURFACES:
            if ratio(t[fg], t[bg]) < 4.5:
                bad.append(f"{fg} на {bg}: {ratio(t[fg], t[bg]):.2f}")
    for fg, soft in SOFT.items():
        if ratio(t[fg], t[soft]) < 4.5:
            bad.append(f"{fg} на {soft}: {ratio(t[fg], t[soft]):.2f}")
    if ratio(t["--accent-hover"], t["--accent-soft"]) < 4.5:
        bad.append("тег «синий»")
    for bg in ["--bg", "--bg-side", "--bg-raised", "--bg-input"]:
        for edge in ["--line-control", "--line-control-hover"]:
            if ratio(t[edge], t[bg]) < 3:
                bad.append(f"{edge} на {bg}: {ratio(t[edge], t[bg]):.2f}")
    return bad


def test_dark_theme_contrast():
    assert check(False) == []


def test_light_theme_contrast():
    assert check(True) == []
