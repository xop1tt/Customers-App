"""Права команды (аудит 2026-11-21, ADR-094): роли не переписываются снизу, «свои записи» — ответственный и
исполнитель, передача записи и задачи коллеге, свои поля и контакты сделки по правам карточки, журнал звонков
не стирает автор, уведомления о назначении, удалённая учётная запись перестаёт быть ответственным."""

import uuid

from conftest import db
from test_crm import T1, T2, op, push1, row, stages

T3 = "2026-11-01T13:00:00Z"
from crm_helpers import denied, email_of, one, q, rpc, users, workspace_with

ALL_HR = ["members.view", "members.manage", "roles.manage", "records.view"]


def notes_of(uid: str, ws) -> list[tuple]:
    with db() as c:
        return c.execute("""select kind, actor_id::text, entity_type, entity_id::text, excerpt from public.notifications
                            where user_id = %s and workspace_id = %s order by seq""", (uid, ws)).fetchall()


# ------------------------------------------------------------------ роли

def test_role_manager_cannot_rewrite_a_role_at_or_above_their_own():
    owner, director, hr = users(3)
    ws = workspace_with(owner)
    rpc(owner, "save_role", p_workspace=ws, p_key="director", p_name="Директор", p_rank=90,
        p_permissions=["records.view", "records.edit", "members.view"])
    rpc(owner, "save_role", p_workspace=ws, p_key="hr", p_name="Кадры", p_rank=50, p_permissions=ALL_HR)
    rpc(owner, "save_role", p_workspace=ws, p_key="intern", p_name="Стажёр", p_rank=10, p_permissions=["records.view"])
    for user, role in ((director, "director"), (hr, "hr")):
        inv = rpc(owner, "invite_member", p_workspace=ws, p_email=email_of(user), p_role=role)
        assert rpc(user, "accept_invitation", p_token=inv["token"]) == ws

    # Раньше «Кадры» (50) переписывали «Директора» (90) в ранг 10 и затем удаляли директора.
    denied("42501", rpc, hr, "save_role", p_workspace=ws, p_key="director", p_name="Директор", p_rank=10,
           p_permissions=["records.view"])
    # Свою роль тоже не расширить и не переименовать.
    denied("42501", rpc, hr, "save_role", p_workspace=ws, p_key="hr", p_name="Кадры+", p_rank=40, p_permissions=ALL_HR)
    with db() as c:
        assert c.execute("select rank from public.roles where workspace_id = %s and key = 'director'", (ws,)).fetchone()[0] == 90
    denied("42501", rpc, hr, "remove_member", p_workspace=ws, p_user=director)
    # Роль ниже своей и не свою — можно, и это попадает в журнал.
    rpc(hr, "save_role", p_workspace=ws, p_key="intern", p_name="Стажёр", p_rank=20, p_permissions=["records.view"])
    with db() as c:
        acts = c.execute("select action from public.audit_log where workspace_id = %s and entity_type = 'role' order by id",
                         (ws,)).fetchall()
    assert [a[0] for a in acts] == ["role_create", "role_create", "role_create", "role_update"]
    # Владелец может менять любую роль.
    rpc(owner, "save_role", p_workspace=ws, p_key="director", p_name="Директор", p_rank=85,
        p_permissions=["records.view", "records.edit"])


# ------------------------------------------------------------------ свои записи и передача

def test_author_loses_edit_rights_once_the_record_has_another_owner():
    owner, a, b = users(3)
    ws = workspace_with(owner, {a: "employee", b: "employee"})
    c = op("companies", name="Ромашка")
    assert push1(a, ws, c)["status"] == "applied"
    # Пока ответственного нет, автор может менять свою запись.
    assert push1(a, ws, op("companies", c["id"], ts=T1, name="Ромашка 2"))["status"] == "applied"
    push1(owner, ws, op("companies", c["id"], ts=T1, owner_id=b))
    r = push1(a, ws, op("companies", c["id"], ts=T2, name="Вернул себе"))
    assert r["status"] == "rejected" and r["code"] == "42501"
    assert push1(b, ws, op("companies", c["id"], ts=T2, name="Ромашка Б"))["status"] == "applied"


