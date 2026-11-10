"""Неподтверждённые регистрации удаляются через `unconfirmed_ttl`, подтверждённые остаются."""

from conftest import Client, confirmed_user, db, mails, unique_email


def exists(email: str) -> bool:
    with db() as c:
        return c.execute("select count(*) from auth.users where email = %s", (email,)).fetchone()[0] == 1


def age(email: str, hours: int) -> None:
    with db() as c:
        c.execute("update auth.users set created_at = now() - make_interval(hours => %s) where email = %s", (hours, email))


def purge() -> int:
    with db() as c:
        return c.execute("select private.purge_unconfirmed_users()").fetchone()[0]


def test_old_unconfirmed_signup_is_removed_but_fresh_and_confirmed_stay():
    stale, fresh = unique_email("stale"), unique_email("fresh")
    assert Client().signup(stale).status_code == 200
    assert Client().signup(fresh).status_code == 200
    _, confirmed = confirmed_user()
    age(stale, 25)
    age(fresh, 2)
    age(confirmed, 48)
    assert purge() >= 1
    assert not exists(stale)
    assert exists(fresh) and exists(confirmed)


def test_ttl_is_configurable_and_limited():
    email = unique_email("ttl")
    assert Client().signup(email).status_code == 200
    age(email, 3)
    assert purge() == 0 and exists(email)
    with db() as c:
        c.execute("update private.email_limits set unconfirmed_ttl = interval '2 hours' where id = 1")
    try:
        assert purge() >= 1 and not exists(email)
    finally:
        with db() as c:
            c.execute("update private.email_limits set unconfirmed_ttl = interval '24 hours' where id = 1")


def test_cleanup_runs_with_email_requests_and_user_can_register_again():
    email = unique_email("again")
    c = Client()
    assert c.signup(email).status_code == 200
    assert len(mails(email, wait=3)) == 1
    age(email, 30)
    # Любой запрос письма из приложения запускает очистку.
    assert Client().gate("signup", unique_email("other")).status_code == 200
    assert not exists(email)
    with db() as d:  # «прошло 16 минут» — интервал повторной отправки не мешает
        d.execute("update private.email_sends set created_at = now() - interval '16 minutes'")
        d.execute("update private.email_tickets set created_at = now() - interval '16 minutes'")
    assert Client().signup(email).status_code == 200
    assert exists(email)
