"""Корпоративные учётные записи и чат (миграция 20261110170000_team_chat.sql): справочник сотрудников, карточки и
иерархия, новые роли, личные и групповые обсуждения, права, упоминания, уведомления и опрос chat_poll."""

from __future__ import annotations

import uuid

import psycopg

from crm_helpers import acting, denied, email_of, one, q, rpc, users, workspace_with


def call(uid: str | None, name: str, **args):
    """Как crm_helpers.rpc, но массивы uuid передаются массивами PostgreSQL (rpc шлёт списки как JSON)."""
    parts, params = [], {}
    for k, v in args.items():
        if isinstance(v, list):
            parts.append(f"{k} => %({k})s::uuid[]")
        else:
            parts.append(f"{k} => %({k})s")
        params[k] = v
    return one(uid, f"select public.{name}({', '.join(parts)})", params)


def set_name(uid: str, name: str) -> None:
    with acting(uid) as c:
        c.execute("""insert into public.user_profiles (user_id, display_name) values (%s, %s)
                     on conflict (user_id) do update set display_name = excluded.display_name""", (uid, name))


def person(directory: list, uid: str) -> dict:
    return next(p for p in directory if p["user_id"] == uid)


def _op(entity: str, rid: str, **fields) -> dict:
    ts = "2026-11-10T10:00:00Z"
    return {"op_id": str(uuid.uuid4()), "entity": entity, "id": rid, "kind": "upsert", "fields": fields,
            "ts": {k: ts for k in fields}, "base_version": 0}


def note(uid: str, ws: str, body: str, note_id: str | None = None) -> str:
    """Заметка к компании (или правка заметки), как её записывает приложение через crm_push."""
    if note_id:
        ops = [_op("notes", note_id, body=body)]
        ops[0]["ts"] = {"body": "2026-11-10T11:00:00Z"}
        ops[0]["base_version"] = 1
    else:
        company, note_id = str(uuid.uuid4()), str(uuid.uuid4())
        ops = [_op("companies", company, name=f"Компания {company[:6]}"),
               _op("notes", note_id, body=body, entity_type="company", entity_id=company)]
    res = rpc(uid, "crm_push", p_workspace=ws, p_device="dev-test", p_ops=ops)
    assert all(r["status"] in ("applied", "merged") for r in res["results"]), res
    return note_id


# ------------------------------------------------------------------ роли

def test_new_system_roles_and_their_rights():
    rows = q(users(1)[0], """select r.key, r.name, r.rank, array_agg(rp.permission_key order by rp.permission_key)
                              from public.roles r join public.role_permissions rp on rp.role_id = r.id
                              where r.workspace_id is null and r.key in ('head_of_sales', 'team_lead')
                              group by r.key, r.name, r.rank""")
    m = {k: (name, rank, set(p)) for k, name, rank, p in rows}
    assert m["head_of_sales"][:2] == ("Глава отдела продаж", 75)
    assert m["team_lead"][:2] == ("Руководитель", 70)
    assert "members.manage" in m["head_of_sales"][2] and "members.manage" not in m["team_lead"][2]
    assert "workspace.delete" not in m["head_of_sales"][2] and "roles.manage" not in m["head_of_sales"][2]
    owner, head, lead, mgr = users(4)
    ws = workspace_with(owner, {head: "head_of_sales", lead: "team_lead", mgr: "manager"})
    # Глава отдела продаж меняет роли тех, кто ниже, но не выше себя.
    rpc(head, "set_member_role", p_workspace=ws, p_user=mgr, p_role="team_lead")
    denied("42501", rpc, head, "set_member_role", p_workspace=ws, p_user=owner, p_role="employee")
    denied("42501", rpc, lead, "set_member_role", p_workspace=ws, p_user=mgr, p_role="employee")


# ------------------------------------------------------------------ справочник и карточки

