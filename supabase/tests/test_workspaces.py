"""Customers 2.0, этап 3: Workspace, участники, приглашения, роли и права (docs/WORKSPACE_AND_PERMISSIONS.md).

Главное — security-тесты: чужой Workspace, повышение прав, удалённый участник."""

from concurrent.futures import ThreadPoolExecutor

from conftest import Client, confirmed_user, db
from crm_helpers import denied, email_of, make_user, one, q, rpc, users, workspace_with


def perms(uid, ws) -> set[str]:
    return {p for w in rpc(uid, "my_workspaces") if w["id"] == str(ws) for p in w["permissions"]}


# ------------------------------------------------------------------ создание и личный Workspace

def test_personal_workspace_is_idempotent_even_in_parallel():
    u = make_user()
    with ThreadPoolExecutor(8) as pool:
        ids = set(pool.map(lambda _: rpc(u, "ensure_personal_workspace"), range(8)))
    assert len(ids) == 1
    mine = rpc(u, "my_workspaces")
    assert [w["id"] for w in mine] == [str(ids.pop())]
    assert mine[0]["personal"] and mine[0]["role"] == "owner" and mine[0]["members"] == 1
    assert "workspace.delete" in mine[0]["permissions"]


def test_personal_workspace_takes_profile_name_from_lead_generator_settings():
    u = make_user()
    with db() as c:
        c.execute("insert into public.user_settings (user_id, key, value) values (%s, 'profile.name', '\"Мария\"')", (u,))
    rpc(u, "ensure_personal_workspace")
    assert rpc(u, "my_workspaces")[0]["name"] == "Мария"


def test_create_workspace_validates_and_limits():
    u = make_user()
    denied("22023", rpc, u, "create_workspace", p_name="   ")
    for i in range(20):
        rpc(u, "create_workspace", p_name=f"W{i}")
    denied("54000", rpc, u, "create_workspace", p_name="one too many")
    denied("42501", rpc, None, "create_workspace", p_name="anon")


def test_system_roles_match_the_permission_matrix():
    rows = q(make_user(), """select r.key, array_agg(rp.permission_key order by rp.permission_key)
                             from public.roles r join public.role_permissions rp on rp.role_id = r.id
                             where r.workspace_id is null group by r.key""")
    m = {k: set(v) for k, v in rows}
    assert len(m["owner"]) == 18
    assert m["admin"] == m["owner"] - {"workspace.delete", "ownership.transfer"}
    assert "members.manage" not in m["manager"] and "invitations.manage" in m["manager"]
    assert m["employee"] == {"records.view", "records.create", "records.edit_own", "members.view", "analytics.view"}
    assert m["viewer"] == {"records.view", "members.view", "analytics.view"}


# ------------------------------------------------------------------ чужой Workspace

def test_foreign_workspace_is_invisible_and_untouchable():
    a, b = users(2)
    ws = workspace_with(a)
    assert one(b, "select count(*) from public.workspaces where id = %s", (ws,)) == 0
    assert one(b, "select count(*) from public.workspace_members where workspace_id = %s", (ws,)) == 0
    assert one(b, "select count(*) from public.roles where workspace_id = %s", (ws,)) == 0
    assert rpc(b, "my_workspaces") == []
    denied("42501", rpc, b, "workspace_members_list", p_workspace=ws)
    denied("42501", rpc, b, "update_workspace", p_workspace=ws, p_name="hacked")
    denied("42501", rpc, b, "invite_member", p_workspace=ws, p_email=email_of(b), p_role="viewer")
    denied("42501", rpc, b, "delete_workspace", p_workspace=ws, p_confirm_name="x")
    denied("42501", rpc, b, "save_role", p_workspace=ws, p_key="spy", p_name="Spy", p_rank=1, p_permissions=[])
    # Профиль владельца чужого Workspace не виден.
    rpc(a, "ensure_personal_workspace")
    assert one(b, "select count(*) from public.user_profiles where user_id = %s", (a,)) == 0


