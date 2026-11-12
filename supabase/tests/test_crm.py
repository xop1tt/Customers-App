"""Customers 2.0, этапы 4–7 на сервере: записи CRM, выгрузка crm_push (идемпотентность, слияние по полям,
конфликты, надгробия), права по ролям, ссылки только внутри Workspace, сделки и история этапов, задачи,
коллекции. Документы: docs/CRM_ARCHITECTURE.md, docs/SYNC_ARCHITECTURE.md."""

import uuid

from conftest import confirmed_user, db
from crm_helpers import denied, make_user, one, q, rpc, users, workspace_with

T0 = "2026-11-01T10:00:00Z"
T1 = "2026-11-01T11:00:00Z"
T2 = "2026-11-01T12:00:00Z"


def op(entity: str, rid: str | None = None, kind: str = "upsert", ts: str = T0, base: int = 0, **fields) -> dict:
    return {"op_id": str(uuid.uuid4()), "entity": entity, "id": rid or str(uuid.uuid4()), "kind": kind,
            "fields": fields, "ts": {k: ts for k in fields} | ({"deleted_at": ts} if kind == "delete" else {}),
            "base_version": base}


def push(uid: str, ws, *ops: dict) -> list[dict]:
    res = rpc(uid, "crm_push", p_workspace=ws, p_device="dev-test", p_ops=list(ops))
    assert "server_time" in res
    return res["results"]


def push1(uid, ws, o: dict) -> dict:
    return push(uid, ws, o)[0]


def row(uid, table: str, rid: str) -> dict | None:
    rows = q(uid, f"select to_jsonb(t) from public.{table} t where id = %s", (rid,))
    return rows[0][0] if rows else None


def stages(uid, ws) -> dict[str, dict]:
    return {r[0]["name"]: r[0] for r in q(uid, "select to_jsonb(s) from public.pipeline_stages s where workspace_id = %s", (ws,))}


# ------------------------------------------------------------------ шаблон Workspace

def test_new_workspace_gets_pipeline_template_and_builtin_collections():
    u = make_user()
    ws = rpc(u, "ensure_personal_workspace")
    pipes = q(u, "select name, is_default from public.pipelines where workspace_id = %s", (ws,))
    assert pipes == [("Продажи", True)]
    st = q(u, "select name, kind, probability from public.pipeline_stages where workspace_id = %s order by position", (ws,))
    assert [s[0] for s in st] == ["Новый лид", "Первый контакт", "Переговоры", "Подготовка предложения", "Согласование",
                                  "Успешная сделка", "Проигранная сделка"]
    assert st[5][1:] == ("won", 100) and st[6][1:] == ("lost", 0)
    cols = q(u, "select builtin, entity_type, visibility from public.collections where workspace_id = %s order by position", (ws,))
    assert [c[0] for c in cols] == ["all_clients", "my_clients", "new_leads", "deals_this_week", "overdue_tasks",
                                    "won_deals", "lost_deals"]
    assert all(c[2] == "workspace" for c in cols)


# ------------------------------------------------------------------ выгрузка и видимость

def test_push_creates_record_visible_to_members_only():
    owner, emp, stranger = users(3)
    ws = workspace_with(owner, {emp: "employee"})
    o = op("companies", name="ООО Ромашка", phones=["+79990000001"], inn="7701234567", created_by=stranger,
           workspace_id=str(uuid.uuid4()), version=99)
    r = push1(emp, ws, o)
    assert r["status"] == "applied" and r["version"] == 1, r
    got = row(owner, "companies", o["id"])
    assert got["name"] == "ООО Ромашка" and got["created_by"] == emp and got["workspace_id"] == str(ws)
    assert got["version"] == 1 and got["field_ver"]["name"] == 1
    assert row(stranger, "companies", o["id"]) is None
    denied("42501", rpc, stranger, "crm_push", p_workspace=ws, p_device="x", p_ops=[op("companies", name="x")])


