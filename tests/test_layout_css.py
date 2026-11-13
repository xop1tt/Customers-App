"""Раскладка окна с собственным заголовком: низ интерфейса не должен уезжать за край (ADR-089)."""
import re
from pathlib import Path

STYLES = Path(__file__).resolve().parents[1] / "desktop" / "src" / "styles"


def test_root_is_sized_by_edges_not_by_height_100():
    base = (STYLES / "base.css").read_text(encoding="utf-8")
    assert not re.search(r"html,\s*body,\s*#root\s*\{[^}]*height:\s*100%", base), "height: 100% у #root выталкивает низ за край"
    assert re.search(r"#root\s*\{[^}]*inset:\s*var\(--titlebar-h\) 0 0 0;[^}]*height:\s*auto", base)
    assert re.search(r"html,\s*body\s*\{[^}]*overflow:\s*hidden", base)


def test_titlebar_is_compact():
    tokens = (STYLES / "tokens.css").read_text(encoding="utf-8")
    assert re.search(r"--titlebar-h:\s*40px", tokens)
