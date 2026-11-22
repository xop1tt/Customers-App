"""Отделы как сущность (ADR-096): дерево отделов, отдел сотрудника и записи, видимость записей по роли
(всё / свой отдел с подотделами / только свои), передача записи в другой отдел, журнал изменений видимости."""

from conftest import db
from test_crm import T1, op, push1, row
from crm_helpers import denied, one, q, rpc, users, workspace_with


def dept(uid, ws, name, parent=None, head=None, did=None):
    return str(rpc(uid, "save_department", p_workspace=ws, p_id=did, p_name=name, p_parent=parent, p_head=head))


def visible(uid, table: str, rid: str) -> bool:
    return row(uid, table, rid) is not None


def events(uid, ws) -> list[tuple]:
    return q(uid, "select entity, entity_id::text from public.crm_scope_events where workspace_id = %s order by id", (ws,))


def test_department_tree_is_managed_by_members_manage():
    owner, emp = users(2)
    ws = workspace_with(owner, {emp: "employee"})
    sales = dept(owner, ws, "Продажи")
    msk = dept(owner, ws, "Продажи Москва", parent=sales)
    denied("42501", dept, emp, ws, "Свой отдел")
    denied("23505", dept, owner, ws, " продажи ")
    denied("22023", dept, owner, ws, "Продажи", parent=msk, did=sales)  # цикл
    denied("22023", dept, owner, ws, "Отдел", head=users(1)[0])         # руководитель не участник
    dept(owner, ws, "Продажи (B2B)", did=sales, head=emp)
    got = q(emp, "select name, parent_id::text, head_id::text from public.departments where workspace_id = %s order by name", (ws,))
    assert got == [("Продажи (B2B)", None, emp), ("Продажи Москва", str(sales), None)]
    rpc(owner, "set_member_department", p_workspace=ws, p_user=emp, p_department=msk)
    with db() as c:
        assert c.execute("select department from public.member_profiles where workspace_id = %s and user_id = %s",
                         (ws, emp)).fetchone()[0] == "Продажи Москва", "старые версии приложения видят отдел текстом"
    denied("42501", rpc, emp, "set_member_department", p_workspace=ws, p_user=owner, p_department=None)
    acts = q(owner, "select action from public.audit_log where workspace_id = %s and entity_type = 'department' order by id", (ws,))
    assert [a[0] for a in acts] == ["department_create", "department_create", "department_update"]


def test_records_are_visible_by_role_scope_and_department():
    owner, lead, a, b, outsider_dep = users(5)
    ws = workspace_with(owner, {lead: "employee", a: "employee", b: "employee", outsider_dep: "manager"})
    sales = dept(owner, ws, "Продажи", head=lead)
    msk = dept(owner, ws, "Москва", parent=sales)
    mkt = dept(owner, ws, "Маркетинг")
    rpc(owner, "set_member_department", p_workspace=ws, p_user=a, p_department=msk)
    rpc(owner, "set_member_department", p_workspace=ws, p_user=b, p_department=mkt)
    # Смена отдела одного сотрудника перепроверяет только его устройство.
    mine = "select count(*) from public.crm_scope_events where workspace_id = %s and user_id = %s"
    assert one(b, mine, (ws, b)) == 1 and one(a, mine, (ws, b)) == 0

    mine_a = op("companies", name="Клиент Москвы", owner_id=a)
    assert push1(a, ws, mine_a)["status"] == "applied"
    assert row(owner, "companies", mine_a["id"])["department_id"] == msk, "отдел ответственного по умолчанию"
    common = op("companies", name="Общий лид")
    push1(owner, ws, common)
    mkt_rec = op("companies", name="Клиент маркетинга", owner_id=b)
    push1(b, ws, mkt_rec)
    note = op("notes", entity_type="company", entity_id=mkt_rec["id"], body="секрет маркетинга")
    push1(b, ws, note)

    # По умолчанию роль видит всё.
    assert visible(a, "companies", mkt_rec["id"]) and visible(a, "notes", note["id"])
    denied("42501", rpc, a, "set_role_scope", p_workspace=ws, p_key="employee", p_scope="department")
    rpc(owner, "set_role_scope", p_workspace=ws, p_key="employee", p_scope="department")
    assert events(a, ws)[-1] == (None, None), "устройствам нужно перепроверить видимость"

    assert visible(a, "companies", mine_a["id"]) and visible(a, "companies", common["id"])
    assert not visible(a, "companies", mkt_rec["id"]) and not visible(a, "notes", note["id"])
    # Руководитель «Продаж» видит подотдел «Москва», маркетинг — нет.
    assert visible(lead, "companies", mine_a["id"]) and not visible(lead, "companies", mkt_rec["id"])
    # Менеджеров настройка роли «Сотрудник» не касается.
    assert visible(outsider_dep, "companies", mkt_rec["id"])
    # Чужую запись нельзя изменить «вслепую».
    r = push1(a, ws, op("companies", mkt_rec["id"], ts=T1, name="x"))
    assert r["status"] == "rejected"

    # Передача в другой отдел: прежний отдел её больше не видит, журнал называет только id.
    push1(owner, ws, op("companies", mine_a["id"], ts=T1, department_id=mkt, owner_id=b))
    assert events(a, ws)[-1] == ("companies", mine_a["id"])
    assert not visible(a, "companies", mine_a["id"]) and visible(b, "companies", mine_a["id"])

    rpc(owner, "set_role_scope", p_workspace=ws, p_key="employee", p_scope="own")
    assert not visible(a, "companies", common["id"]) and visible(b, "companies", mkt_rec["id"])
    assert one(b, "select count(*) from public.companies where workspace_id = %s", (ws,)) == 2