def test_push_is_idempotent_by_op_id():
    u = make_user()
    ws = rpc(u, "ensure_personal_workspace")
    o = op("companies", name="Повтор")
    first = push1(u, ws, o)
    again = push1(u, ws, o)
    assert first == again and first["status"] == "applied"
    assert one(u, "select count(*) from public.companies where id = %s", (o["id"],)) == 1
    assert row(u, "companies", o["id"])["version"] == 1


def test_field_merge_and_conflicts():
    a, b = users(2)
    ws = workspace_with(a, {b: "manager"})
    o = op("companies", name="Исходное", industry="IT", ts=T0)
    push1(a, ws, o)
    rid = o["id"]
    # Разные поля разными людьми — оба применяются.
    assert push1(a, ws, op("companies", rid, ts=T1, base=1, name="Имя от A"))["status"] == "applied"
    assert push1(b, ws, op("companies", rid, ts=T1, base=1, industry="Ритейл"))["status"] == "applied"
    got = row(a, "companies", rid)
    assert (got["name"], got["industry"], got["version"]) == ("Имя от A", "Ритейл", 3)
    # Устаревшая правка того же поля не перезаписывает свежую и попадает в журнал конфликтов.
    r = push1(b, ws, op("companies", rid, ts=T0, base=1, name="Старое от B"))
    assert r["status"] == "conflict"
    assert row(a, "companies", rid)["name"] == "Имя от A"
    c = q(a, "select field, kept, lost, lost_by from public.sync_conflicts where entity_id = %s", (rid,))
    assert [x[:3] for x in c] == [("name", "Имя от A", "Старое от B")] and c[0][3] == uuid.UUID(b)
    # Более поздняя правка на старой версии применяется, а затёртое значение сохраняется.
    r = push1(b, ws, op("companies", rid, ts=T2, base=1, name="Новое от B"))
    assert r["status"] == "conflict" and row(a, "companies", rid)["name"] == "Новое от B"
    lost = q(a, "select lost, lost_by from public.sync_conflicts where entity_id = %s and kept = '\"Новое от B\"'", (rid,))
    # Строку после правки A менял B (другое поле), поэтому автор затёртого значения не определён.
    assert lost == [("Имя от A", None)]
    first = q(a, "select kept_by from public.sync_conflicts where entity_id = %s and lost = '\"Старое от B\"'", (rid,))
    assert first == [(None,)]
    # То же значение повторно — ничего не меняет.
    assert push1(b, ws, op("companies", rid, ts=T2, name="Новое от B"))["status"] == "merged"


def test_device_clock_in_future_is_clamped():
    u = make_user()
    ws = rpc(u, "ensure_personal_workspace")
    o = op("companies", ts="2099-01-01T00:00:00Z", name="Будущее")
    push1(u, ws, o)
    assert row(u, "companies", o["id"])["field_ts"]["name"] < "2099"
    # Следующая правка с настоящим временем не теряется.
    assert push1(u, ws, op("companies", o["id"], ts="2026-11-02T00:00:00Z", name="Сейчас"))["status"] in ("applied", "conflict")


def test_unknown_entity_fields_and_payload_limits():
    u = make_user()
    ws = rpc(u, "ensure_personal_workspace")
    assert push1(u, ws, op("leads", name="x"))["error"] == "unknown entity"
    assert push1(u, ws, op("companies; drop table public.leads; --", name="x"))["status"] == "rejected"
    assert push1(u, ws, {"op_id": "nope", "entity": "companies", "id": str(uuid.uuid4())})["status"] == "rejected"
    o = op("companies", name="'); delete from public.companies; --", server_seq=1, field_ts={"name": "2099-01-01"})
    assert push1(u, ws, o)["status"] == "applied"
    assert row(u, "companies", o["id"])["name"].startswith("');")
    bad = push1(u, ws, op("companies", name=""))
    assert bad["status"] == "rejected" and bad["code"] == "23514"
    # Чужой op_id не применяется.
    other = make_user()
    used = op("companies", name="Первый")
    push1(u, ws, used)
    rpc(other, "ensure_personal_workspace")
    hijack = dict(used, id=str(uuid.uuid4()))
    ws_other = rpc(other, "ensure_personal_workspace")
    assert push1(other, ws_other, hijack)["error"] == "op_id already used"
    assert row(other, "companies", hijack["id"]) is None
    denied("54000", rpc, u, "crm_push", p_workspace=ws, p_device="x", p_ops=[op("companies", name="n")] * 501)
    with db() as c:
        assert c.execute("select to_regclass('public.leads') is not null").fetchone()[0]