def test_directory_shows_profile_email_presence_and_default_hire_date():
    owner, emp, viewer, outsider = users(4)
    ws = workspace_with(owner, {emp: "employee", viewer: "viewer"})
    set_name(emp, "Борис Петров")
    with acting(emp) as c:
        c.execute("update public.user_profiles set avatar_data = 'data:image/jpeg;base64,QUJD' where user_id = %s", (emp,))
    rpc(emp, "chat_poll", p_workspace=ws)  # «я в сети»
    d = rpc(viewer, "team_directory", p_workspace=ws)
    assert {p["user_id"] for p in d} == {owner, emp, viewer}
    b = person(d, emp)
    assert b["display_name"] == "Борис Петров" and b["avatar"] == "data:image/jpeg;base64,QUJD"
    assert b["email"] == email_of(emp), "почта видна всем участникам"
    assert b["online"] is True and person(d, owner)["online"] is False
    assert b["hired_on"] == b["joined_at"][:10] and b["title"] == "" and b["manager_id"] is None
    assert b["can_edit"] is False, "наблюдатель не меняет карточки"
    denied("42501", rpc, outsider, "team_directory", p_workspace=ws)
    denied("42501", rpc, None, "team_directory", p_workspace=ws)


def test_avatar_must_be_a_small_image_data_url():
    u = users(1)[0]
    with acting(u) as c:
        c.execute("insert into public.user_profiles (user_id) values (%s) on conflict do nothing", (u,))
    for bad in ["javascript:alert(1)", "data:text/html;base64,QUJD", "data:image/png;base64," + "A" * 90000]:
        try:
            with acting(u) as c:
                c.execute("update public.user_profiles set avatar_data = %s where user_id = %s", (bad, u))
            raise AssertionError(f"принято: {bad[:30]}")
        except psycopg.errors.CheckViolation:
            pass


def test_member_profile_edit_rights_hierarchy_and_cycles():
    owner, head, lead, emp, emp2 = users(5)
    ws = workspace_with(owner, {head: "head_of_sales", lead: "team_lead", emp: "employee", emp2: "employee"})
    p = call(owner, "update_member_profile", p_workspace=ws, p_user=lead, p_title="Руководитель группы",
             p_department="Продажи", p_manager=head, p_hired_on="2024-03-01")
    assert (p["title"], p["department"], p["manager_id"], p["hired_on"]) == ("Руководитель группы", "Продажи", head, "2024-03-01")
    # Руководитель (invitations.manage) меняет карточки тех, кто ниже по рангу; null оставляет поле как было.
    p = call(lead, "update_member_profile", p_workspace=ws, p_user=emp, p_title="Менеджер по продажам", p_manager=lead)
    assert p["title"] == "Менеджер по продажам" and p["manager_id"] == lead and p["department"] == ""
    p = call(lead, "update_member_profile", p_workspace=ws, p_user=emp, p_department="Продажи")
    assert p["title"] == "Менеджер по продажам" and p["manager_id"] == lead
    denied("42501", call, lead, "update_member_profile", p_workspace=ws, p_user=head, p_title="x")
    denied("42501", call, emp, "update_member_profile", p_workspace=ws, p_user=emp2, p_title="x")
    denied("42501", call, emp, "update_member_profile", p_workspace=ws, p_user=emp, p_title="сам себе")
    # Цикл и сам себе руководитель.
    denied("22023", call, owner, "update_member_profile", p_workspace=ws, p_user=head, p_manager=emp)
    denied("22023", call, owner, "update_member_profile", p_workspace=ws, p_user=emp, p_manager=emp)
    denied("22023", call, owner, "update_member_profile", p_workspace=ws, p_user=emp, p_manager=users(1)[0])
    denied("22023", call, owner, "update_member_profile", p_workspace=ws, p_user=emp, p_title="x" * 121)
    p = call(owner, "update_member_profile", p_workspace=ws, p_user=emp, p_clear_manager=True, p_clear_hired=True)
    assert p["manager_id"] is None and p["hired_on"] == p["joined_at"][:10]
    # Ушедший руководитель не показывается.
    rpc(owner, "remove_member", p_workspace=ws, p_user=head)
    assert person(rpc(owner, "team_directory", p_workspace=ws), lead)["manager_id"] is None


