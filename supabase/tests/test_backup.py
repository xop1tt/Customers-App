"""Ежедневная резервная копия облака (supabase/cloud-backup/backup.py, workflow cloud-backup.yml) на стенде.

Тот же скрипт, что снимает рабочую базу: снимок схем public, private, auth в одном снимке транзакции,
восстановление в пустую базу и сверка числа строк каждой таблицы. Испорченная копия обязана не пройти проверку.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import psycopg
import pytest

from conftest import ENV, confirmed_user, db

SCRIPT = Path(__file__).resolve().parents[1] / "cloud-backup" / "backup.py"
TARGET = "restore_check"


def url(dbname: str) -> str:
    return f"postgresql://{ENV['PGUSER']}:{ENV['PGPASSWORD']}@{ENV['PGHOST']}:{ENV['PGPORT']}/{dbname}"


def run(cmd: str, folder: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "SOURCE_DB_URL": url(ENV["STACK_DB"]), "TARGET_DB_URL": url(TARGET)}
    return subprocess.run([sys.executable, str(SCRIPT), cmd, str(folder)], env=env, capture_output=True, text=True, timeout=300)


def fresh_target() -> None:
    with psycopg.connect(url("postgres"), autocommit=True) as conn:
        conn.execute(f"drop database if exists {TARGET} with (force)")
        conn.execute(f"create database {TARGET}")


@pytest.fixture
def snapshot(tmp_path: Path) -> Path:
    confirmed_user()  # в снимке есть учётная запись и её строки
    r = run("dump", tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    return tmp_path


def test_dump_covers_accounts_and_crm_with_counts_from_one_snapshot(snapshot):
    manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
    tables = manifest["tables"]
    for t in ["auth.users", "public.leads", "public.workspaces", "public.companies", "public.deals"]:
        assert t in tables, t
    with db() as conn:
        users = conn.execute("select count(*) from auth.users").fetchone()[0]
    assert tables["auth.users"] == users >= 1
    assert (snapshot / "customers.dump").stat().st_size > 0


def test_restore_check_passes_and_data_matches(snapshot):
    fresh_target()
    r = run("check", snapshot)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Восстановление проверено" in r.stdout
    with psycopg.connect(url(TARGET)) as conn, db() as src:
        assert conn.execute("select count(*) from auth.users").fetchone()[0] == src.execute("select count(*) from auth.users").fetchone()[0]


def test_restore_check_fails_when_rows_are_missing(snapshot):
    manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
    manifest["tables"]["auth.users"] += 1
    (snapshot / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    fresh_target()
    r = run("check", snapshot)
    assert r.returncode != 0
    assert "auth.users" in r.stdout and "не пройдена" in r.stderr
