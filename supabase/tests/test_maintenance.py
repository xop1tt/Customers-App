"""A3. Ежедневная очистка: удаляет только просроченное, аудит не трогает, вызывается только с CRON_SECRET."""

import uuid

import httpx

from conftest import ENV, URL, ANON, db
from crm_helpers import denied, rpc, users, workspace_with
from test_crm import T1, op, push1

CRON = ENV["CRON_SECRET"]


def call(secret: str | None = CRON) -> httpx.Response:
    h = {"apikey": ANON}
    if secret is not None:
        h["x-cron-secret"] = secret
    return httpx.post(f"{URL}/functions/v1/maintenance", headers=h, timeout=60)


def deleted_company(owner: str, ws: str, days: int) -> str:
    o = op("companies", name=f"Удалённая {days}")
    push1(owner, ws, o)
    push1(owner, ws, op("companies", o["id"], kind="delete", ts=T1))
    with db() as c:
        c.execute("alter table public.companies disable trigger companies_crm_stamp")
        c.execute("update public.companies set deleted_at = now() - make_interval(days => %s) where id = %s",
                  (days, o["id"]))
        c.execute("alter table public.companies enable trigger companies_crm_stamp")
    return o["id"]


def count(sql: str, *args) -> int:
    with db() as c:
        return c.execute(sql, args).fetchone()[0]


def test_maintenance_removes_only_expired_rows_and_records_the_run():
    owner, member = users(2)
    ws = workspace_with(owner, {member: "employee"})
    old_tomb, fresh_tomb = deleted_company(owner, ws, 91), deleted_company(owner, ws, 10)
    app = str(uuid.uuid4())
    with db() as c:
        c.execute("update public.sync_ops set applied_at = now() - interval '31 days' where workspace_id = %s", (ws,))
        for days in (100, 5):
            c.execute("""insert into public.notifications (workspace_id, user_id, kind, created_at)
                         values (%s, %s, 'mention', now() - make_interval(days => %s))""", (ws, member, days))
            c.execute("""insert into private.market_deliveries (workspace_id, app_id, event, created_at)
                         values (%s, %s, 'x', now() - make_interval(days => %s))""", (ws, app, days // 3))
        c.execute("""insert into public.workspace_presence (workspace_id, user_id, seen_at)
                     values (%s, %s, now() - interval '2 days')
                     on conflict (workspace_id, user_id) do update set seen_at = excluded.seen_at""", (ws, member))
        c.execute("""insert into public.audit_log (workspace_id, action, at)
                     values (%s, 'old.action', now() - interval '3 years')""", (ws,))

    r = call()
    assert r.status_code == 200, r.text
    removed = r.json()["removed"]
    assert removed["tombstones"] >= 1 and removed["sync_ops"] >= 1
    assert removed["notifications"] >= 1 and removed["deliveries"] >= 1 and removed["presence"] >= 1

    assert count("select count(*) from public.companies where id = %s", old_tomb) == 0
    assert count("select count(*) from public.companies where id = %s", fresh_tomb) == 1
    assert count("select count(*) from public.sync_ops where workspace_id = %s", ws) == 0
    assert count("select count(*) from public.notifications where workspace_id = %s", ws) == 1
    assert count("select count(*) from private.market_deliveries where app_id = %s", app) == 1
    assert count("select count(*) from public.workspace_presence where workspace_id = %s and user_id = %s",
                 ws, member) == 0
    assert count("select count(*) from public.audit_log where workspace_id = %s and action = 'old.action'", ws) == 1
    with db() as c:
        last = c.execute("select result from private.maintenance_runs order by id desc limit 1").fetchone()[0]
    assert last == removed


def test_maintenance_needs_the_cron_secret():
    assert call(None).status_code == 401
    assert call("wrong-secret-" + uuid.uuid4().hex).status_code == 401


def test_platform_maintenance_is_closed_to_users_and_anon():
    owner = users(1)[0]
    denied("42501", rpc, owner, "platform_maintenance")
    with db() as c:
        for role in ("anon", "authenticated"):
            assert c.execute("select has_function_privilege(%s, 'public.platform_maintenance()', 'execute')",
                             (role,)).fetchone()[0] is False


def drop_users(*uids: str) -> None:
    """Удалить учётные записи одной транзакцией (как удаление аккаунта в Auth)."""
    with db() as c:
        c.execute("delete from auth.users where id = any(%s::uuid[])", (list(uids),))


def age_deleted_workspace(ws: str, days: int) -> None:
    with db() as c:
        c.execute("update public.workspaces set deleted_at = now() - make_interval(days => %s) where id = %s", (days, ws))


def test_workspace_without_members_is_purged_30_days_after_the_last_account_is_deleted():
    """S6 (ADR-046, решение Maksim): данные не остаются навсегда после удаления всех учётных записей."""
    a, b, keeper = users(3)
    lonely = workspace_with(a, {b: "employee"})
    company = op("companies", name="Останется ли?")
    push1(a, lonely, company)
    conv = rpc(a, "chat_open_direct", p_workspace=lonely, p_user=b)
    rpc(a, "chat_send", p_conversation=conv["id"], p_body="Привет")
    recent = workspace_with(keeper, {})

    drop_users(a, b)
    with db() as c:
        assert c.execute("select deleted_at is not null from public.workspaces where id = %s", (lonely,)).fetchone()[0]

    age_deleted_workspace(lonely, 29)
    assert call().status_code == 200
    assert count("select count(*) from public.workspaces where id = %s", lonely) == 1, "раньше 30 дней не удаляется"

    age_deleted_workspace(lonely, 31)
    r = call()
    assert r.status_code == 200, r.text
    assert r.json()["removed"]["workspaces"] >= 1
    assert count("select count(*) from public.workspaces where id = %s", lonely) == 0
    assert count("select count(*) from public.companies where id = %s", company["id"]) == 0
    assert count("select count(*) from public.chat_conversations where workspace_id = %s", lonely) == 0
    assert count("select count(*) from public.workspaces where id = %s", recent) == 1


def test_deleted_workspace_with_active_members_is_kept():
    owner, member = users(2)
    ws = workspace_with(owner, {member: "employee"})
    with db() as c:
        c.execute("update public.workspaces set deleted_at = now() - interval '100 days' where id = %s", (ws,))
    assert call().status_code == 200
    assert count("select count(*) from public.workspaces where id = %s", ws) == 1
