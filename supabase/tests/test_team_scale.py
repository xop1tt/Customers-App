"""Масштаб на команду (ADR-097): толчок Realtime об изменениях CRM, содержимое вложений по видимости карточки,
индексы на все внешние ключи."""

import base64

from conftest import db
from crm_helpers import denied, one, rpc, users, workspace_with
from test_chat_live import clear, realtime_stub, sent  # noqa: F401 (фикстура)
from test_crm import T1, op, push, push1


def online(ws, *uids):
    with db() as c:
        for u in uids:
            c.execute("insert into public.workspace_presence (workspace_id, user_id, seen_at) values (%s, %s, now()) "
                      "on conflict (workspace_id, user_id) do update set seen_at = now()", (ws, u))


def crm_pokes() -> list[tuple[str, dict]]:
    return [(t, p) for t, e, p in sent() if e == "crm"]


def test_crm_change_nudges_colleagues_online_once_per_push(realtime_stub):
    a, b, c, away = users(4)
    ws = workspace_with(a, {b: "employee", c: "employee", away: "employee"})
    online(ws, a, b, c)
    clear()
    push(a, ws, op("companies", name="Первая"), op("companies", name="Вторая"), op("contacts", first_name="Иван"))
    pokes = crm_pokes()
    assert sorted(t for t, _ in pokes) == sorted([f"user:{b}", f"user:{c}"]), "один толчок на выгрузку, без автора и тех, кто не в сети"
    assert all(p == {"workspace_id": str(ws)} for _, p in pokes), "в толчке нет содержимого"

    # Отклонённое изменение коллегам не интересно.
    clear()
    r = push1(b, ws, op("companies", name=""))
    assert r["status"] == "rejected" and crm_pokes() == []

    # Удалённый из Workspace больше не получает толчков, даже если его присутствие ещё не устарело.
    with db() as cn:
        cn.execute("update public.workspace_members set status = 'removed' where workspace_id = %s and user_id = %s", (ws, c))
    clear()
    push(a, ws, op("companies", name="Третья"))
    assert [t for t, _ in crm_pokes()] == [f"user:{b}"]


def test_realtime_failure_never_breaks_crm_push(realtime_stub):
    a, b = users(2)
    ws = workspace_with(a, {b: "employee"})
    online(ws, b)
    with db() as c:
        c.execute("create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) "
                  "returns void language plpgsql as $f$ begin raise exception 'realtime down'; end $f$")
    assert push1(a, ws, op("companies", name="Всё равно сохраняется"))["status"] == "applied"


def _attach(uid, ws, company):
    att = op("attachments", entity_type="company", entity_id=company, name="договор.pdf", mime="application/pdf", size=3)
    assert push1(uid, ws, att)["status"] == "applied"
    data = base64.b64encode(b"pdf").decode()
    one(uid, "insert into public.attachment_blobs (attachment_id, workspace_id, data) values (%s, %s, %s) returning 1",
        (att["id"], ws, data))
    return att["id"]


def test_attachment_content_follows_card_visibility():
    owner, a, b = users(3)
    ws = workspace_with(owner, {a: "employee", b: "employee"})
    sales = str(rpc(owner, "save_department", p_workspace=ws, p_id=None, p_name="Продажи", p_parent=None, p_head=None))
    mkt = str(rpc(owner, "save_department", p_workspace=ws, p_id=None, p_name="Маркетинг", p_parent=None, p_head=None))
    rpc(owner, "set_member_department", p_workspace=ws, p_user=a, p_department=sales)
    rpc(owner, "set_member_department", p_workspace=ws, p_user=b, p_department=mkt)
    company = op("companies", name="Клиент продаж", owner_id=a)
    push1(a, ws, company)
    att = _attach(a, ws, company["id"])
    blob = "select count(*) from public.attachment_blobs where attachment_id = %s"
    assert one(b, blob, (att,)) == 1, "по умолчанию роль видит всё"
    rpc(owner, "set_role_scope", p_workspace=ws, p_key="employee", p_scope="department")
    assert one(a, blob, (att,)) == 1
    assert one(b, blob, (att,)) == 0, "файл чужого отдела не скачать даже по id"


