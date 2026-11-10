"""Неактивные аккаунты: предупреждение по почте, «Сохранить аккаунт», удаление только после предупреждения."""

import httpx

from conftest import ENV, URL, ANON, db, mails
from crm_helpers import make_user, email_of, workspace_with, rpc

CRON = ENV["CRON_SECRET"]


def age(uid: str, days: int) -> None:
    """Состарить аккаунт: созданию и входу — days дней."""
    with db() as c:
        c.execute("""update auth.users set created_at = now() - make_interval(days => %s),
                            last_sign_in_at = now() - make_interval(days => %s) where id = %s""", (days, days, uid))


def age_warning(uid: str, days: int) -> None:
    with db() as c:
        c.execute("update private.inactive_notices set warned_at = now() - make_interval(days => %s) where user_id = %s",
                  (days, uid))


def exists(uid: str) -> bool:
    with db() as c:
        return c.execute("select count(*) from auth.users where id = %s", (uid,)).fetchone()[0] == 1


def call(secret: str | None = CRON) -> httpx.Response:
    h = {"apikey": ANON}
    if secret is not None:
        h["x-cron-secret"] = secret
    return httpx.post(f"{URL}/functions/v1/inactive-accounts", headers=h, timeout=60)


def due_ids() -> set[str]:
    with db() as c:
        rows = c.execute("select jsonb_array_elements(public.inactive_accounts_due(100))->>'user_id'").fetchall()
    return {r[0] for r in rows}


def keep_link(email: str) -> str:
    import re
    m = mails(email, wait=5)[-1]
    assert "Сохранить аккаунт" in m["html"]
    assert "Код:" not in m["text"]
    return re.search(r"(http\S*keep-account\?token=[0-9a-f]{64})", m["text"]).group(1)


def test_only_inactive_confirmed_accounts_are_selected():
    old, recent, unconfirmed = make_user(), make_user(), make_user(confirmed=False)
    age(old, 800)
    age(recent, 100)
    age(unconfirmed, 800)
    ids = due_ids()
    assert old in ids and recent not in ids and unconfirmed not in ids


def test_no_deletion_without_warning():
    uid = make_user()
    age(uid, 2000)
    with db() as c:
        c.execute("select public.inactive_purge(200)")
    assert exists(uid)


def test_requires_cron_secret():
    assert call(None).status_code == 401
    assert call("wrong-secret-wrong-secret").status_code == 401


def test_warning_mail_is_sent_then_account_removed_after_the_grace_period():
    uid = make_user()
    age(uid, 750)
    r = call()
    assert r.status_code == 200 and r.json()["warned"] >= 1
    link = keep_link(email_of(uid))
    assert link
    assert exists(uid)
    # Повторный запуск не шлёт второе письмо и не удаляет: льготный срок ещё идёт.
    n = len(mails(email_of(uid)))
    call()
    assert len(mails(email_of(uid))) == n and exists(uid)
    # Срок вышел: письму более 30 дней, активности нет, неактивность более 2 лет.
    age(uid, 800)
    age_warning(uid, 31)
    assert call().json()["deleted"] >= 1
    assert not exists(uid)


def test_keep_link_saves_account_and_restarts_the_clock():
    uid = make_user()
    age(uid, 750)
    call()
    link = keep_link(email_of(uid))
    age_warning(uid, 31)
    age(uid, 800)
    r = httpx.get(link, timeout=30)
    assert r.status_code == 200 and "сохранён" in r.text
    call()
    assert exists(uid)
    assert uid not in due_ids()


def test_keep_link_rejects_bad_tokens():
    assert httpx.get(f"{URL}/functions/v1/keep-account?token=abc", timeout=30).status_code == 400
    assert httpx.get(f"{URL}/functions/v1/keep-account?token={'0' * 64}", timeout=30).status_code == 404
    assert httpx.post(f"{URL}/functions/v1/keep-account?token={'0' * 64}", timeout=30).status_code == 405


def test_sign_in_after_warning_cancels_deletion():
    uid = make_user()
    age(uid, 800)
    call()
    age_warning(uid, 31)
    with db() as c:  # пользователь вошёл уже после предупреждения
        c.execute("update auth.users set last_sign_in_at = now() where id = %s", (uid,))
    call()
    assert exists(uid)


def test_members_of_shared_workspaces_are_never_removed():
    owner, member = make_user(), make_user()
    workspace_with(owner, {member: "employee"})
    age(member, 900)
    assert member not in due_ids()
    with db() as c:
        c.execute("insert into private.inactive_notices (user_id, warned_at, keep_token_hash) values (%s, now() - interval '40 days', %s)",
                  (member, "a" * 64))
        c.execute("select public.inactive_purge(200)")
    assert exists(member)


def test_functions_are_not_available_to_clients():
    uid = make_user()
    for name, args in [("inactive_purge", {"p_limit": 10}), ("inactive_accounts_due", {"p_limit": 10})]:
        r = httpx.post(f"{URL}/rest/v1/rpc/{name}", headers={"apikey": ANON, "authorization": f"Bearer {ANON}"}, json=args)
        assert r.status_code in (401, 403, 404), (name, r.status_code)