def test_member_profiles_table_is_closed():
    owner = users(1)[0]
    ws = workspace_with(owner)
    denied("42501", q, owner, "select * from public.member_profiles")
    denied("42501", q, owner, "insert into public.member_profiles (workspace_id, user_id) values (%s, %s)", (ws, owner))
    for t in ("chat_conversations", "chat_participants", "chat_messages", "notifications"):
        denied("42501", q, owner, f"select * from public.{t}")


# ------------------------------------------------------------------ личные сообщения

def test_direct_conversation_is_one_per_pair_and_unread_counts():
    a, b, c = users(3)
    ws = workspace_with(a, {b: "viewer", c: "employee"})
    conv = rpc(a, "chat_open_direct", p_workspace=ws, p_user=b)
    assert rpc(b, "chat_open_direct", p_workspace=ws, p_user=a)["id"] == conv["id"]
    denied("22023", rpc, a, "chat_open_direct", p_workspace=ws, p_user=a)
    denied("22023", rpc, a, "chat_open_direct", p_workspace=ws, p_user=users(1)[0])
    m1 = rpc(a, "chat_send", p_conversation=conv["id"], p_body="  Привет!  ")
    rpc(a, "chat_send", p_conversation=conv["id"], p_body="Как дела?")
    assert m1["body"] == "Привет!"
    lst = rpc(b, "chat_list", p_workspace=ws)
    assert [x["id"] for x in lst] == [conv["id"]] and lst[0]["unread"] == 2 and lst[0]["last"]["body"] == "Как дела?"
    assert rpc(a, "chat_list", p_workspace=ws)[0]["unread"] == 0, "свои сообщения прочитаны"
    assert rpc(c, "chat_list", p_workspace=ws) == []
    denied("P0002", rpc, c, "chat_messages", p_conversation=conv["id"])
    denied("P0002", rpc, c, "chat_send", p_conversation=conv["id"], p_body="чужой диалог")
    page = rpc(b, "chat_messages", p_conversation=conv["id"])
    assert [m["body"] for m in page["messages"]] == ["Привет!", "Как дела?"]
    assert rpc(b, "chat_list", p_workspace=ws)[0]["unread"] == 0
    # Наблюдатель пишет в личные сообщения.
    rpc(b, "chat_send", p_conversation=conv["id"], p_body="Хорошо")
    denied("22023", rpc, b, "chat_send", p_conversation=conv["id"], p_body="   ")
    denied("22023", rpc, b, "chat_send", p_conversation=conv["id"], p_body="x" * 4001)
    # Получатель ушёл — писать нельзя, история остаётся у оставшегося.
    rpc(a, "remove_member", p_workspace=ws, p_user=b)
    denied("42501", rpc, a, "chat_send", p_conversation=conv["id"], p_body="ты тут?")
    denied("42501", rpc, b, "chat_list", p_workspace=ws)
    assert len(rpc(a, "chat_messages", p_conversation=conv["id"])["messages"]) == 3


