"""Модерация коннекторов (миграция 20261121140000_market_moderation.sql, ADR-095): модераторы платформы, проверка
компаний, серверная автопроверка, журнал решений и уведомления разработчику. Права проверяет сервер, а не интерфейс."""

from __future__ import annotations

import uuid

import pytest

from conftest import db
from crm_helpers import denied, email_of, make_user, rpc, users, workspace_with
from test_marketplace import MANIFEST, moderator, pending_of, submit, verified_company

COMPANY = {"legal_name": "ООО «Склад»", "country": "Россия", "reg_number": "7712345678", "website": "https://sklad.example.com",
           "privacy_url": "https://sklad.example.com/privacy", "contact_name": "Анна Складова", "contact_email": "anna@sklad.example.com"}


def notices(uid: str) -> dict:
    return rpc(uid, "market_notices")


def audit(mod: str) -> list[dict]:
    return rpc(mod, "market_audit_log")


def legacy_pending(dev: str, **app) -> str:
    """Версия, поданная до этой миграции: без проверки компании и серверной автопроверки."""
    with db() as c:
        app_id = c.execute("""insert into public.market_apps (slug, developer_id, developer_name, name, tagline, website, support_email)
                              values (%s, %s, 'Старый разработчик', %s, %s, 'https://example.com', 'help@example.com') returning id""",
                           (f"old-{uuid.uuid4().hex[:8]}", dev, app.get("name", "Старый коннектор"), app.get("tagline", "Кратко"))).fetchone()[0]
        return str(c.execute("insert into public.market_versions (app_id, version, manifest) values (%s, '1.0.0', %s::jsonb) returning id",
                             (app_id, '{"schema": 1, "actions": []}')).fetchone()[0])


# ------------------------------------------------------------------ только модераторы платформы

@pytest.mark.parametrize("fn,args", [
    ("market_review_queue", {}),
    ("market_review", {"p_version": str(uuid.uuid4()), "p_approve": True}),
    ("market_suspend", {"p_app": str(uuid.uuid4()), "p_suspend": True, "p_note": "x"}),
    ("market_suspended", {}),
    ("market_company_queue", {}),
    ("market_company_review", {"p_user": str(uuid.uuid4()), "p_approve": True}),
    ("market_audit_log", {}),
    ("market_moderators", {}),
    ("market_moderator_add", {"p_email": "someone@example.com"}),
    ("market_moderator_remove", {"p_user": str(uuid.uuid4())}),
])
def test_moderation_functions_refuse_everyone_but_platform_moderators(fn, args):
    owner = users(1)[0]
    workspace_with(owner, {})  # владелец Workspace — не модератор платформы
    denied("42501", rpc, owner, fn, **args)


def test_moderation_tables_are_not_reachable_directly():
    with db() as c:
        for t in ("market_companies", "market_audit", "market_notices", "platform_admins"):
            assert c.execute(f"select has_table_privilege('authenticated', 'private.{t}', 'select')").fetchone()[0] is False
            assert c.execute(f"select has_table_privilege('authenticated', 'private.{t}', 'insert')").fetchone()[0] is False
        assert c.execute("select has_function_privilege('anon', 'public.market_moderator_add(text)', 'execute')").fetchone()[0] is False


# ------------------------------------------------------------------ компания разработчика

def test_only_a_verified_company_can_submit_and_decisions_reach_the_developer():
    dev, mod = users(1)[0], moderator()
    assert rpc(dev, "market_company")["status"] == "none"
    app = {"slug": f"app-{uuid.uuid4().hex[:8]}", "name": "Склад", "tagline": "Остатки склада в карточке сделки",
           "website": "https://sklad.example.com", "support_email": "help@sklad.example.com", "version": "1.0.0", "manifest": MANIFEST}
    denied("42501", rpc, dev, "market_submit", p_app=app)

    denied("22023", rpc, dev, "market_company_save", p_company={**COMPANY, "contact_email": "anna@gmail.com"})
    denied("22023", rpc, dev, "market_company_save", p_company={**COMPANY, "contact_email": "anna@other.example.org"})
    denied("22023", rpc, dev, "market_company_save", p_company={**COMPANY, "privacy_url": "https://elsewhere.com/privacy"})
    assert rpc(dev, "market_company_save", p_company=COMPANY)["status"] == "submitted"
    assert [x["company"]["legal_name"] for x in rpc(mod, "market_company_queue") if x["user_id"] == dev] == ["ООО «Склад»"]

    denied("22023", rpc, mod, "market_company_review", p_user=dev, p_approve=False, p_note=" ")
    rpc(mod, "market_company_review", p_user=dev, p_approve=False, p_note="Номер не найден в реестре")
    assert rpc(dev, "market_company")["note"] == "Номер не найден в реестре"
    denied("P0002", rpc, mod, "market_company_review", p_user=dev, p_approve=True)

    rpc(dev, "market_company_save", p_company=COMPANY)
    rpc(mod, "market_company_review", p_user=dev, p_approve=True)
    denied("42501", rpc, dev, "market_company_save", p_company=COMPANY)
    got = rpc(dev, "market_submit", p_app={**app, "developer_name": "Подмена"})
    assert got["developer_name"] == "ООО «Склад»", "имя разработчика берётся из проверенной компании"

    n = notices(dev)
    assert n["unread"] == 2
    assert [x["kind"] for x in n["items"]] == ["company_verified", "company_rejected"]
    assert n["items"][1]["note"] == "Номер не найден в реестре"
    rpc(dev, "market_notices_read")
    assert notices(dev)["unread"] == 0
    assert notices(mod)["items"] == [], "уведомления видит только адресат"