def test_owner_and_assignee_can_hand_over_records_and_tasks():
    owner, a, b = users(3)
    ws = workspace_with(owner, {a: "employee", b: "employee"})
    c = op("companies", name="Передача", owner_id=a)
    push1(a, ws, c)
    # Ответственный передаёт клиента коллеге и после этого больше не может его менять.
    assert push1(a, ws, op("companies", c["id"], ts=T1, owner_id=b))["status"] == "applied"
    assert row(owner, "companies", c["id"])["owner_id"] == b
    assert push1(a, ws, op("companies", c["id"], ts=T2, name="x"))["code"] == "42501"

    t = op("tasks", title="Позвонить", assignee_id=a)
    push1(owner, ws, t)
    assert push1(a, ws, op("tasks", t["id"], ts=T1, assignee_id=b))["status"] == "applied"
    assert row(owner, "tasks", t["id"])["assignee_id"] == b
    # Наблюдатель не может «передать» запись: у него нет права правки вообще.
    viewer = users(1)[0]
    inv = rpc(owner, "invite_member", p_workspace=ws, p_email=email_of(viewer), p_role="viewer")
    rpc(viewer, "accept_invitation", p_token=inv["token"])
    assert push1(viewer, ws, op("tasks", t["id"], ts=T2, assignee_id=viewer))["code"] == "42501"


def test_custom_field_values_and_deal_contacts_follow_the_parent_card():
    owner, a, b = users(3)
    ws = workspace_with(owner, {a: "employee", b: "employee"})
    field = op("custom_fields", entity_type="company", label="Отрасль")
    assert push1(owner, ws, field)["status"] == "applied"
    mine = op("companies", name="Моя", owner_id=a)
    push1(a, ws, mine)
    # Чужой сотрудник не пишет значение поля в чужую карточку.
    r = push1(b, ws, op("custom_field_values", field_id=field["id"], entity_type="company", entity_id=mine["id"], value="IT"))
    assert r["status"] == "rejected" and r["code"] == "42501"
    v = op("custom_field_values", field_id=field["id"], entity_type="company", entity_id=mine["id"], value="IT")
    assert push1(a, ws, v)["status"] == "applied"
    # Ответственный меняет значение, созданное другим (руководителем).
    v2 = op("custom_field_values", field_id=field["id"], entity_type="company", entity_id=str(uuid.uuid4()), value="x")
    assert push1(owner, ws, v2)["status"] == "rejected"  # нет такой карточки
    push1(owner, ws, op("custom_field_values", v["id"], ts=T1, value="Банки"))
    assert push1(a, ws, op("custom_field_values", v["id"], ts=T2, value="Ритейл"))["status"] == "applied"
    assert push1(b, ws, op("custom_field_values", v["id"], ts=T3, value="Взлом"))["code"] == "42501"

    st = stages(owner, ws)["Новый лид"]
    deal = op("deals", title="Поставка", owner_id=a, pipeline_id=st["pipeline_id"], stage_id=st["id"])
    push1(a, ws, deal)
    contact = op("contacts", first_name="Ирина", owner_id=b)
    push1(b, ws, contact)
    link = op("deal_contacts", deal_id=deal["id"], contact_id=contact["id"], role="ЛПР")
    assert push1(b, ws, link)["code"] == "42501"
    assert push1(a, ws, link | {"op_id": str(uuid.uuid4())})["status"] == "applied"


def test_activity_log_is_deleted_only_with_records_delete():
    owner, a = users(2)
    ws = workspace_with(owner, {a: "employee"})
    c = op("companies", name="Звонки", owner_id=a)
    push1(a, ws, c)
    call = op("activities", entity_type="company", entity_id=c["id"], type="call", summary="Не дозвонился")
    assert push1(a, ws, call)["status"] == "applied"
    assert push1(a, ws, op("activities", call["id"], kind="delete", ts=T1))["code"] == "42501"
    note = op("notes", entity_type="company", entity_id=c["id"], body="черновик")
    push1(a, ws, note)
    assert push1(a, ws, op("notes", note["id"], kind="delete", ts=T1))["status"] == "applied"
    assert push1(owner, ws, op("activities", call["id"], kind="delete", ts=T2))["status"] == "applied"


def test_conflicts_of_personal_collections_are_private():
    owner, a, b = users(3)
    ws = workspace_with(owner, {a: "employee", b: "employee"})
    col = op("collections", name="Мои горячие", entity_type="company", visibility="private")
    assert push1(a, ws, col)["status"] == "applied"
    assert push1(a, ws, op("collections", col["id"], ts=T2, base=1, name="Мои горячие 2"))["status"] == "applied"
    assert push1(a, ws, op("collections", col["id"], ts=T1, base=1, name="старое имя"))["status"] == "conflict"
    seen = lambda u: one(u, "select count(*) from public.sync_conflicts where entity_id = %s", (col["id"],))  # noqa: E731
    assert seen(a) >= 1
    assert seen(b) == 0