def test_message_paging_edit_and_delete():
    a, b = users(2)
    ws = workspace_with(a, {b: "employee"})
    conv = rpc(a, "chat_open_direct", p_workspace=ws, p_user=b)["id"]
    sent = [rpc(a, "chat_send", p_conversation=conv, p_body=f"m{i}") for i in range(5)]
    last2 = rpc(b, "chat_messages", p_conversation=conv, p_limit=2)["messages"]
    assert [m["body"] for m in last2] == ["m3", "m4"]
    older = rpc(b, "chat_messages", p_conversation=conv, p_before=last2[0]["seq"], p_limit=2)["messages"]
    assert [m["body"] for m in older] == ["m1", "m2"]
    newer = rpc(b, "chat_messages", p_conversation=conv, p_after=sent[2]["seq"])["messages"]
    assert [m["body"] for m in newer] == ["m3", "m4"]
    edited = rpc(a, "chat_edit", p_message=sent[0]["id"], p_body="m0!")
    assert edited["body"] == "m0!" and edited["edited_at"]
    denied("42501", rpc, b, "chat_edit", p_message=sent[0]["id"], p_body="чужое")
    denied("42501", rpc, b, "chat_delete", p_message=sent[1]["id"])
    rpc(a, "chat_delete", p_message=sent[1]["id"])
    msgs = rpc(a, "chat_messages", p_conversation=conv)["messages"]
    gone = next(m for m in msgs if m["id"] == sent[1]["id"])
    assert gone["deleted"] is True and gone["body"] == ""
    denied("42501", rpc, a, "chat_edit", p_message=sent[1]["id"], p_body="воскресить")


def test_message_rate_limit():
    a, b = users(2)
    ws = workspace_with(a, {b: "employee"})
    conv = rpc(a, "chat_open_direct", p_workspace=ws, p_user=b)["id"]
    for i in range(30):
        rpc(a, "chat_send", p_conversation=conv, p_body=f"{i}")
    denied("54000", rpc, a, "chat_send", p_conversation=conv, p_body="31")


# ------------------------------------------------------------------ групповые обсуждения

def test_group_create_rights_and_adding_each_other():
    owner, emp, emp2, emp3, viewer = users(5)
    ws = workspace_with(owner, {emp: "employee", emp2: "employee", emp3: "employee", viewer: "viewer"})
    denied("42501", call, viewer, "chat_create_group", p_workspace=ws, p_title="Наблюдатель", p_members=[])
    denied("22023", call, emp, "chat_create_group", p_workspace=ws, p_title="  ", p_members=[])
    denied("22023", call, emp, "chat_create_group", p_workspace=ws, p_title="Чужие", p_members=[users(1)[0]])
    g = call(emp, "chat_create_group", p_workspace=ws, p_title="Отдел продаж", p_members=[emp2, emp])
    assert g["kind"] == "group" and g["my_role"] == "owner"
    assert {p["user_id"]: p["role"] for p in g["participants"]} == {emp: "owner", emp2: "member"}
    # Участник добавляет коллегу (по умолчанию так можно), в т.ч. наблюдателя.
    g = call(emp2, "chat_add_members", p_conversation=g["id"], p_users=[emp3, viewer])
    assert len(g["participants"]) == 4
    msgs = rpc(viewer, "chat_messages", p_conversation=g["id"])["messages"]
    assert [m["kind"] for m in msgs] == ["system", "system"] and "добавляет" in msgs[1]["body"]
    # Владелец обсуждения запрещает добавлять участникам.
    denied("42501", rpc, emp2, "chat_update", p_conversation=g["id"], p_members_can_add=False)
    rpc(emp, "chat_update", p_conversation=g["id"], p_members_can_add=False)
    denied("42501", call, emp2, "chat_add_members", p_conversation=g["id"], p_users=[owner])
    # Администратор Workspace (members.manage) может.
    rpc(emp, "chat_set_role", p_conversation=g["id"], p_user=emp2, p_role="admin")
    call(emp2, "chat_add_members", p_conversation=g["id"], p_users=[owner])
    denied("42501", rpc, emp2, "chat_set_role", p_conversation=g["id"], p_user=emp3, p_role="admin")
    denied("22023", rpc, emp, "chat_set_role", p_conversation=g["id"], p_user=emp3, p_role="owner")
    # Переименование — служебное сообщение.
    rpc(emp2, "chat_update", p_conversation=g["id"], p_title="Продажи: Москва")
    assert rpc(emp3, "chat_list", p_workspace=ws)[0]["title"] == "Продажи: Москва"
    # Личные диалоги — без участников и настроек.
    d = rpc(emp, "chat_open_direct", p_workspace=ws, p_user=emp3)["id"]
    denied("22023", call, emp, "chat_add_members", p_conversation=d, p_users=[emp2])
    denied("22023", rpc, emp, "chat_update", p_conversation=d, p_title="x")