def test_direct_writes_to_membership_tables_are_denied():
    a, b = users(2)
    ws = workspace_with(a, {b: "viewer"})
    owner_role = one(b, "select id from public.roles where workspace_id is null and key = 'owner'")
    for sql, params in [
        ("insert into public.workspace_members (workspace_id, user_id, role_id) values (%s, %s, %s)",
         (ws, make_user(), owner_role)),
        ("update public.workspace_members set role_id = %s where user_id = %s", (owner_role, b)),
        ("delete from public.workspace_members where workspace_id = %s", (ws,)),
        ("insert into public.workspaces (name) values ('direct')", None),
        ("update public.workspaces set name = 'x' where id = %s", (ws,)),
        ("insert into public.role_permissions (role_id, permission_key) values (%s, 'workspace.delete')",
         (one(b, "select role_id from public.workspace_members where user_id = %s", (b,)),)),
        ("insert into public.workspace_invitations (workspace_id, email_norm, role_id, token_hash) "
         "values (%s, 'x@example.com', %s, 'h')", (ws, owner_role)),
    ]:
        denied("42501", q, b, sql, params)


def test_invitation_token_hash_is_not_readable():
    a = make_user()
    ws = workspace_with(a)
    rpc(a, "invite_member", p_workspace=ws, p_email="guest@example.com", p_role="employee")
    assert one(a, "select count(*) from public.workspace_invitations where workspace_id = %s", (ws,)) == 1
    denied("42501", q, a, "select token_hash from public.workspace_invitations")


# ------------------------------------------------------------------ повышение прав

def test_employee_and_viewer_cannot_manage():
    owner, emp, viewer = users(3)
    ws = workspace_with(owner, {emp: "employee", viewer: "viewer"})
    assert perms(emp, ws) == {"records.view", "records.create", "records.edit_own", "members.view", "analytics.view"}
    for u in (emp, viewer):
        denied("42501", rpc, u, "invite_member", p_workspace=ws, p_email="x@example.com", p_role="viewer")
        denied("42501", rpc, u, "set_member_role", p_workspace=ws, p_user=owner, p_role="viewer")
        denied("42501", rpc, u, "remove_member", p_workspace=ws, p_user=owner)
        denied("42501", rpc, u, "update_workspace", p_workspace=ws, p_name="x")
    # Участники видят друг друга (members.view), но почту — нет.
    listing = rpc(viewer, "workspace_members_list", p_workspace=ws)
    assert {m["role"] for m in listing} == {"owner", "employee", "viewer"}
    assert all(m["email"] is None for m in listing if m["user_id"] != viewer)


def test_manager_cannot_invite_above_own_rank():
    owner, mgr = users(2)
    ws = workspace_with(owner, {mgr: "manager"})
    denied("42501", rpc, mgr, "invite_member", p_workspace=ws, p_email="boss@example.com", p_role="admin")
    denied("42501", rpc, mgr, "invite_member", p_workspace=ws, p_email="boss@example.com", p_role="owner")
    assert rpc(mgr, "invite_member", p_workspace=ws, p_email="peer@example.com", p_role="manager")["role"] == "manager"


def test_admin_cannot_touch_owner_or_equal_and_nobody_assigns_owner():
    owner, admin, admin2, emp = users(4)
    ws = workspace_with(owner, {admin: "admin", admin2: "admin", emp: "employee"})
    denied("42501", rpc, admin, "set_member_role", p_workspace=ws, p_user=owner, p_role="viewer")
    denied("42501", rpc, admin, "set_member_role", p_workspace=ws, p_user=admin2, p_role="viewer")
    denied("42501", rpc, admin, "set_member_role", p_workspace=ws, p_user=emp, p_role="admin")
    denied("42501", rpc, admin, "set_member_role", p_workspace=ws, p_user=admin, p_role="employee")
    denied("42501", rpc, admin, "remove_member", p_workspace=ws, p_user=admin2)
    denied("42501", rpc, owner, "set_member_role", p_workspace=ws, p_user=emp, p_role="owner")
    rpc(admin, "set_member_role", p_workspace=ws, p_user=emp, p_role="manager")
    assert "records.delete" in perms(emp, ws)
    rpc(owner, "set_member_role", p_workspace=ws, p_user=admin2, p_role="viewer")
    assert "members.manage" not in perms(admin2, ws)


