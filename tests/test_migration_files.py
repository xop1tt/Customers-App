"""Файлы миграций пригодны для учёта истории Supabase CLI (пакет A2) и скрипт применения защищён от ошибок."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))
SCRIPT = (ROOT / "supabase" / "scripts" / "migrate.sh").read_text(encoding="utf-8")


def test_file_names_are_cli_versions_and_unique():
    versions = []
    for f in MIGRATIONS:
        m = re.fullmatch(r"(\d{14})_[a-z0-9_]+\.sql", f.name)
        assert m, f"{f.name}: нужен вид ГГГГММДДччммсс_имя.sql"
        versions.append(m.group(1))
    assert len(versions) == len(set(versions)), "версии миграций повторяются"
    assert versions == sorted(versions)


def test_register_marks_only_migrations_applied_by_hand_before_a2():
    until = re.search(r"^MANUAL_UNTIL=(\d{14})$", SCRIPT, re.M).group(1)
    assert until == "20261111100000"
    assert any(f.name.startswith(until) for f in MIGRATIONS), "граница — существующая миграция"
    assert "awk -v m=\"$MANUAL_UNTIL\" '$1 <= m'" in SCRIPT


def test_script_refuses_push_without_history_and_register_twice():
    push = SCRIPT.split("  push)")[1].split(";;")[0]
    register = SCRIPT.split("  register)")[1].split(";;")[0]
    assert 'if [[ "$(applied_count)" == "0" ]]' in push and "exit 1" in push
    assert push.index("--dry-run") < push.index('db push --db-url "$DB_URL"\n')
    assert 'if [[ "$(applied_count)" != "0" ]]' in register and "exit 1" in register
    assert "set -euo pipefail" in SCRIPT and "echo \"$DB_URL\"" not in SCRIPT
