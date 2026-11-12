"""Маркетплейс интеграций (миграция 20261111100000_marketplace.sql): подача, модерация, каталог, установка,
кнопки в карточках и события для интеграций с подписью.

pg_net и pgcrypto на локальном стенде нет: для проверки отправки событий их заменяют заглушки с тем же
интерфейсом (`net.http_post`, `extensions.hmac`), запросы записываются в таблицу."""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid

import pytest

from conftest import db
from crm_helpers import denied, one, rpc, users, workspace_with

MANIFEST = {
    "schema": 1,
    "scopes": ["crm.read"],
    "webhooks": {"url": "https://hooks.example.com/customers", "events": ["record.created", "deal.stage_changed"]},
    "actions": [{"id": "open", "label": "Открыть в Звонилке", "entity": "company", "url": "https://app.example.com/c/{id}?n={title}"}],
}


def moderator() -> str:
    u = users(1)[0]
    with db() as c:
        c.execute("insert into private.platform_admins (user_id) values (%s)", (u,))
    return u


def submit(dev: str, **over) -> dict:
    app = {"slug": f"app-{uuid.uuid4().hex[:8]}", "name": "Звонилка", "developer_name": "ООО Звонки", "tagline": "Звонки из карточки",
           "description": "Описание", "category": "telephony", "icon": "📞", "website": "https://example.com",
           "support_email": "help@example.com", "version": "1.0.0", "manifest": MANIFEST, **over}
    return rpc(dev, "market_submit", p_app=app)


def pending_of(mod: str, app_id: str) -> dict:
    return next(x for x in rpc(mod, "market_review_queue") if x["app"]["id"] == app_id)


def listed(dev: str, mod: str, **over) -> dict:
    app = submit(dev, **over)
    rpc(mod, "market_review", p_version=pending_of(mod, app["id"])["version_id"], p_approve=True)
    return app


# ------------------------------------------------------------------ подача и модерация

def test_submitted_app_is_hidden_until_a_moderator_approves_it():
    dev, user = users(2)
    mod = moderator()
    app = submit(dev)
    assert app["status"] == "draft"
    assert [x for x in rpc(user, "market_catalog") if x["id"] == app["id"]] == [], "до одобрения в каталоге нет"
    assert rpc(dev, "market_my_apps")[0]["versions"][0]["status"] == "pending"
    denied("42501", rpc, dev, "market_review_queue")
    denied("42501", rpc, dev, "market_review", p_version=str(uuid.uuid4()), p_approve=True)
    assert rpc(dev, "market_is_moderator") is False and rpc(mod, "market_is_moderator") is True
    item = pending_of(mod, app["id"])
    assert item["manifest"]["actions"][0]["entity"] == "company" and item["developer_email"]
    denied("22023", rpc, mod, "market_review", p_version=item["version_id"], p_approve=False, p_note="  ")
    rpc(mod, "market_review", p_version=item["version_id"], p_approve=True)
    got = next(x for x in rpc(user, "market_catalog") if x["id"] == app["id"])
    assert got["status"] == "listed" and got["version"] == "1.0.0" and got["manifest"]["scopes"] == ["crm.read"]


def test_new_version_waits_for_review_and_rejection_needs_a_reason():
    dev, mod = users(1)[0], moderator()
    app = listed(dev, mod)
    submit(dev, id=app["id"], version="1.1.0", tagline="Новое описание", manifest={"schema": 1, "actions": []})
    cat = next(x for x in rpc(dev, "market_catalog") if x["id"] == app["id"])
    assert cat["version"] == "1.0.0" and cat["tagline"] == "Новое описание", "описание сразу, манифест — после проверки"
    item = pending_of(mod, app["id"])
    assert item["live_manifest"]["scopes"] == ["crm.read"]
    rpc(mod, "market_review", p_version=item["version_id"], p_approve=False, p_note="Нет инструкции")
    versions = rpc(dev, "market_my_apps")[0]["versions"]
    assert [(v["version"], v["status"]) for v in versions] == [("1.1.0", "rejected"), ("1.0.0", "approved")]
    assert versions[0]["review_note"] == "Нет инструкции"


def test_only_the_developer_changes_an_app():
    dev, other, mod = users(2) + [moderator()]
    app = listed(dev, mod)
    denied("P0002", submit, other, id=app["id"], version="2.0.0")
    denied("23505", submit, other, slug=app["slug"])


@pytest.mark.parametrize("bad", [
    {"schema": 2},
    {"scopes": ["crm.write"]},
    {"webhooks": {"url": "http://example.com/x", "events": ["record.created"]}},
    {"webhooks": {"url": "https://localhost/x", "events": ["record.created"]}},
    {"webhooks": {"url": "https://10.0.0.1/x", "events": ["record.created"]}},
    {"webhooks": {"url": "https://ok.example.com/x", "events": []}},
    {"webhooks": {"url": "https://ok.example.com/x", "events": ["user.deleted"]}},
    {"actions": [{"id": "a", "label": "X", "entity": "task", "url": "https://ok.example.com"}]},
    {"actions": [{"id": "a", "label": "X", "entity": "company", "url": "javascript:alert(1)"}]},
    {"actions": [{"id": "a", "label": "X", "entity": "company", "url": "https://ok.example.com/{title}"}]},
    {"actions": [{"id": "a", "label": "X", "entity": "company", "url": "https://ok.example.com/{phones}"}]},
    {"window": {"url": "file:///etc/passwd"}},
])
def test_manifest_is_validated(bad):
    denied("22023", submit, users(1)[0], manifest={"schema": 1, **bad})