def test_custom_role_cannot_grant_what_the_creator_lacks():
    owner, admin = users(2)
    ws = workspace_with(owner, {admin: "admin"})
    denied("42501", rpc, admin, "save_role", p_workspace=ws, p_key="sales", p_name="Продажи", p_rank=50,
           p_permissions=["records.view", "workspace.delete"])
    denied("42501", rpc, admin, "save_role", p_workspace=ws, p_key="sales", p_name="Продажи", p_rank=80,
           p_permissions=["records.view"])
    denied("22023", rpc, admin, "save_role", p_workspace=ws, p_key="owner", p_name="x", p_rank=1, p_permissions=[])
    rpc(admin, "save_role", p_workspace=ws, p_key="sales", p_name="Продажи", p_rank=50,
        p_permissions=["records.view", "records.create"])
    guest = make_user()
    inv = rpc(admin, "invite_member", p_workspace=ws, p_email=email_of(guest), p_role="sales")
    rpc(guest, "accept_invitation", p_token=inv["token"])
    assert perms(guest, ws) == {"records.view", "records.create"}


# ------------------------------------------------------------------ приглашения

def test_invitation_accept_rules():
    owner, guest, other = users(3)
    unconfirmed = make_user(confirmed=False)
    ws = workspace_with(owner)
    inv = rpc(owner, "invite_member", p_workspace=ws, p_email=f"  {email_of(guest).upper()} ", p_role="employee")
    assert inv["email"] == email_of(guest)
    with db() as c:  # в базе только sha256 токена
        assert c.execute("select count(*) from public.workspace_invitations where token_hash = %s",
                         (inv["token"],)).fetchone()[0] == 0
        assert c.execute("select count(*) from public.workspace_invitations "
                         "where token_hash = encode(sha256(convert_to(%s, 'UTF8')), 'hex')",
                         (inv["token"],)).fetchone()[0] == 1
    denied("42501", rpc, other, "accept_invitation", p_token=inv["token"])  # чужая почта
    denied("22023", rpc, guest, "accept_invitation", p_token="not-a-token")
    assert rpc(guest, "accept_invitation", p_token=inv["token"]) == ws
    denied("22023", rpc, guest, "accept_invitation", p_token=inv["token"])  # повторно
    denied("23505", rpc, owner, "invite_member", p_workspace=ws, p_email=email_of(guest), p_role="viewer")

    inv2 = rpc(owner, "invite_member", p_workspace=ws, p_email=email_of(unconfirmed), p_role="viewer")
    denied("42501", rpc, unconfirmed, "accept_invitation", p_token=inv2["token"])  # почта не подтверждена


def test_invitation_revoke_expire_resend_limits():
    owner, guest = users(2)
    ws = workspace_with(owner)
    inv = rpc(owner, "invite_member", p_workspace=ws, p_email=email_of(guest), p_role="viewer")
    denied("23505", rpc, owner, "invite_member", p_workspace=ws, p_email=email_of(guest), p_role="viewer")
    denied("54000", rpc, owner, "resend_invitation", p_invitation=inv["id"])  # меньше 10 минут
    with db() as c:
        c.execute("update public.workspace_invitations set last_sent_at = now() - interval '11 minutes' where id = %s",
                  (inv["id"],))
    again = rpc(owner, "resend_invitation", p_invitation=inv["id"])
    denied("22023", rpc, guest, "accept_invitation", p_token=inv["token"])  # старый токен не действует
    rpc(owner, "revoke_invitation", p_invitation=inv["id"])
    denied("22023", rpc, guest, "accept_invitation", p_token=again["token"])

    inv3 = rpc(owner, "invite_member", p_workspace=ws, p_email=email_of(guest), p_role="viewer")
    with db() as c:
        c.execute("update public.workspace_invitations set expires_at = now() - interval '1 second' where id = %s",
                  (inv3["id"],))
    denied("22023", rpc, guest, "accept_invitation", p_token=inv3["token"])
    with db() as c:
        c.execute("update public.workspace_invitations set sent_count = 5, last_sent_at = now() - interval '1 hour', "
                  "expires_at = now() + interval '1 day' where id = %s", (inv3["id"],))
    denied("54000", rpc, owner, "resend_invitation", p_invitation=inv3["id"])