# ------------------------------------------------------------------ права по ролям

def test_role_permissions_on_records():
    owner, mgr, emp, viewer = users(4)
    ws = workspace_with(owner, {mgr: "manager", emp: "employee", viewer: "viewer"})
    assert push1(viewer, ws, op("companies", name="Наблюдатель"))["code"] == "42501"
    mine = op("companies", name="Моя")
    push1(emp, ws, mine)
    theirs = op("companies", name="Чужая")
    push1(owner, ws, theirs)
    assert push1(emp, ws, op("companies", mine["id"], ts=T1, name="Моя 2"))["status"] == "applied"
    r = push1(emp, ws, op("companies", theirs["id"], ts=T1, name="Взлом"))
    assert r["status"] == "rejected" and r["code"] == "42501"
    # Назначение сотрудника ответственным даёт ему право менять запись.
    push1(owner, ws, op("companies", theirs["id"], ts=T1, owner_id=emp))
    assert push1(emp, ws, op("companies", theirs["id"], ts=T2, name="Теперь моя"))["status"] == "applied"
    # Удаление — отдельное право.
    assert push1(emp, ws, op("companies", mine["id"], kind="delete", ts=T2))["code"] == "42501"
    assert push1(mgr, ws, op("companies", mine["id"], kind="delete", ts=T2))["status"] == "applied"
    # Ответственный — только участник этого Workspace.
    r = push1(owner, ws, op("companies", name="x", owner_id=make_user()))
    assert r["status"] == "rejected" and r["code"] == "23503"


def test_tombstones_restore_and_edits_of_deleted_records():
    u = make_user()
    ws = rpc(u, "ensure_personal_workspace")
    o = op("companies", name="Удаляемая")
    push1(u, ws, o)
    seq = row(u, "companies", o["id"])["server_seq"]
    assert push1(u, ws, op("companies", o["id"], kind="delete", ts=T1))["status"] == "applied"
    pulled = q(u, "select to_jsonb(t) from public.companies t where workspace_id = %s and server_seq > %s", (ws, seq))
    assert pulled and pulled[0][0]["deleted_at"] is not None  # надгробие приходит при загрузке
    r = push1(u, ws, op("companies", o["id"], ts=T2, name="Воскрешение"))
    assert r["status"] == "conflict" and row(u, "companies", o["id"])["deleted_at"] is not None
    assert push1(u, ws, op("companies", o["id"], kind="restore"))["status"] == "applied"
    assert row(u, "companies", o["id"])["deleted_at"] is None
    actions = q(u, "select action from public.audit_log where entity_id = %s order by id", (o["id"],))
    assert actions == [("delete",), ("restore",)]


def test_audit_log_is_visible_only_with_audit_view():
    owner, emp = users(2)
    ws = workspace_with(owner, {emp: "employee"})
    assert one(owner, "select count(*) from public.audit_log where workspace_id = %s and action = 'member_join'", (ws,)) == 2
    assert one(emp, "select count(*) from public.audit_log where workspace_id = %s", (ws,)) == 0
    denied("42501", q, emp, "insert into public.audit_log (workspace_id, action) values (%s, 'fake')", (ws,))


# ------------------------------------------------------------------ ссылки и неизменяемые поля