def test_role_scope_follows_role_rules_and_is_per_workspace():
    owner, admin, emp = users(3)
    ws = workspace_with(owner, {admin: "admin", emp: "employee"})
    other = workspace_with(owner, {emp: "employee"})
    denied("42501", rpc, admin, "set_role_scope", p_workspace=ws, p_key="admin", p_scope="own")  # своя роль
    denied("42501", rpc, admin, "set_role_scope", p_workspace=ws, p_key="owner", p_scope="own")
    denied("22023", rpc, admin, "set_role_scope", p_workspace=ws, p_key="employee", p_scope="team")
    rpc(admin, "set_role_scope", p_workspace=ws, p_key="employee", p_scope="own")
    c = op("companies", name="Видна во втором")
    push1(owner, other, c)
    assert visible(emp, "companies", c["id"]), "настройка одного Workspace не влияет на другой"


def test_closing_a_department_moves_people_and_records_to_the_parent():
    owner, a = users(2)
    ws = workspace_with(owner, {a: "employee"})
    sales = dept(owner, ws, "Продажи")
    msk = dept(owner, ws, "Москва", parent=sales)
    south = dept(owner, ws, "Юг", parent=msk)
    rpc(owner, "set_member_department", p_workspace=ws, p_user=a, p_department=msk)
    c = op("companies", name="Клиент", owner_id=a)
    push1(a, ws, c)
    seq = row(owner, "companies", c["id"])["server_seq"]
    rpc(owner, "delete_department", p_workspace=ws, p_id=msk)
    got = row(owner, "companies", c["id"])
    assert got["department_id"] == sales and got["server_seq"] > seq
    assert one(owner, "select parent_id::text from public.departments where id = %s", (south,)) == sales
    with db() as cn:
        assert cn.execute("select department_id::text, department from public.member_profiles where user_id = %s",
                          (a,)).fetchone() == (sales, "Продажи")
    denied("P0002", rpc, owner, "delete_department", p_workspace=ws, p_id=msk)
    r = push1(owner, ws, op("companies", name="В закрытый", department_id=msk))
    assert r["status"] == "rejected" and r["code"] == "23503"


def test_department_of_another_workspace_is_rejected():
    owner = users(1)[0]
    ws = workspace_with(owner)
    other = workspace_with(owner)
    foreign = dept(owner, other, "Чужой")
    r = push1(owner, ws, op("companies", name="x", department_id=foreign))
    assert r["status"] == "rejected" and r["code"] == "23503"


def test_department_typed_as_text_becomes_a_real_department():
    owner, a, b = users(3)
    ws = workspace_with(owner, {a: "employee", b: "employee"})
    rpc(owner, "update_member_profile", p_workspace=ws, p_user=a, p_department="Логистика")
    rpc(owner, "update_member_profile", p_workspace=ws, p_user=b, p_department=" логистика ")
    deps = q(owner, "select id::text, name from public.departments where workspace_id = %s and deleted_at is null", (ws,))
    assert [d[1] for d in deps] == ["Логистика"], "один отдел, без дубля по регистру и пробелам"
    team = {m["user_id"]: m for m in rpc(owner, "team_directory", p_workspace=ws)}
    assert team[a]["department_id"] == team[b]["department_id"] == deps[0][0]
    rpc(owner, "update_member_profile", p_workspace=ws, p_user=b, p_department="")
    assert {m["user_id"]: m for m in rpc(owner, "team_directory", p_workspace=ws)}[b]["department_id"] is None
    # Должность меняется, отдел остаётся.
    rpc(owner, "update_member_profile", p_workspace=ws, p_user=a, p_title="Кладовщик")
    assert {m["user_id"]: m for m in rpc(owner, "team_directory", p_workspace=ws)}[a]["department_id"] == deps[0][0]