def test_group_remove_leave_and_owner_succession():
    owner, a, b, c = users(4)
    ws = workspace_with(owner, {a: "employee", b: "employee", c: "employee"})
    g = call(a, "chat_create_group", p_workspace=ws, p_title="Команда", p_members=[b, c])["id"]
    denied("42501", rpc, b, "chat_remove_member", p_conversation=g, p_user=c)
    rpc(a, "chat_set_role", p_conversation=g, p_user=b, p_role="admin")
    rpc(b, "chat_remove_member", p_conversation=g, p_user=c)
    denied("P0002", rpc, c, "chat_messages", p_conversation=g)
    denied("42501", rpc, b, "chat_remove_member", p_conversation=g, p_user=a)
    # Владелец уходит — владельцем становится админ.
    rpc(a, "chat_remove_member", p_conversation=g, p_user=a)
    view = rpc(b, "chat_messages", p_conversation=g)["conversation"]
    assert view["my_role"] == "owner" and [p["user_id"] for p in view["participants"]] == [b]
    # Ушёл последний — обсуждения нет.
    rpc(b, "chat_remove_member", p_conversation=g, p_user=b)
    assert rpc(b, "chat_list", p_workspace=ws) == []


def test_manager_of_workspace_moderates_any_discussion_but_not_its_owner():
    owner, admin, a, b = users(4)
    ws = workspace_with(owner, {admin: "admin", a: "employee", b: "employee"})
    g = call(a, "chat_create_group", p_workspace=ws, p_title="Без админа", p_members=[b, admin])["id"]
    rpc(admin, "chat_update", p_conversation=g, p_title="Переименовал админ")
    rpc(admin, "chat_remove_member", p_conversation=g, p_user=b)
    denied("42501", rpc, admin, "chat_remove_member", p_conversation=g, p_user=a)
    m = rpc(a, "chat_send", p_conversation=g, p_body="лишнее")
    rpc(admin, "chat_delete", p_message=m["id"])


def test_group_creation_limit():
    owner = users(1)[0]
    ws = workspace_with(owner)
    for i in range(30):
        call(owner, "chat_create_group", p_workspace=ws, p_title=f"G{i}", p_members=[])
    denied("54000", call, owner, "chat_create_group", p_workspace=ws, p_title="G30", p_members=[])


# ------------------------------------------------------------------ упоминания и уведомления

def test_mentions_by_name_and_email_in_group_create_notifications():
    owner, a, b, c, d = users(5)
    ws = workspace_with(owner, {a: "employee", b: "employee", c: "employee", d: "employee"})
    set_name(b, "Вера Котова")
    set_name(c, "Ив")
    g = call(a, "chat_create_group", p_workspace=ws, p_title="Сделка", p_members=[b, c])["id"]
    first = rpc(b, "chat_poll", p_workspace=ws)
    assert first["fresh"] == [], "первый опрос только даёт курсор"
    kinds = [n["kind"] for n in first["notifications"]]
    assert kinds == ["added_to_group"] and first["notifications"][0]["actor_name"]
    msg = rpc(a, "chat_send", p_conversation=g, p_body=f"@Вера Котова и {email_of(c).upper()}, посмотрите. @Ивлев — не наш")
    assert set(msg["mentions"]) == {b, c}
    # Упоминание того, кто не в обсуждении, не уведомляет.
    rpc(a, "chat_send", p_conversation=g, p_body=f"{email_of(d)} не в обсуждении")
    nb = rpc(b, "chat_poll", p_workspace=ws, p_since=first["cursor"])
    assert [f["body"][:5] for f in nb["fresh"]] == ["@Вера", email_of(d)[:5]]
    assert nb["fresh"][0]["mentioned"] is True and nb["fresh"][0]["author_name"]
    assert [n["kind"] for n in nb["notifications"]] == ["mention", "added_to_group"]
    # Непрочитанные: служебное «создаёт обсуждение» и два сообщения.
    assert nb["unread"] == {g: 3} and nb["cursor"] > first["cursor"]
    assert [n["kind"] for n in rpc(d, "chat_poll", p_workspace=ws)["notifications"]] == []
    # Подсказка может прислать упоминание явно; посторонний uuid отбрасывается.
    m2 = call(a, "chat_send", p_conversation=g, p_body="без имени в тексте", p_mentions=[c, d])
    assert m2["mentions"] == [c]
    # Прочитал ленту — уведомления этого обсуждения прочитаны.
    rpc(b, "chat_messages", p_conversation=g)
    assert all(n["read"] for n in rpc(b, "chat_poll", p_workspace=ws)["notifications"])
    assert rpc(b, "chat_poll", p_workspace=ws, p_since=nb["cursor"])["unread"] == {}