def test_references_must_stay_inside_the_workspace():
    a, b = users(2)
    ws_a = rpc(a, "ensure_personal_workspace")
    ws_b = rpc(b, "ensure_personal_workspace")
    foreign = op("companies", name="Чужая компания")
    push1(b, ws_b, foreign)
    r = push1(a, ws_a, op("contacts", first_name="Иван", company_id=foreign["id"]))
    assert r["status"] == "rejected" and r["code"] == "23503"
    r = push1(a, ws_a, op("notes", body="подглядываю", entity_type="company", entity_id=foreign["id"]))
    assert r["status"] == "rejected" and r["code"] == "23503"
    # Запись с id из другого Workspace нельзя ни прочитать, ни перезаписать.
    r = push1(a, ws_a, op("companies", foreign["id"], name="Перехват"))
    assert r["status"] == "rejected"
    assert row(b, "companies", foreign["id"])["name"] == "Чужая компания"


def test_immutable_columns_cannot_be_changed_directly():
    a, b = users(2)
    ws_a = rpc(a, "ensure_personal_workspace")
    ws_b = rpc(b, "ensure_personal_workspace")
    o = op("companies", name="Неизменяемая")
    push1(a, ws_a, o)
    for col, val in (("workspace_id", ws_b), ("created_by", b), ("id", uuid.uuid4())):
        denied("42501", q, a, f"update public.companies set {col} = %s where id = %s", (val, o["id"]))
    q(a, "update public.companies set name = 'Прямо', field_ts = '{\"name\": \"2099-01-01T00:00:00Z\"}' where id = %s", (o["id"],))
    got = row(a, "companies", o["id"])
    assert got["name"] == "Прямо" and got["field_ts"]["name"] < "2099" and got["version"] == 2


def test_removed_member_cannot_push_or_read():
    owner, emp = users(2)
    ws = workspace_with(owner, {emp: "employee"})
    o = op("companies", name="Общая")
    push1(owner, ws, o)
    assert row(emp, "companies", o["id"]) is not None
    rpc(owner, "remove_member", p_workspace=ws, p_user=emp)
    assert row(emp, "companies", o["id"]) is None
    denied("42501", rpc, emp, "crm_push", p_workspace=ws, p_device="x", p_ops=[op("companies", name="после удаления")])


# ------------------------------------------------------------------ сделки

def test_deals_stage_status_and_history():
    owner, emp = users(2)
    ws = workspace_with(owner, {emp: "employee"})
    st = stages(owner, ws)
    pipe = st["Новый лид"]["pipeline_id"]
    company = op("companies", name="Клиент")
    push1(emp, ws, company)
    d = op("deals", title="Поставка", amount=150000.5, currency="USD", pipeline_id=pipe, stage_id=st["Новый лид"]["id"],
           company_id=company["id"], status="won", closed_at=T0)
    assert push1(emp, ws, d)["status"] == "applied"
    got = row(owner, "deals", d["id"])
    assert (got["status"], got["closed_at"], got["amount"]) == ("open", None, 150000.5)
    push1(emp, ws, op("deals", d["id"], ts=T1, stage_id=st["Переговоры"]["id"]))
    push1(emp, ws, op("deals", d["id"], ts=T2, stage_id=st["Успешная сделка"]["id"]))
    got = row(owner, "deals", d["id"])
    assert got["status"] == "won" and got["closed_at"] is not None
    hist = q(owner, "select from_stage_id, to_stage_id, changed_by from public.deal_stage_history where deal_id = %s "
                    "order by server_seq", (d["id"],))
    assert [h[1] for h in hist] == [uuid.UUID(st[n]["id"]) for n in ("Новый лид", "Переговоры", "Успешная сделка")]
    assert hist[0][0] is None and all(h[2] == uuid.UUID(emp) for h in hist)
    denied("42501", q, emp, "insert into public.deal_stage_history (workspace_id, deal_id, to_stage_id) values (%s, %s, %s)",
           (ws, d["id"], st["Новый лид"]["id"]))
    # Отрицательная сумма и этап чужой воронки отклоняются.
    assert push1(emp, ws, op("deals", d["id"], ts=T2, amount=-1))["code"] == "23514"
    other = op("pipelines", name="Вторая", position=2)
    assert push1(owner, ws, other)["status"] == "applied"
    r = push1(owner, ws, op("deals", title="x", pipeline_id=other["id"], stage_id=st["Новый лид"]["id"]))
    assert r["status"] == "rejected" and r["code"] == "23503"


