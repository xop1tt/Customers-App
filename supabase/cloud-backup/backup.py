"""Резервная копия облачной базы Customers и проверка её восстановления (пакет A1, ADR-043).

  python supabase/cloud-backup/backup.py dump  <папка>   — снимок схем public, private, auth (pg_dump -Fc)
                                                    и manifest.json с числом строк каждой таблицы
                                                    в том же снимке транзакции;
  python supabase/cloud-backup/backup.py check <папка>   — восстанавливает снимок в пустую базу и сверяет
                                                    число строк каждой таблицы с manifest.json.

Источник — переменная SOURCE_DB_URL, цель проверки — TARGET_DB_URL (пустая база на чистом PostgreSQL).
Пароли в аргументы командной строки не попадают: pg_dump и pg_restore получают строку подключения из
переменных окружения. Шифрование (gpg) и хранение — в workflow cloud-backup.yml.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import psycopg

SCHEMAS = ["public", "private", "auth"]
DUMP = "customers.dump"
MANIFEST = "manifest.json"
PREPARE = Path(__file__).with_name("prepare-target.sql")


def tables(conn) -> list[str]:
    rows = conn.execute(
        """
        select format('%I.%I', n.nspname, c.relname)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname = any(%s)
          and not c.relispartition
        order by 1
        """,
        (SCHEMAS,),
    ).fetchall()
    return [r[0] for r in rows]


def counts(conn) -> dict[str, int]:
    return {t: conn.execute(f"select count(*) from {t}").fetchone()[0] for t in tables(conn)}


LIBPQ_ENV = {"host": "PGHOST", "port": "PGPORT", "user": "PGUSER", "password": "PGPASSWORD", "dbname": "PGDATABASE", "sslmode": "PGSSLMODE"}


def run(args: list[str], url: str) -> subprocess.CompletedProcess:
    # Строка подключения раскладывается в переменные libpq: пароль не попадает в argv и список процессов.
    parts = psycopg.conninfo.conninfo_to_dict(url)
    env = {**os.environ, **{LIBPQ_ENV[k]: str(v) for k, v in parts.items() if k in LIBPQ_ENV}}
    return subprocess.run(args, env=env, capture_output=True, text=True)


def dump(out: Path) -> None:
    url = os.environ["SOURCE_DB_URL"]
    out.mkdir(parents=True, exist_ok=True)
    # Снимок экспортируется из открытой транзакции: pg_dump и подсчёт строк видят одно и то же состояние.
    with psycopg.connect(url, autocommit=False) as holder:
        holder.execute("set transaction isolation level repeatable read, read only")
        snapshot = holder.execute("select pg_export_snapshot()").fetchone()[0]
        with psycopg.connect(url, autocommit=False) as reader:
            reader.execute("set transaction isolation level repeatable read, read only")
            reader.execute(f"set transaction snapshot '{snapshot}'")
            manifest = {"schemas": SCHEMAS, "tables": counts(reader)}
            server = reader.execute("show server_version").fetchone()[0]
        args = ["pg_dump", "--format=custom", "--compress=9", f"--snapshot={snapshot}", "--file", str(out / DUMP)]
        args += [f"--schema={s}" for s in SCHEMAS]
        r = run(args, url)
        if r.returncode != 0:
            sys.exit(f"pg_dump не удался:\n{r.stderr}")
    manifest["server_version"] = server
    (out / MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(manifest["tables"].values())
    print(f"Снимок готов: {len(manifest['tables'])} таблиц, {total} строк, {(out / DUMP).stat().st_size} байт")


def check(src: Path) -> None:
    url = os.environ["TARGET_DB_URL"]
    manifest = json.loads((src / MANIFEST).read_text(encoding="utf-8"))
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(PREPARE.read_text(encoding="utf-8"))
    # Владельцы и права Supabase на чистом сервере не нужны. Объекты, которых там нет (например, функции
    # расширений Supabase), дают предупреждения; критерий проверки — данные каждой таблицы восстановлены целиком.
    dbname = psycopg.conninfo.conninfo_to_dict(url)["dbname"]
    r = run(["pg_restore", "--no-owner", "--no-acl", "--dbname", str(dbname), str(src / DUMP)], url)
    errors = [line for line in r.stderr.splitlines() if "error" in line.lower()]
    if errors:
        print(f"pg_restore: {len(errors)} предупреждений (объекты, которых нет на чистом сервере):")
        for line in errors[:20]:
            print(f"  · {line}")
    with psycopg.connect(url) as conn:
        restored = counts(conn)
    expected = manifest["tables"]
    bad = {t: (n, restored.get(t)) for t, n in expected.items() if restored.get(t) != n}
    if bad:
        for t, (want, got) in bad.items():
            print(f"  ✗ {t}: в снимке {want}, восстановлено {got}")
        sys.exit(f"Проверка восстановления не пройдена: {len(bad)} таблиц не совпали")
    print(f"Восстановление проверено: {len(expected)} таблиц, {sum(expected.values())} строк совпали")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("dump", "check"):
        sys.exit(__doc__)
    {"dump": dump, "check": check}[sys.argv[1]](Path(sys.argv[2]))