def test_open_invitations_are_limited_to_50():
    owner = make_user()
    ws = workspace_with(owner)
    for i in range(50):
        rpc(owner, "invite_member", p_workspace=ws, p_email=f"many{i}@example.com", p_role="viewer")
    denied("54000", rpc, owner, "invite_member", p_workspace=ws, p_email="many50@example.com", p_role="viewer")


# ------------------------------------------------------------------ удалённый участник

def test_removed_member_loses_access_immediately_and_can_be_invited_again():
    owner, emp = users(2)
    ws = workspace_with(owner, {emp: "employee"})
    assert one(emp, "select private.has_perm(%s, 'records.view')", (ws,))
    rpc(owner, "remove_member", p_workspace=ws, p_user=emp)
    assert not one(emp, "select private.has_perm(%s, 'records.view')", (ws,))
    assert one(emp, "select count(*) from public.workspaces where id = %s", (ws,)) == 0
    assert rpc(emp, "my_workspaces") == []
    denied("42501", rpc, emp, "workspace_members_list", p_workspace=ws)
    inv = rpc(owner, "invite_member", p_workspace=ws, p_email=email_of(emp), p_role="viewer")
    rpc(emp, "accept_invitation", p_token=inv["token"])
    assert perms(emp, ws) == {"records.view", "members.view", "analytics.view"}


# ------------------------------------------------------------------ владелец

def test_workspace_always_keeps_an_owner():
    owner, admin = users(2)
    ws = workspace_with(owner, {admin: "admin"})
    denied("23514", rpc, owner, "leave_workspace", p_workspace=ws)
    denied("42501", rpc, admin, "transfer_ownership", p_workspace=ws, p_user=admin)
    rpc(owner, "transfer_ownership", p_workspace=ws, p_user=admin)
    assert {w["role"] for w in rpc(admin, "my_workspaces")} == {"owner"}
    assert {w["role"] for w in rpc(owner, "my_workspaces")} == {"admin"}
    rpc(owner, "leave_workspace", p_workspace=ws)
    assert rpc(owner, "my_workspaces") == []
    # Последний участник уходит — Workspace удаляется мягко.
    rpc(admin, "leave_workspace", p_workspace=ws)
    with db() as c:
        assert c.execute("select deleted_at is not null from public.workspaces where id = %s", (ws,)).fetchone()[0]


def test_delete_workspace_needs_name_and_permission():
    owner, admin = users(2)
    ws = workspace_with(owner, {admin: "admin"})
    name = rpc(owner, "my_workspaces")[0]["name"]
    denied("42501", rpc, admin, "delete_workspace", p_workspace=ws, p_confirm_name=name)
    denied("22023", rpc, owner, "delete_workspace", p_workspace=ws, p_confirm_name="wrong")
    rpc(owner, "delete_workspace", p_workspace=ws, p_confirm_name=name)
    assert rpc(owner, "my_workspaces") == [] and rpc(admin, "my_workspaces") == []
    assert not one(admin, "select private.has_perm(%s, 'records.view')", (ws,))


def test_deleting_the_account_of_a_sole_owner_soft_deletes_the_workspace():
    u = make_user()
    ws = rpc(u, "ensure_personal_workspace")
    with db() as c:
        c.execute("delete from auth.users where id = %s", (u,))
        assert c.execute("select deleted_at is not null, created_by from public.workspaces where id = %s",
                         (ws,)).fetchone() == (True, None)


# ------------------------------------------------------------------ через PostgREST, как приложение

def test_rest_api_as_the_app_sees_it():
    c, _ = confirmed_user()
    r = c.rpc("ensure_personal_workspace", {})
    assert r.status_code == 200, r.text
    ws = r.json()
    assert c.rpc("ensure_personal_workspace", {}).json() == ws
    r = c.rest("GET", "workspaces?select=id,name,personal")
    assert r.status_code == 200 and [w["id"] for w in r.json()] == [ws]
    r = c.rpc("my_workspaces", {})
    assert r.status_code == 200 and r.json()[0]["role"] == "owner"
    r = c.rest("POST", "workspace_members", json={"workspace_id": ws, "user_id": ws, "role_id": ws})
    assert r.status_code in (401, 403), r.text
    anon = Client()
    assert anon.rpc("ensure_personal_workspace", {}).status_code in (401, 403)
    assert anon.rest("GET", "workspaces").status_code in (401, 403)