def test_pipelines_need_pipelines_manage_and_delete_stage_moves_deals():
    owner, emp = users(2)
    ws = workspace_with(owner, {emp: "employee"})
    st = stages(owner, ws)
    pipe = st["Новый лид"]["pipeline_id"]
    assert push1(emp, ws, op("pipeline_stages", pipeline_id=pipe, name="Мой этап", position=1.5))["code"] == "42501"
    extra = op("pipeline_stages", pipeline_id=pipe, name="Пилот", position=2.5, color="#123abc", probability=30)
    assert push1(owner, ws, extra)["status"] == "applied"
    d = op("deals", title="На пилоте", pipeline_id=pipe, stage_id=extra["id"])
    push1(emp, ws, d)
    denied("42501", rpc, emp, "delete_stage", p_stage=extra["id"], p_move_to=st["Переговоры"]["id"])
    assert rpc(owner, "delete_stage", p_stage=extra["id"], p_move_to=st["Переговоры"]["id"]) == 1
    assert row(owner, "deals", d["id"])["stage_id"] == st["Переговоры"]["id"]
    assert row(owner, "pipeline_stages", extra["id"])["deleted_at"] is not None


def test_deal_contacts_link_twice_merges():
    u = make_user()
    ws = rpc(u, "ensure_personal_workspace")
    st = stages(u, ws)
    c = op("contacts", first_name="Анна", last_name="Ли", emails=["anna@example.com"])
    d = op("deals", title="Сделка", pipeline_id=st["Новый лид"]["pipeline_id"], stage_id=st["Новый лид"]["id"])
    push(u, ws, c, d)
    link_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"deal_contacts:{d['id']}:{c['id']}"))
    assert push1(u, ws, op("deal_contacts", link_id, deal_id=d["id"], contact_id=c["id"], role="ЛПР"))["status"] == "applied"
    assert push1(u, ws, op("deal_contacts", link_id, ts=T1, deal_id=d["id"], contact_id=c["id"], role="Бухгалтер"))["status"] == "applied"
    assert one(u, "select count(*) from public.deal_contacts where deal_id = %s", (d["id"],)) == 1
    assert row(u, "contacts", c["id"])["full_name"] == "Анна Ли"


# ------------------------------------------------------------------ задачи, заметки, комментарии

def test_tasks_notes_comments():
    owner, emp = users(2)
    ws = workspace_with(owner, {emp: "employee"})
    company = op("companies", name="Карточка")
    push1(owner, ws, company)
    t = op("tasks", title="Позвонить", assignee_id=emp, due_at="2026-11-01T09:00:00Z", priority="high",
           entity_type="company", entity_id=company["id"])
    assert push1(owner, ws, t)["status"] == "applied"
    # Исполнитель может менять задачу, даже если её создал не он.
    assert push1(emp, ws, op("tasks", t["id"], ts=T1, status="done"))["status"] == "applied"
    assert row(owner, "tasks", t["id"])["completed_at"] is not None
    push1(emp, ws, op("tasks", t["id"], ts=T2, status="todo"))
    assert row(owner, "tasks", t["id"])["completed_at"] is None
    assert push1(owner, ws, op("tasks", title="x", entity_type="company"))["code"] == "23514"
    assert push1(owner, ws, op("tasks", title="x", assignee_id=make_user()))["code"] == "23503"

    n = op("notes", body="Заметка сотрудника", entity_type="company", entity_id=company["id"])
    assert push1(emp, ws, n)["status"] == "applied"
    # Свою заметку автор удаляет без права records.delete.
    assert push1(emp, ws, op("notes", n["id"], kind="delete", ts=T1))["status"] == "applied"
    root = op("comments", body="Вопрос", entity_type="company", entity_id=company["id"])
    reply = op("comments", body="Ответ", entity_type="company", entity_id=company["id"], parent_id=root["id"])
    assert [r["status"] for r in push(emp, ws, root, reply)] == ["applied", "applied"]
    a = op("activities", type="call", summary="Звонок", entity_type="company", entity_id=company["id"],
           occurred_at="2099-01-01T00:00:00Z")
    push1(emp, ws, a)
    assert row(owner, "activities", a["id"])["occurred_at"] < "2099"


