"""Докупка места под вложения разовым платежом (ADR-098): права на покупку, журнал платежей, начисление один раз."""

import uuid

import psycopg
import pytest

from conftest import db
from crm_helpers import denied, one, q, rpc, users, workspace_with

GB = 1024 ** 3
BASE = 300 * 1024 * 1024
RUN = {"id": ""}


@pytest.fixture(autouse=True)
def fresh_payment_ids():
    # Номер платежа уникален во всём журнале, а стенд между тестами не очищается.
    RUN["id"] = uuid.uuid4().hex[:8]


def P(name: str) -> str:
    return f"PP-{name}-{RUN['id']}"


def service(name: str, *args):
    """Вызов от имени service_role, как это делает Edge Function storage-pay."""
    with db() as c:
        c.execute("set role service_role")
        ph = ", ".join(["%s"] * len(args))
        return c.execute(f"select public.{name}({ph})", args).fetchone()[0]


def limit(uid, ws) -> int:
    return rpc(uid, "attachment_usage", p_workspace=ws)["limit"]


def bought(owner, ws, pack="gb1", payment=None):
    payment = payment or P("1")
    o = rpc(owner, "storage_order_create", p_workspace=ws, p_pack=pack)
    service("storage_order_bind", o["id"], "paypal", payment)
    return o


def test_owner_and_admin_buy_space_once_per_payment():
    owner, admin, emp = users(3)
    ws = workspace_with(owner, {admin: "admin", emp: "employee"})
    o = rpc(admin, "storage_order_create", p_workspace=ws, p_pack="gb1")
    assert o["bytes"] == GB and o["amount_minor"] == 300 and o["currency"] == "USD"
    service("storage_order_bind", o["id"], "paypal", P("A"))

    assert service("storage_order_settle", "paypal", P("A"), "paid", 300, "USD") == "credited"
    assert limit(emp, ws) == BASE + GB
    # Повторное уведомление о том же платеже не начисляет второй раз.
    assert service("storage_order_settle", "paypal", P("A"), "paid", 300, "USD") == "duplicate"
    assert limit(emp, ws) == BASE + GB

    # Второй пакет складывается с первым.
    bought(owner, ws, "gb5", P("B"))
    assert service("storage_order_settle", "paypal", P("B"), "paid", 1000, "USD") == "credited"
    assert limit(owner, ws) == BASE + 6 * GB

    statuses = {r[0]: r[1] for r in q(owner, "select provider_payment_id, status from public.storage_orders where workspace_id = %s", (ws,))}
    assert statuses == {P("A"): "paid", P("B"): "paid"}


def test_employee_and_outsider_cannot_buy_or_see_payments():
    owner, emp, out = users(3)
    ws = workspace_with(owner, {emp: "employee"})
    denied("42501", rpc, emp, "storage_order_create", p_workspace=ws, p_pack="gb1")
    denied("42501", rpc, out, "storage_order_create", p_workspace=ws, p_pack="gb1")
    bought(owner, ws)
    assert q(emp, "select id from public.storage_orders where workspace_id = %s", (ws,)) == []
    assert q(out, "select id from public.storage_orders") == []


def test_clients_cannot_credit_space_themselves():
    owner = users(1)[0]
    ws = workspace_with(owner)
    o = bought(owner, ws)
    denied("42501", rpc, owner, "storage_order_settle", p_provider="paypal", p_payment_id=P("1"), p_status="paid",
           p_amount_minor=300, p_currency="USD")
    denied("42501", rpc, owner, "storage_order_bind", p_order=o["id"], p_provider="paypal", p_payment_id=P("X"))
    denied("42501", one, owner, "update public.storage_orders set status = 'paid' where id = %s returning 1", (o["id"],))
    denied("42501", one, owner, "insert into public.storage_packs (id, bytes, price_minor, currency) values ('free', 1, 1, 'USD') returning 1")
    assert limit(owner, ws) == BASE


def test_wrong_amount_or_currency_is_rejected():
    owner = users(1)[0]
    ws = workspace_with(owner)
    bought(owner, ws)
    for amount, cur in [(1, "USD"), (300, "EUR"), (None, None)]:
        with pytest.raises(psycopg.Error) as e:
            service("storage_order_settle", "paypal", P("1"), "paid", amount, cur)
        assert e.value.sqlstate == "22023"
    assert limit(owner, ws) == BASE
    assert service("storage_order_settle", "paypal", P("unknown"), "paid", 300, "USD") == "unknown"


def test_price_change_does_not_touch_open_orders():
    owner = users(1)[0]
    ws = workspace_with(owner)
    bought(owner, ws)
    with db() as c:
        c.execute("update public.storage_packs set price_minor = 500 where id = 'gb1'")
    try:
        assert service("storage_order_settle", "paypal", P("1"), "paid", 300, "USD") == "credited"
    finally:
        with db() as c:
            c.execute("update public.storage_packs set price_minor = 300 where id = 'gb1'")


def test_cancel_and_refund():
    owner = users(1)[0]
    ws = workspace_with(owner)
    bought(owner, ws, payment=P("C"))
    assert service("storage_order_settle", "paypal", P("C"), "canceled", None, None) == "canceled"
    assert service("storage_order_settle", "paypal", P("C"), "paid", 300, "USD") == "ignored"
    assert limit(owner, ws) == BASE

    bought(owner, ws, payment=P("R"))
    assert service("storage_order_settle", "paypal", P("R"), "refunded", 300, "USD") == "ignored", "возврат до оплаты"
    assert service("storage_order_settle", "paypal", P("R"), "paid", 300, "USD") == "credited"
    assert service("storage_order_settle", "paypal", P("R"), "refunded", 300, "USD") == "debited"
    assert service("storage_order_settle", "paypal", P("R"), "refunded", 300, "USD") == "duplicate"
    assert limit(owner, ws) == BASE


def test_bind_once_and_unknown_or_hidden_pack():
    owner = users(1)[0]
    ws = workspace_with(owner)
    o = bought(owner, ws, payment=P("1"))
    with pytest.raises(psycopg.Error) as e:
        service("storage_order_bind", o["id"], "paypal", P("2"))
    assert e.value.sqlstate == "22023"
    denied("22023", rpc, owner, "storage_order_create", p_workspace=ws, p_pack="gb999")
    with db() as c:
        c.execute("update public.storage_packs set active = false where id = 'gb5'")
    try:
        denied("22023", rpc, owner, "storage_order_create", p_workspace=ws, p_pack="gb5")
        assert [r[0] for r in q(owner, "select id from public.storage_packs order by sort")] == ["gb1"]
    finally:
        with db() as c:
            c.execute("update public.storage_packs set active = true where id = 'gb5'")


def test_pending_orders_are_rate_limited():
    owner = users(1)[0]
    ws = workspace_with(owner)
    for _ in range(10):
        rpc(owner, "storage_order_create", p_workspace=ws, p_pack="gb1")
    denied("54000", rpc, owner, "storage_order_create", p_workspace=ws, p_pack="gb1")


def test_payment_journal_survives_workspace_deletion():
    owner = users(1)[0]
    ws = workspace_with(owner)
    o = bought(owner, ws)
    service("storage_order_settle", "paypal", P("1"), "paid", 300, "USD")
    with db() as c:
        c.execute("delete from public.workspaces where id = %s", (ws,))
        row = c.execute("select workspace_id, status from public.storage_orders where id = %s", (o["id"],)).fetchone()
    assert row == (None, "paid")
