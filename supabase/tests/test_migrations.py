"""Проверки схемы после миграций (docs/MIGRATION_PLAN.md §5): повторное применение безопасно и не меняет
данные генератора лидов, у всех таблиц RLS, у definer-функций задан search_path, у anon нет прав."""

from pathlib import Path

from conftest import db
from crm_helpers import make_user, rpc

MIGRATIONS = sorted((Path(__file__).resolve().parents[1] / "migrations").glob("*.sql"))


def counts(c) -> dict[str, int]:
    tables = ["leads", "exclusions", "user_settings", "workspaces", "workspace_members", "companies", "deals",
              "collections", "pipeline_stages"]
    return {t: c.execute(f"select count(*) from public.{t}").fetchone()[0] for t in tables}


def test_migrations_reapply_without_changing_data():
    u = make_user()
    rpc(u, "ensure_personal_workspace")
    with db() as c:
        c.execute("insert into public.user_settings (user_id, key, value) values (%s, 'search.auto', '15')", (u,))
        before = counts(c)
        for f in MIGRATIONS:
            c.execute("set client_min_messages = warning")
            c.execute(f.read_text())
        assert counts(c) == before


def test_old_migration_files_are_untouched_and_new_ones_only_add():
    names = [f.name for f in MIGRATIONS]
    assert names[:2] == ["20261106120000_sync_schema.sql", "20261106120100_email_limits.sql"]
    for f in MIGRATIONS[2:]:
        text = f.read_text().lower()
        code = "\n".join(line.split("--")[0] for line in text.splitlines())
        for forbidden in ("drop table", "drop column", "alter column", "truncate", "drop function", "drop schema"):
            assert forbidden not in code, f"{f.name}: {forbidden}"
        assert "public.leads " not in code.replace("public.leads)", "public.leads "), f.name


def test_every_public_table_has_forced_rls():
    with db() as c:
        rows = c.execute("""select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
                            join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public' and c.relkind = 'r'""").fetchall()
    assert len(rows) >= 25
    assert [r[0] for r in rows if not (r[1] and r[2])] == []


def test_security_definer_functions_pin_search_path():
    with db() as c:
        rows = c.execute("""select n.nspname || '.' || p.proname, p.proconfig from pg_proc p
                            join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname in ('public', 'private') and p.prosecdef""").fetchall()
    assert len(rows) > 30
    bad = [name for name, cfg in rows if not any(x.startswith("search_path=") for x in (cfg or []))]
    assert bad == []


GUARDS = ("private.require_perm(", "private.is_member(", "private.has_perm(", "private.uid()", "auth.uid()",
          "private.require_moderator(", "private.is_platform_admin(")


def test_security_definer_functions_open_to_users_check_the_caller():
    """S8 (ADR-046): каждая security definer функция, которую могут вызвать anon или authenticated, проверяет,
    кто её вызывает. Служебные функции (только service_role) этой проверке не подлежат: у пользователей нет права
    их выполнять."""
    with db() as c:
        rows = c.execute("""select p.proname, p.prosrc,
                                   has_function_privilege('authenticated', p.oid, 'execute'),
                                   has_function_privilege('anon', p.oid, 'execute')
                            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.prosecdef""").fetchall()
    open_to_users = [(name, src) for name, src, auth, anon in rows if auth or anon]
    assert len(open_to_users) > 30
    unguarded = sorted(name for name, src in open_to_users if not any(g in src for g in GUARDS))
    assert unguarded == []
    service_only = {name for name, _, auth, anon in rows if not (auth or anon)}
    assert {"platform_maintenance", "inactive_purge", "email_hook_reserve"} <= service_only


def test_anon_has_no_table_privileges_and_no_crm_functions():
    with db() as c:
        tables = c.execute("""select table_name, privilege_type from information_schema.role_table_grants
                              where grantee = 'anon' and table_schema in ('public', 'private')""").fetchall()
        assert tables == []
        funcs = c.execute("""select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
                               and p.proname in ('crm_push', 'create_workspace', 'ensure_personal_workspace',
                                                 'invite_member', 'accept_invitation', 'my_workspaces',
                                                 'delete_stage', 'crm_maintenance')""").fetchall()
        assert funcs == []


def test_authenticated_cannot_delete_rows_physically():
    with db() as c:
        rows = c.execute("""select table_name from information_schema.role_table_grants
                            where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'DELETE'
                              and table_name not in ('leads', 'exclusions', 'user_settings')""").fetchall()
    assert rows == []