# ------------------------------------------------------------------ коллекции

def test_collections_visibility_and_prefs():
    owner, mgr, emp = users(3)
    ws = workspace_with(owner, {mgr: "manager", emp: "employee"})
    private = op("collections", visibility="private", entity_type="deal", name="Мои крупные", emoji="💰",
                 config={"filters": [{"field": "amount", "op": "gt", "value": 100000}]})
    assert push1(emp, ws, private)["status"] == "applied"
    assert row(owner, "collections", private["id"]) is None  # личная видна только автору
    shared = op("collections", visibility="workspace", entity_type="company", name="Общая")
    assert push1(emp, ws, shared)["code"] == "42501"
    assert push1(mgr, ws, dict(shared, op_id=str(uuid.uuid4())))["status"] == "applied"
    assert row(emp, "collections", shared["id"]) is not None
    assert push1(emp, ws, op("collections", shared["id"], ts=T1, name="Переименовал"))["code"] == "42501"
    assert push1(emp, ws, op("collections", private["id"], kind="delete", ts=T1))["status"] == "applied"
    # Порядок в левой панели — свой у каждого.
    q(emp, "insert into public.collection_user_prefs (collection_id, workspace_id, position) values (%s, %s, 3)",
      (shared["id"], ws))
    assert one(emp, "select count(*) from public.collection_user_prefs") == 1
    assert one(mgr, "select count(*) from public.collection_user_prefs") == 0
    denied("42501", q, emp, "insert into public.collection_user_prefs (collection_id, workspace_id, user_id) "
                            "values (%s, %s, %s)", (shared["id"], ws, mgr))


# ------------------------------------------------------------------ обслуживание и REST

def test_maintenance_requires_workspace_manage():
    owner, emp = users(2)
    ws = workspace_with(owner, {emp: "employee"})
    denied("42501", rpc, emp, "crm_maintenance", p_workspace=ws)
    o = op("companies", name="Старая")
    push1(owner, ws, o)
    push1(owner, ws, op("companies", o["id"], kind="delete", ts=T1))
    with db() as c:
        c.execute("alter table public.companies disable trigger companies_crm_stamp")
        c.execute("update public.companies set deleted_at = now() - interval '91 days' where id = %s", (o["id"],))
        c.execute("alter table public.companies enable trigger companies_crm_stamp")
    res = rpc(owner, "crm_maintenance", p_workspace=ws)
    assert res["tombstones"] == 1
    with db() as c:
        assert c.execute("select count(*) from public.companies where id = %s", (o["id"],)).fetchone()[0] == 0


def test_rest_push_and_incremental_pull_like_the_app():
    c, _ = confirmed_user()
    ws = c.rpc("ensure_personal_workspace", {}).json()
    o = op("companies", name="Через REST")
    r = c.rpc("crm_push", {"p_workspace": ws, "p_device": "dev-rest", "p_ops": [o]})
    assert r.status_code == 200 and r.json()["results"][0]["status"] == "applied", r.text
    r = c.rest("GET", f"companies?workspace_id=eq.{ws}&server_seq=gt.0&order=server_seq.asc&limit=500")
    assert r.status_code == 200 and [x["id"] for x in r.json()] == [o["id"]]
    cursor = r.json()[-1]["server_seq"]
    assert c.rest("GET", f"companies?workspace_id=eq.{ws}&server_seq=gt.{cursor}").json() == []
    r = c.rest("POST", "audit_log", json={"workspace_id": ws, "action": "x"})
    assert r.status_code in (401, 403)
