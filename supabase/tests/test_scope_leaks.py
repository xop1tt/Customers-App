"""Видимость по области роли и отделу (ADR-096) не обходится через журнал конфликтов и карточки в чате
(миграция 20261122140000_scope_leak_fixes.sql, ADR-099)."""

from __future__ import annotations

import json

from test_crm import T0, T1, op, push1, row
from test_departments import dept
from crm_helpers import denied, one, q, rpc, users, workspace_with


def post(uid: str, conv: str, body: str, attachments: list):
    return one(uid, """select public.chat_post(p_conversation => %s, p_body => %s, p_mentions => '{}'::uuid[],
                                              p_attachments => %s::jsonb)""", (conv, body, json.dumps(attachments)))


def scoped_workspace():
    """Workspace, где сотрудники видят только свой отдел: a — «Продажи», b — «Маркетинг»."""
    owner, a, b = users(3)
    ws = workspace_with(owner, {a: "employee", b: "employee"})
    sales, mkt = dept(owner, ws, "Продажи"), dept(owner, ws, "Маркетинг")
    rpc(owner, "set_member_department", p_workspace=ws, p_user=a, p_department=sales)
    rpc(owner, "set_member_department", p_workspace=ws, p_user=b, p_department=mkt)
    rpc(owner, "set_role_scope", p_workspace=ws, p_key="employee", p_scope="department")
    secret = op("companies", name="Тендер маркетинга", legal_name="ООО «Секрет»", ts=T0, owner_id=b)
    assert push1(b, ws, secret)["status"] == "applied"
    assert row(a, "companies", secret["id"]) is None and row(b, "companies", secret["id"]) is not None
    return owner, a, b, ws, secret["id"]


def test_conflict_log_of_hidden_record_is_not_readable():
    owner, a, b, ws, deal = scoped_workspace()
    assert push1(b, ws, op("companies", deal, ts=T1, base=1, name="Тендер маркетинга (итог)"))["status"] == "applied"
    # Устаревшая правка того же поля уходит в журнал конфликтов со старым и новым значением.
    assert push1(owner, ws, op("companies", deal, ts=T0, base=1, name="Черновик"))["status"] == "conflict"
    sql = "select kept, lost from public.sync_conflicts where entity_id = %s"
    assert q(b, sql, (deal,)) == [("Тендер маркетинга (итог)", "Черновик")]
    assert q(owner, sql, (deal,)) == [("Тендер маркетинга (итог)", "Черновик")]
    assert q(a, sql, (deal,)) == [], "сотрудник другого отдела не видит поля скрытой записи"
    assert one(a, "select count(*) from public.sync_conflicts where workspace_id = %s", (ws,)) == 0
    # Неизвестная таблица в журнале не открывает ничего.
    assert one(a, "select private.row_visible('auth.users', %s)", (a,)) is False


def test_chat_cards_follow_record_visibility():
    owner, a, b, ws, deal = scoped_workspace()
    conv = one(owner, "select public.chat_create_group(%s, 'Все', %s::uuid[])", (ws, [a, b]))["id"]
    post(owner, conv, "Смотрите", [{"type": "company", "id": deal}])
    card = lambda uid: rpc(uid, "chat_messages", p_conversation=conv)["messages"][-1]["attachments"][0]  # noqa: E731
    assert card(b)["available"] is True and card(b)["title"] == "Тендер маркетинга"
    assert card(a) == {"type": "company", "id": deal, "title": "", "subtitle": "", "available": False}
    # Прикрепить скрытую запись нельзя, и ответ тот же, что для несуществующей.
    denied("23503", post, a, conv, "угадал id", [{"type": "company", "id": deal}])
    assert card(a)["available"] is False