# ------------------------------------------------------------------ автопроверка на сервере

def test_server_runs_the_automatic_checks_and_stores_the_report():
    dev = users(1)[0]
    with pytest.raises(Exception, match="Автопроверка"):
        submit(dev, tagline="Коротко")
    assert rpc(dev, "market_my_apps") == [], "отказ автопроверки ничего не создаёт"
    with pytest.raises(Exception, match="Автопроверка"):
        submit(dev, support_email=None)
    with pytest.raises(Exception, match="Автопроверка"):
        submit(dev, manifest={"schema": 1, "actions": []})
    submit(dev, manifest={**MANIFEST, "webhooks": {"url": "https://hooks.other-service.com/x", "events": ["record.created"]}})
    checks = rpc(dev, "market_my_apps")[0]["versions"][0]["checks"]
    assert {c["id"]: c["level"] for c in checks} == {"description": "warn", "hosts": "warn"}


def test_approval_needs_clean_checks_and_a_verified_company():
    dev, mod = users(1)[0], moderator()
    bad = legacy_pending(dev)
    item = next(x for x in rpc(mod, "market_review_queue") if x["version_id"] == bad)
    assert {c["id"] for c in item["server_checks"] if c["level"] == "fail"} >= {"tagline", "empty"}
    assert item["company"] is None
    denied("22023", rpc, mod, "market_review", p_version=bad, p_approve=True)
    rpc(mod, "market_review", p_version=bad, p_approve=False, p_note="Пустой манифест")

    clean = legacy_pending(dev, tagline="Остатки склада в карточке сделки")
    with db() as c:
        c.execute("update public.market_versions set manifest = %s::jsonb where id = %s",
                  ('{"schema": 1, "actions": [{"id": "a", "label": "A", "entity": "deal", "url": "https://example.com/{id}"}]}', clean))
    denied("42501", rpc, mod, "market_review", p_version=clean, p_approve=True)
    verified_company(dev)
    rpc(mod, "market_review", p_version=clean, p_approve=True)


# ------------------------------------------------------------------ каталог, журнал, уведомления

def test_unapproved_apps_never_reach_the_catalog_or_a_workspace():
    owner, dev, mod = users(2) + [moderator()]
    ws = workspace_with(owner, {})
    app = submit(dev)
    denied("P0002", rpc, owner, "market_install", p_workspace=ws, p_app=app["id"])
    rpc(mod, "market_review", p_version=pending_of(mod, app["id"])["version_id"], p_approve=False, p_note="Нет политики")
    assert [x for x in rpc(owner, "market_catalog", p_workspace=ws) if x["id"] == app["id"]] == []
    denied("P0002", rpc, owner, "market_install", p_workspace=ws, p_app=app["id"])


def test_every_decision_is_logged_and_the_developer_is_notified():
    owner, dev, mod = users(2) + [moderator()]
    app = submit(dev)
    rpc(mod, "market_review", p_version=pending_of(mod, app["id"])["version_id"], p_approve=True)
    denied("22023", rpc, mod, "market_suspend", p_app=app["id"], p_suspend=True, p_note="")
    rpc(mod, "market_suspend", p_app=app["id"], p_suspend=True, p_note="Жалобы пользователей")
    assert [a["id"] for a in rpc(mod, "market_suspended")].count(app["id"]) == 1
    rpc(mod, "market_suspend", p_app=app["id"], p_suspend=False)

    log = [x for x in audit(mod) if x["app_id"] == app["id"]]
    assert [x["action"] for x in log] == ["app_restored", "app_suspended", "version_approved"]
    assert log[1]["note"] == "Жалобы пользователей" and log[0]["actor_email"] == email_of(mod)
    approved = log[2]["details"]
    assert approved["version"] == "1.0.0" and approved["scopes"] == ["crm.read"] and approved["developer_email"] == email_of(dev)
    assert approved["manifest"]["webhooks"]["url"] == MANIFEST["webhooks"]["url"]

    kinds = [x["kind"] for x in notices(dev)["items"]]
    assert kinds == ["app_restored", "app_suspended", "version_approved"]

    submit(dev, id=app["id"], version="1.1.0")
    item = pending_of(mod, app["id"])
    assert item["live_version"] == "1.0.0" and [h["action"] for h in item["history"]][:1] == ["app_restored"]
    with db() as c:
        assert c.execute("select has_table_privilege('authenticated', 'private.market_audit', 'delete')").fetchone()[0] is False


# ------------------------------------------------------------------ модераторы

def test_moderators_add_and_remove_each_other_but_never_the_last_one():
    with db() as c:
        c.execute("delete from private.platform_admins")
    first = moderator()
    second = make_user()
    denied("P0002", rpc, first, "market_moderator_add", p_email="nobody@example.com")
    unconfirmed = make_user(confirmed=False)
    denied("P0002", rpc, first, "market_moderator_add", p_email=email_of(unconfirmed))
    rpc(first, "market_moderator_add", p_email=email_of(second).upper())
    assert rpc(second, "market_is_moderator") is True
    mods = rpc(second, "market_moderators")
    assert {m["email"] for m in mods} == {email_of(first), email_of(second)}
    assert next(m for m in mods if m["user_id"] == second)["added_by_email"] == email_of(first)
    rpc(second, "market_moderator_remove", p_user=first)
    assert rpc(first, "market_is_moderator") is False
    denied("42501", rpc, second, "market_moderator_remove", p_user=second)
    actions = [x["action"] for x in audit(second) if x["action"].startswith("moderator_")][:2]
    assert actions == ["moderator_removed", "moderator_added"]