def test_app_card_fields_are_checked():
    dev = users(1)[0]
    for over in ({"slug": "A b"}, {"icon": "<img>"}, {"website": "http://x.com"}, {"category": "games"}, {"version": "1.0"}, {"name": ""}):
        with pytest.raises(Exception):
            submit(dev, **over)


def test_submission_limit_per_day():
    dev = users(1)[0]
    for _ in range(10):
        submit(dev)
    denied("54000", submit, dev)


# ------------------------------------------------------------------ установка

def test_install_needs_workspace_manage_and_shows_buttons_to_members():
    owner, emp, dev, mod = users(3) + [moderator()]
    ws = workspace_with(owner, {emp: "employee"})
    app = listed(dev, mod)
    denied("42501", rpc, emp, "market_install", p_workspace=ws, p_app=app["id"])
    got = rpc(owner, "market_install", p_workspace=ws, p_app=app["id"])
    assert got["installed"]["enabled"] is True and got["installed"]["update_available"] is False
    buttons = rpc(emp, "market_installed", p_workspace=ws)
    assert [b["name"] for b in buttons] == ["Звонилка"] and buttons[0]["actions"][0]["label"] == "Открыть в Звонилке"
    assert "secret" not in json.dumps(buttons), "секрет подписи в приложение не уходит"
    rpc(owner, "market_set_enabled", p_workspace=ws, p_app=app["id"], p_enabled=False)
    assert rpc(emp, "market_installed", p_workspace=ws) == []
    denied("42501", rpc, emp, "market_uninstall", p_workspace=ws, p_app=app["id"])
    rpc(owner, "market_uninstall", p_workspace=ws, p_app=app["id"])
    assert next(x for x in rpc(owner, "market_catalog", p_workspace=ws) if x["id"] == app["id"])["installed"] is None
    with db() as c:
        actions = [r[0] for r in c.execute("select action from public.audit_log where workspace_id = %s and action like 'market.%%' order by id", (ws,))]
    assert actions == ["market.installed", "market.uninstalled"]


def test_installed_version_is_kept_until_the_owner_updates():
    owner, dev, mod = users(2) + [moderator()]
    ws = workspace_with(owner, {})
    app = listed(dev, mod)
    rpc(owner, "market_install", p_workspace=ws, p_app=app["id"])
    submit(dev, id=app["id"], version="2.0.0", manifest={"schema": 1, "scopes": ["crm.read"], "actions": []})
    rpc(mod, "market_review", p_version=pending_of(mod, app["id"])["version_id"], p_approve=True)
    cat = next(x for x in rpc(owner, "market_catalog", p_workspace=ws) if x["id"] == app["id"])
    assert cat["version"] == "2.0.0" and cat["installed"]["version"] == "1.0.0" and cat["installed"]["update_available"] is True
    assert rpc(owner, "market_installed", p_workspace=ws)[0]["actions"], "кнопки старой версии остаются"
    rpc(owner, "market_install", p_workspace=ws, p_app=app["id"])
    assert rpc(owner, "market_installed", p_workspace=ws)[0]["actions"] == []


def test_suspended_app_disappears_and_stops_everywhere():
    owner, dev, mod = users(2) + [moderator()]
    ws = workspace_with(owner, {})
    app = listed(dev, mod)
    rpc(owner, "market_install", p_workspace=ws, p_app=app["id"])
    rpc(mod, "market_suspend", p_app=app["id"], p_suspend=True, p_note="Жалобы")
    assert [x for x in rpc(owner, "market_catalog") if x["id"] == app["id"]] == []
    assert rpc(owner, "market_installed", p_workspace=ws) == []
    denied("42501", submit, dev, id=app["id"], version="3.0.0")
    assert rpc(dev, "market_my_apps")[0]["status_note"] == "Жалобы"
    rpc(mod, "market_suspend", p_app=app["id"], p_suspend=False)
    assert rpc(owner, "market_installed", p_workspace=ws)


def test_market_tables_are_closed_and_functions_need_sign_in():
    with db() as c:
        for t in ("market_apps", "market_versions", "market_installs"):
            assert c.execute(f"select has_table_privilege('authenticated', 'public.{t}', 'select')").fetchone()[0] is False
        assert c.execute("select has_function_privilege('anon', 'public.market_catalog(uuid, text, text)', 'execute')").fetchone()[0] is False


# ------------------------------------------------------------------ события