def test_muted_conversation_still_reports_mentions():
    a, b = users(2)
    ws = workspace_with(a, {b: "employee"})
    set_name(b, "Борис")
    g = call(a, "chat_create_group", p_workspace=ws, p_title="Шумный", p_members=[b])["id"]
    rpc(b, "chat_set_muted", p_conversation=g, p_muted=True)
    cur = rpc(b, "chat_poll", p_workspace=ws)["cursor"]
    rpc(a, "chat_send", p_conversation=g, p_body="просто так")
    rpc(a, "chat_send", p_conversation=g, p_body="@Борис важно")
    fresh = rpc(b, "chat_poll", p_workspace=ws, p_since=cur)["fresh"]
    assert [f["body"] for f in fresh] == ["@Борис важно"]


def test_notifications_mark_read_and_privacy():
    a, b, other = users(3)
    ws = workspace_with(a, {b: "employee"})
    g = call(a, "chat_create_group", p_workspace=ws, p_title="G", p_members=[b])["id"]
    rpc(a, "chat_send", p_conversation=g, p_body=f"{email_of(b)} ага")
    notes = rpc(b, "chat_poll", p_workspace=ws)["notifications"]
    assert len(notes) == 2
    assert call(b, "notifications_mark_read", p_workspace=ws, p_ids=[notes[0]["id"]]) == 1
    assert call(a, "notifications_mark_read", p_workspace=ws, p_ids=[notes[1]["id"]]) == 0, "чужие не трогаются"
    assert rpc(b, "notifications_mark_read", p_workspace=ws) == 1
    denied("42501", rpc, other, "chat_poll", p_workspace=ws)


def test_mentions_in_notes_and_comments_notify_once():
    owner, b, c = users(3)
    ws = workspace_with(owner, {b: "employee", c: "employee"})
    set_name(b, "Вера")
    nid = note(owner, ws, "Позвонить клиенту, @Вера проверь счёт")
    got = rpc(b, "chat_poll", p_workspace=ws)["notifications"]
    assert [(n["kind"], n["entity_type"]) for n in got] == [("note_mention", "company")]
    assert got[0]["excerpt"].startswith("Позвонить") and got[0]["actor_id"] == owner
    # Правка: уведомляется только новый упомянутый.
    note(owner, ws, f"Позвонить клиенту, @Вера проверь счёт, {email_of(c)} подготовь договор", note_id=nid)
    assert len(rpc(b, "chat_poll", p_workspace=ws)["notifications"]) == 1
    assert [n["kind"] for n in rpc(c, "chat_poll", p_workspace=ws)["notifications"]] == ["note_mention"]
    # Автор, упомянувший себя, уведомления не получает.
    note(b, ws, "@Вера напоминание себе")
    assert len(rpc(b, "chat_poll", p_workspace=ws)["notifications"]) == 1
