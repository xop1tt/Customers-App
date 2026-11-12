"""Аудит UX/UI: доступность, которую можно проверить по исходникам (F-37, F-38)."""

import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "desktop/src"


def test_no_anchor_without_href_in_interface():
    # Ссылка без href не получает фокус клавиатуры: действие — <button class="link">, переход — <a href>.
    bad = []
    for p in SRC.rglob("*.tsx"):
        if ".test." in p.name:
            continue
        for m in re.finditer(r"<a\b(?![^>]*\bhref=)[^>]*>", p.read_text(encoding="utf-8")):
            bad.append(f"{p.relative_to(SRC)}: {m.group(0)[:60]}")
    assert bad == []


def test_reduced_motion_is_respected():
    css = (SRC / "styles/base.css").read_text(encoding="utf-8")
    assert "prefers-reduced-motion: reduce" in css