@pytest.fixture()
def http_stub():
    with db() as c:
        if c.execute("select to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null").fetchone()[0]:
            pytest.fail("на стенде настоящий pg_net: тест рассчитан на заглушку")
        c.execute("""
            create schema if not exists extensions;
            create extension if not exists pgcrypto with schema extensions;
            create schema if not exists net;
            create table if not exists net.test_requests (id bigserial primary key, url text, body jsonb, headers jsonb);
            create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
                                                     headers jsonb default '{}', timeout_milliseconds integer default 5000)
                returns bigint language sql as
                $f$ insert into net.test_requests (url, body, headers) values (url, body, headers) returning id $f$;
        """)
        c.execute("update private.market_relay set url = %s where id = 1", (RELAY,))
    yield
    with db() as c:
        c.execute("update private.market_relay set url = null where id = 1")
        c.execute("drop schema net cascade; drop extension if exists pgcrypto; drop schema if exists extensions")


RELAY = "https://relay.test/functions/v1/market-relay"


def relayed() -> list[tuple[str, dict, dict]]:
    """Запросы базы к market-relay (ADR-046): адрес, конверт, заголовки."""
    with db() as c:
        return c.execute("select url, body, headers from net.test_requests order by id").fetchall()


def requests() -> list[tuple[str, dict, dict]]:
    """То, что market-relay отправит интеграции: её адрес, подписанное тело и заголовки подписи."""
    out = []
    for url, env, headers in relayed():
        assert url == RELAY and headers["x-relay-secret"] == relay_secret()
        out.append((env["url"], json.loads(env["payload"]),
                    {"X-Customers-Event": env["event"], "X-Customers-Signature": env["signature"], "_text": env["payload"]}))
    return out


def relay_secret() -> str:
    with db() as c:
        return c.execute("select secret from private.market_relay where id = 1").fetchone()[0]


def company(uid: str, ws: str, name: str) -> str:
    rid = str(uuid.uuid4())
    ts = "2026-11-11T10:00:00Z"
    op = {"op_id": str(uuid.uuid4()), "entity": "companies", "id": rid, "kind": "upsert", "fields": {"name": name},
          "ts": {"name": ts}, "base_version": 0}
    res = rpc(uid, "crm_push", p_workspace=ws, p_device="dev-test", p_ops=[op])
    assert res["results"][0]["status"] in ("applied", "merged"), res
    return rid


def test_events_are_signed_and_respect_scopes(http_stub):
    owner, dev, mod = users(2) + [moderator()]
    ws = workspace_with(owner, {})
    full = listed(dev, mod)
    ids_only = listed(dev, mod, manifest={"schema": 1, "webhooks": {"url": "https://ids.example.com/h", "events": ["record.created"]}})
    rpc(owner, "market_install", p_workspace=ws, p_app=full["id"])
    rpc(owner, "market_install", p_workspace=ws, p_app=ids_only["id"])
    installed = requests()
    assert [b["event"] for _, b, _ in installed] == ["app.installed", "app.installed"]
    secret = installed[0][1]["secret"]
    assert len(secret) == 64

    rid = company(owner, ws, "ООО Зерно")
    sent = requests()[2:]
    by_url = {u: (b, h) for u, b, h in sent}
    body, headers = by_url["https://hooks.example.com/customers"]
    assert body["event"] == "record.created" and body["entity_id"] == rid and body["record"]["name"] == "ООО Зерно"
    as_text = headers["_text"]  # тело ровно в том виде, в каком market-relay его отправит
    assert headers["X-Customers-Signature"] == "sha256=" + hmac.new(secret.encode(), as_text.encode(), hashlib.sha256).hexdigest()
    ids_body, _ = by_url["https://ids.example.com/h"]
    assert "record" not in ids_body and ids_body["entity_id"] == rid, "без crm.read — только идентификаторы"

    # Выключенная интеграция событий не получает.
    rpc(owner, "market_set_enabled", p_workspace=ws, p_app=full["id"], p_enabled=False)
    before = len(requests())
    company(owner, ws, "ООО Мука")
    assert [u for u, _, _ in requests()[before:]] == ["https://ids.example.com/h"]


def test_database_never_calls_the_integration_url_directly(http_stub):
    """S2 (ADR-046): все запросы базы идут только в market-relay; без его адреса события не отправляются."""
    owner, dev, mod = users(2) + [moderator()]
    ws = workspace_with(owner, {})
    app = listed(dev, mod)
    rpc(owner, "market_install", p_workspace=ws, p_app=app["id"])
    company(owner, ws, "ООО Ячмень")
    assert relayed() and all(u == RELAY for u, _, _ in relayed())

    with db() as c:
        c.execute("update private.market_relay set url = null where id = 1")
    before = len(relayed())
    company(owner, ws, "ООО Овёс")
    assert len(relayed()) == before, "без market-relay база не отправляет ничего"


def test_relay_config_is_hidden_from_users():
    owner = users(1)[0]
    denied("42501", one, owner, "select secret from private.market_relay")
    with db() as c:
        secret = c.execute("select secret from private.market_relay where id = 1").fetchone()[0]
    assert len(secret) == 64
