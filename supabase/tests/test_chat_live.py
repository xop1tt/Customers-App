"""Чат: карточки CRM во вложениях и Realtime (миграция 20261111090000_chat_live_attachments.sql).

Realtime на локальном стенде нет, поэтому здесь его заменяет заглушка схемы `realtime` с тем же интерфейсом
(`realtime.send`, `realtime.topic()`, таблица `realtime.messages`), а миграция применяется к ней повторно.
Так проверяется ровно то, что делает наш SQL: кому и что уходит в канал и кто может в канал войти."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from conftest import db
from crm_helpers import acting, denied, one, q, rpc, users, workspace_with

MIGRATION = Path(__file__).resolve().parents[1] / "migrations" / "20261111090000_chat_live_attachments.sql"


def post(uid: str, conv: str, body: str = "", attachments: list | None = None, mentions: list | None = None):
    return one(uid, """select public.chat_post(p_conversation => %s, p_body => %s, p_mentions => %s::uuid[],
                                              p_attachments => %s::jsonb)""",
               (conv, body, mentions or [], json.dumps(attachments or [])))


def records(uid: str, ws: str) -> dict[str, str]:
    """По одной карточке каждого типа, как их записывает приложение."""
    ids = {k: str(uuid.uuid4()) for k in ("company", "contact", "crm_lead")}
    ts = "2026-11-11T10:00:00Z"

    def op(entity, rid, **fields):
        return {"op_id": str(uuid.uuid4()), "entity": entity, "id": rid, "kind": "upsert", "fields": fields,
                "ts": {k: ts for k in fields}, "base_version": 0}

    ops = [op("companies", ids["company"], name="ООО Зерно", legal_name="ООО «Зерно»"),
           op("contacts", ids["contact"], first_name="Анна", last_name="Ли", position="Закупки", company_id=ids["company"]),
           op("crm_leads", ids["crm_lead"], title="Поставка муки", person_name="Анна", company_name="Зерно")]
    res = rpc(uid, "crm_push", p_workspace=ws, p_device="dev-test", p_ops=ops)
    assert all(r["status"] in ("applied", "merged") for r in res["results"]), res
    return ids


# ------------------------------------------------------------------ вложения

def test_message_with_cards_shows_titles_to_members_who_may_view():
    a, b = users(2)
    ws = workspace_with(a, {b: "employee"})
    ids = records(a, ws)
    conv = rpc(a, "chat_open_direct", p_workspace=ws, p_user=b)["id"]
    m = post(a, conv, "Посмотри", [{"type": "company", "id": ids["company"]}, {"type": "contact", "id": ids["contact"]},
                                   {"type": "crm_lead", "id": ids["crm_lead"]}, {"type": "company", "id": ids["company"]}])
    assert [x["type"] for x in m["attachments"]] == ["company", "contact", "crm_lead"], "повтор убран"
    got = rpc(b, "chat_messages", p_conversation=conv)["messages"][-1]["attachments"]
    assert [(x["title"], x["subtitle"], x["available"]) for x in got] == [
        ("ООО Зерно", "ООО «Зерно»", True), ("Анна Ли", "Закупки · ООО Зерно", True), ("Поставка муки", "Анна · Зерно", True)]
    # Только карточки, без текста.
    only = post(b, conv, "", [{"type": "crm_lead", "id": ids["crm_lead"]}])
    assert only["body"] == "" and only["attachments"][0]["title"] == "Поставка муки"
    denied("22023", post, a, conv, "   ", [])


def test_cards_are_checked_against_workspace_type_and_limit():
    a, b, other = users(3)
    ws = workspace_with(a, {b: "employee"})
    foreign_ws = workspace_with(other, {})
    foreign = records(other, foreign_ws)
    mine = records(a, ws)
    conv = rpc(a, "chat_open_direct", p_workspace=ws, p_user=b)["id"]
    denied("23503", post, a, conv, "чужое", [{"type": "company", "id": foreign["company"]}])
    denied("23503", post, a, conv, "нет такой", [{"type": "company", "id": str(uuid.uuid4())}])
    denied("23503", post, a, conv, "тип не тот", [{"type": "contact", "id": mine["company"]}])
    denied("22023", post, a, conv, "тип", [{"type": "leads", "id": mine["company"]}])
    denied("22023", post, a, conv, "id", [{"type": "company", "id": "1; drop table x"}])
    denied("22023", post, a, conv, "много", [{"type": "company", "id": mine["company"]}] * 11)
    denied("22023", one, a, "select public.chat_post(%s, 'x', '{}'::uuid[], '{\"type\":\"company\"}'::jsonb)", (conv,))


def test_card_title_hidden_without_view_right_and_after_delete():
    a, viewer_less = users(2)
    ws = workspace_with(a, {viewer_less: "employee"})
    ids = records(a, ws)
    conv = rpc(a, "chat_open_direct", p_workspace=ws, p_user=viewer_less)["id"]
    post(a, conv, "Карточка", [{"type": "company", "id": ids["company"]}])
    # Роль без просмотра записей: в Workspace-ролях это делается своей ролью без records.view.
    with db() as c:
        role = c.execute("""insert into public.roles (workspace_id, key, name, rank) values (%s, 'chat_only', 'Только чат', 5)
                            returning id""", (ws,)).fetchone()[0]
        c.execute("insert into public.role_permissions (role_id, permission_key) values (%s, 'members.view')", (role,))
        c.execute("update public.workspace_members set role_id = %s where workspace_id = %s and user_id = %s", (role, ws, viewer_less))
    hidden = rpc(viewer_less, "chat_messages", p_conversation=conv)["messages"][-1]["attachments"][0]
    assert hidden == {"type": "company", "id": ids["company"], "title": "", "subtitle": "", "available": False}
    denied("42501", post, viewer_less, conv, "моя", [{"type": "company", "id": ids["company"]}])
    # Карточку удалили — у всех «недоступна».
    with db() as c:
        c.execute("update public.companies set deleted_at = now() where id = %s", (ids["company"],))
    gone = rpc(a, "chat_messages", p_conversation=conv)["messages"][-1]["attachments"][0]
    assert gone["available"] is False and gone["title"] == ""


def test_edit_keeps_cards_and_delete_forgets_them():
    a, b = users(2)
    ws = workspace_with(a, {b: "employee"})
    ids = records(a, ws)
    conv = rpc(a, "chat_open_direct", p_workspace=ws, p_user=b)["id"]
    m = post(a, conv, "", [{"type": "company", "id": ids["company"]}])
    assert rpc(a, "chat_edit", p_message=m["id"], p_body="С подписью")["attachments"][0]["available"] is True
    assert rpc(a, "chat_edit", p_message=m["id"], p_body="")["body"] == "", "без текста можно: карточка осталась"
    rpc(a, "chat_delete", p_message=m["id"])
    gone = next(x for x in rpc(b, "chat_messages", p_conversation=conv)["messages"] if x["id"] == m["id"])
    assert gone["deleted"] is True and gone["attachments"] == []
    with db() as c:
        assert c.execute("select attachments from public.chat_messages where id = %s", (m["id"],)).fetchone()[0] == []


def test_chat_post_mentions_and_rate_limit_like_chat_send():
    a, b, c = users(3)
    ws = workspace_with(a, {b: "employee", c: "employee"})
    g = one(a, "select public.chat_create_group(%s, 'Сделка', %s::uuid[])", (ws, [b, c]))["id"]
    post(a, g, "Вопрос", mentions=[b])
    kinds = lambda u: sorted(n["kind"] for n in rpc(u, "chat_poll", p_workspace=ws)["notifications"])  # noqa: E731
    assert kinds(b) == ["added_to_group", "mention"]
    assert kinds(c) == ["added_to_group"], "не упомянут — уведомления об упоминании нет"
    # 30 в минуту, считая системное «создаёт обсуждение» и «Вопрос» выше.
    for i in range(28):
        post(a, g, f"m{i}")
    denied("54000", post, a, g, "лишнее")


def test_chat_post_is_closed_to_anon_and_outsiders():
    a, b, out = users(3)
    ws = workspace_with(a, {b: "employee"})
    conv = rpc(a, "chat_open_direct", p_workspace=ws, p_user=b)["id"]
    denied("P0002", post, out, conv, "привет")
    with db() as c:
        assert c.execute("select has_function_privilege('anon', 'public.chat_post(uuid, text, uuid[], jsonb)', 'execute')").fetchone()[0] is False


# ------------------------------------------------------------------ Realtime

@pytest.fixture()
def realtime_stub():
    """Заглушка Supabase Realtime: send пишет в таблицу, topic() читает настройку, как в настоящем Realtime."""
    with db() as c:
        real = c.execute("select to_regclass('realtime.messages') is not null").fetchone()[0]
        if real and not c.execute("select to_regclass('realtime.test_sent') is not null").fetchone()[0]:
            pytest.fail("на стенде настоящий Realtime: этот тест рассчитан на заглушку")
        c.execute("""
            create schema if not exists realtime;
            create table if not exists realtime.messages (id bigserial primary key, topic text not null,
                extension text not null default 'broadcast', payload jsonb, event text, private boolean);
            create table if not exists realtime.test_sent (topic text, event text, payload jsonb, private boolean);
            create or replace function realtime.topic() returns text language sql stable
                as $f$ select nullif(current_setting('realtime.topic', true), '') $f$;
            create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
                returns void language sql as $f$ insert into realtime.test_sent values (topic, event, payload, private) $f$;
            alter table realtime.messages enable row level security;
            grant usage on schema realtime to authenticated;
            grant select on realtime.messages to authenticated;
            truncate realtime.test_sent;
        """)
        c.execute("set client_min_messages = warning")
        c.execute(MIGRATION.read_text())  # повторно: теперь со схемой realtime создаётся и политика канала
    yield
    with db() as c:
        c.execute("drop schema realtime cascade")


def sent() -> list[tuple[str, str, dict]]:
    with db() as c:
        return c.execute("select topic, event, payload from realtime.test_sent order by ctid").fetchall()


def clear() -> None:
    with db() as c:
        c.execute("truncate realtime.test_sent")


def test_realtime_pokes_every_participant_without_content(realtime_stub):
    a, b, c = users(3)
    ws = workspace_with(a, {b: "employee", c: "employee"})
    conv = rpc(a, "chat_open_direct", p_workspace=ws, p_user=b)["id"]
    clear()
    m = post(a, conv, "секретный текст")
    pokes = sent()
    assert sorted(t for t, _, _ in pokes) == sorted([f"user:{a}", f"user:{b}"]), "только участникам, автору — для других устройств"
    assert {e for _, e, _ in pokes} == {"chat"}
    assert pokes[0][2] == {"workspace_id": str(ws), "conversation_id": conv, "seq": m["seq"]}
    assert "секрет" not in json.dumps([p for _, _, p in pokes]), "текст в канал не уходит"
    with db() as cc:
        assert cc.execute("select bool_and(private) from realtime.test_sent").fetchone()[0] is True

    # Добавили в обсуждение — новый участник узнаёт сразу; упоминание приходит отдельным событием.
    g = one(a, "select public.chat_create_group(%s, 'Отдел', %s::uuid[])", (ws, [b]))["id"]
    clear()
    one(a, "select public.chat_add_members(%s, %s::uuid[])", (g, [c]))
    assert f"user:{c}" in {t for t, _, _ in sent()}
    clear()
    post(a, g, "вопрос", mentions=[c])
    assert (f"user:{c}", "notify") in {(t, e) for t, e, _ in sent()}


def test_realtime_failure_never_breaks_sending(realtime_stub):
    a, b = users(2)
    ws = workspace_with(a, {b: "employee"})
    conv = rpc(a, "chat_open_direct", p_workspace=ws, p_user=b)["id"]
    with db() as c:
        c.execute("""create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
                     returns void language plpgsql as $f$ begin raise exception 'realtime down'; end $f$""")
    assert post(a, conv, "всё равно дойдёт")["body"] == "всё равно дойдёт"


def test_only_own_user_channel_can_be_joined(realtime_stub):
    a, b = users(2)
    with db() as c:
        c.execute("insert into realtime.messages (topic, extension) values (%s, 'broadcast'), (%s, 'broadcast'), (%s, 'presence')",
                  (f"user:{a}", f"user:{b}", f"user:{a}"))

    def visible(uid: str, topic: str) -> int:
        with acting(uid) as c:
            c.execute("select set_config('realtime.topic', %s, true)", (topic,))
            # Так Realtime проверяет вход: читает строки канала под ролью и токеном пользователя.
            return c.execute("select count(*) from realtime.messages where topic = realtime.topic()").fetchone()[0]

    assert visible(a, f"user:{a}") == 1, "свой канал, только broadcast"
    assert visible(a, f"user:{b}") == 0, "чужой канал закрыт"
    assert visible(b, f"user:{b}") == 1


# ------------------------------------------------------------------ журнал

def test_moderation_is_written_to_the_audit_log_without_text():
    owner, admin, b = users(3)
    ws = workspace_with(owner, {admin: "admin", b: "employee"})
    g = one(owner, "select public.chat_create_group(%s, 'Отдел', %s::uuid[])", (ws, [admin, b]))["id"]
    m = post(b, g, "лишнее сообщение")
    own = post(b, g, "своё")
    rpc(admin, "chat_delete", p_message=m["id"])
    rpc(b, "chat_delete", p_message=own["id"])  # своё удаление в журнал не пишется
    one(owner, "select public.chat_remove_member(%s, %s)", (g, b))
    with db() as c:
        rows = c.execute("""select action, actor_id::text, entity_id::text, details from public.audit_log
                            where workspace_id = %s and action like 'chat.%%' order by id""", (ws,)).fetchall()
    assert [(r[0], r[1]) for r in rows] == [("chat.message_deleted", admin), ("chat.member_removed", owner)]
    assert rows[0][2] == m["id"] and rows[0][3]["author_id"] == b
    assert "лишнее" not in json.dumps([r[3] for r in rows])