def test_attachment_content_goes_only_to_its_workspace():
    a = users(1)[0]
    ws = workspace_with(a)
    other = workspace_with(a)
    company = op("companies", name="Клиент")
    push1(a, ws, company)
    att = op("attachments", entity_type="company", entity_id=company["id"], name="x.txt", mime="text/plain", size=1)
    push1(a, ws, att)
    denied("42501", one, a, "insert into public.attachment_blobs (attachment_id, workspace_id, data) values (%s, %s, 'eA==') returning 1",
           (att["id"], other))


def test_every_foreign_key_has_an_index():
    with db() as c:
        missing = c.execute("""
            select c.conrelid::regclass::text || ' ' || c.conname
            from pg_constraint c join pg_namespace n on n.oid = c.connamespace
            where c.contype = 'f' and n.nspname = 'public'
              and not exists (select 1 from pg_index i where i.indrelid = c.conrelid
                              and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
                              and c.conkey @> (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1])
            order by 1""").fetchall()
    assert missing == [], "внешний ключ без индекса: удаление и выборки по нему читают таблицу целиком"


def test_nudge_function_is_not_callable_by_clients():
    with db() as c:
        for role in ("anon", "authenticated"):
            assert c.execute("select has_function_privilege(%s, 'private.crm_live_nudge()', 'execute')", (role,)).fetchone()[0] is False


MB5 = 5 * 1024 * 1024


def _blob(uid, ws, att_id, data="eA=="):
    return one(uid, "insert into public.attachment_blobs (attachment_id, workspace_id, data) values (%s, %s, %s) returning 1",
               (att_id, ws, data))


def test_attachment_space_is_300_mb_per_workspace_plus_bought_extra():
    a = users(1)[0]
    ws = workspace_with(a)
    company = op("companies", name="Клиент")
    push1(a, ws, company)
    atts = [op("attachments", entity_type="company", entity_id=company["id"], name=f"f{i}.bin", size=MB5) for i in range(61)]
    assert all(r["status"] == "applied" for r in push(a, ws, *atts))
    for att in atts[:60]:
        _blob(a, ws, att["id"])
    assert rpc(a, "attachment_usage", p_workspace=ws) == {"used": 60 * MB5, "limit": 300 * 1024 * 1024}
    denied("53400", _blob, a, ws, atts[60]["id"])

    # Удалённое в корзину вложение освобождает место сразу.
    push1(a, ws, op("attachments", atts[0]["id"], kind="delete", ts=T1))
    _blob(a, ws, atts[60]["id"])

    # Докупленное место (пишет только сервер) увеличивает предел.
    with db() as c:
        c.execute("insert into private.attachment_quota (workspace_id, extra_bytes) values (%s, %s)", (ws, MB5))
    assert rpc(a, "attachment_usage", p_workspace=ws)["limit"] == 300 * 1024 * 1024 + MB5
    more = op("attachments", entity_type="company", entity_id=company["id"], name="ещё.bin", size=MB5)
    push1(a, ws, more)
    _blob(a, ws, more["id"])


def test_attachment_content_cannot_exceed_its_declared_size():
    a = users(1)[0]
    ws = workspace_with(a)
    company = op("companies", name="Клиент")
    push1(a, ws, company)
    att = op("attachments", entity_type="company", entity_id=company["id"], name="мал.txt", size=1)
    push1(a, ws, att)
    denied("22023", _blob, a, ws, att["id"], base64.b64encode(b"x" * 300).decode())


def test_attachment_usage_and_quota_are_closed_to_outsiders():
    a, out = users(2)
    ws = workspace_with(a)
    denied("42501", rpc, out, "attachment_usage", p_workspace=ws)
    with db() as c:
        assert c.execute("select has_table_privilege('authenticated', 'private.attachment_quota', 'select')").fetchone()[0] is False
        assert c.execute("select has_function_privilege('anon', 'public.attachment_usage(uuid)', 'execute')").fetchone()[0] is False
