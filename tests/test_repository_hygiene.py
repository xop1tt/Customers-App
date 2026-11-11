"""A4: репозиторий без устаревших ссылок и лишних файлов (находки S9, S10 аудита, ADR-046)."""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def tracked() -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    return [p for p in out.decode("utf-8").split("\0") if p]


def test_update_repository_constant_points_to_the_current_repository():
    src = (ROOT / "desktop/src-tauri/src/updates.rs").read_text(encoding="utf-8")
    assert 'pub const REPOSITORY: &str = "xop1tt/Customers-App";' in src
    assert 'pub const RELEASES_PAGE: &str = "https://github.com/xop1tt/Customers-App/releases";' in src


def test_no_links_to_the_old_repository_name():
    old = "xop1tt/" + "CLIENTS"  # собирается при запуске, чтобы этот файл не находил сам себя
    bad = []
    for rel in tracked():
        if rel.startswith(".github/release-notes/"):
            continue  # заметки старых релизов — история
        p = ROOT / rel
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        if old in text:
            bad.append(rel)
    assert bad == []


def test_coverage_report_is_not_tracked():
    files = tracked()
    assert ".coverage" not in files
    assert ".coverage" in (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