def test_busy_record_id_is_reported_without_constraint_details():
    a, b = users(2)
    ws_a = rpc(a, "ensure_personal_workspace")
    ws_b = rpc(b, "ensure_personal_workspace")
    c = op("companies", name="Первый")
    push1(a, ws_a, c)
    r = push1(b, ws_b, op("companies", c["id"], name="Второй"))
    assert r["status"] == "rejected" and r["code"] == "23505"
    assert "pkey" not in r["error"] and "companies" not in r["error"]


# ------------------------------------------------------------------ уведомления

def test_assignment_notifications_go_to_the_new_assignee_only():
    owner, a, b = users(3)
    ws = workspace_with(owner, {a: "employee", b: "employee"})
    c = op("companies", name="ООО Вектор")
    push1(owner, ws, c)
    t = op("tasks", title="Подготовить КП", assignee_id=a, entity_type="company", entity_id=c["id"])
    push1(owner, ws, t)
    assert notes_of(a, ws) == [("task_assigned", owner, "company", c["id"], "Подготовить КП")]
    # Себе — без уведомления; повторное сохранение без смены исполнителя — тоже.
    push1(a, ws, op("tasks", t["id"], ts=T1, title="Подготовить КП v2"))
    push1(a, ws, op("tasks", t["id"], ts=T2, assignee_id=b))
    assert [n[0] for n in notes_of(a, ws)] == ["task_assigned"]
    assert notes_of(b, ws) == [("task_assigned", a, "company", c["id"], "Подготовить КП v2")]
    mine = op("tasks", title="Себе", assignee_id=b)
    push1(b, ws, mine)
    assert len(notes_of(b, ws)) == 1

    push1(owner, ws, op("companies", c["id"], ts=T1, owner_id=a))
    st = stages(owner, ws)["Новый лид"]
    d = op("deals", title="Поставка 2027", owner_id=b, pipeline_id=st["pipeline_id"], stage_id=st["id"])
    push1(owner, ws, d)
    assert notes_of(a, ws)[-1] == ("record_assigned", owner, "company", c["id"], "ООО Вектор")
    assert notes_of(b, ws)[-1] == ("record_assigned", owner, "deal", d["id"], "Поставка 2027")
    contact = op("contacts", first_name="Ирина", last_name="Котова", owner_id=a)
    push1(owner, ws, contact)
    assert notes_of(a, ws)[-1][0::4] == ("record_assigned", "Ирина Котова")


def test_deleted_account_stops_owning_records():
    owner, a = users(2)
    ws = workspace_with(owner, {a: "employee"})
    c = op("companies", name="Сирота", owner_id=a)
    push1(a, ws, c)
    t = op("tasks", title="Дело", assignee_id=a)
    push1(owner, ws, t)
    seq = row(owner, "companies", c["id"])["server_seq"]
    with db() as cn:
        cn.execute("delete from auth.users where id = %s", (a,))
    got = row(owner, "companies", c["id"])
    assert got["owner_id"] is None and got["server_seq"] > seq, "устройства должны получить изменение при синхронизации"
    assert row(owner, "tasks", t["id"])["assignee_id"] is None
    assert q(owner, "select 1 from public.workspace_members where workspace_id = %s and user_id = %s", (ws, a)) == []


# ------------------------------------------------------------------ экспорт

def test_export_needs_records_export_and_lands_in_the_audit_log():
    owner, emp = users(2)
    ws = workspace_with(owner, {emp: "employee"})
    denied("42501", rpc, emp, "log_export", p_workspace=ws, p_entity="companies", p_count=10, p_format="csv")
    denied("22023", rpc, owner, "log_export", p_workspace=ws, p_entity="pipelines", p_count=1, p_format="csv")
    denied("22023", rpc, owner, "log_export", p_workspace=ws, p_entity="companies", p_count=1, p_format="pdf")
    rpc(owner, "log_export", p_workspace=ws, p_entity="deals", p_count=42, p_format="xlsx")
    got = q(owner, "select actor_id::text, entity_type, details from public.audit_log where workspace_id = %s and action = 'export'", (ws,))
    assert got == [(owner, "deals", {"count": 42, "format": "xlsx"})]
