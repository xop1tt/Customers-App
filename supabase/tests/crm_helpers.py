"""Помощники для тестов Customers 2.0 (Workspace и CRM) на локальном стенде.

Пользователи создаются прямо в auth.users (как их создаёт Supabase Auth), а запросы выполняются под ролью
`authenticated` с утверждениями JWT в `request.jwt.claims` — ровно так PostgREST исполняет запрос
приложения. Поэтому здесь проверяются те же политики RLS и функции, что и в работе; часть тестов дополнительно
идёт через настоящий PostgREST (conftest.Client).
"""

from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from typing import Any

import psycopg
import pytest

from conftest import ENV, db


def make_user(email: str | None = None, confirmed: bool = True) -> str:
    uid = str(uuid.uuid4())
    email = email or f"crm-{uid[:10]}@example.com"
    with db() as c:
        c.execute(
            """insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                                       created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
               values ('00000000-0000-0000-0000-000000000000', %s, 'authenticated', 'authenticated', %s, '',
                       case when %s then now() end, now(), now(), '{"provider":"email"}', '{}')""",
            (uid, email, confirmed))
    return uid


def email_of(uid: str) -> str:
    with db() as c:
        return c.execute("select email from auth.users where id = %s", (uid,)).fetchone()[0]


@contextmanager
def acting(uid: str | None):
    """Транзакция от имени пользователя (None — anon). Ошибка откатывает транзакцию."""
    conn = psycopg.connect(host=ENV["PGHOST"], port=ENV["PGPORT"], user=ENV["PGUSER"], password=ENV["PGPASSWORD"],
                           dbname=ENV["STACK_DB"], autocommit=False)
    try:
        role = "authenticated" if uid else "anon"
        claims = {"sub": uid, "role": role, "email": email_of(uid) if uid else None, "aud": "authenticated"}
        conn.execute(f"set local role {role}")
        conn.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps(claims),))
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def q(uid: str | None, sql: str, params: Any = None) -> list[tuple]:
    with acting(uid) as c:
        cur = c.execute(sql, params)
        return cur.fetchall() if cur.description else []


def one(uid: str | None, sql: str, params: Any = None) -> Any:
    rows = q(uid, sql, params)
    assert len(rows) == 1, rows
    return rows[0][0]


def rpc(uid: str | None, name: str, **args) -> Any:
    names = ", ".join(f"{k} => %({k})s" for k in args)
    params = {k: (json.dumps(v) if isinstance(v, (dict, list)) and not _is_text_array(name, k) else v)
              for k, v in args.items()}
    return one(uid, f"select public.{name}({names})", params)


def _is_text_array(name: str, arg: str) -> bool:
    return (name, arg) in {("save_role", "p_permissions")}


def denied(sqlstate: str, fn, *a, **kw) -> psycopg.Error:
    with pytest.raises(psycopg.Error) as e:
        fn(*a, **kw)
    assert e.value.sqlstate == sqlstate, f"{e.value.sqlstate}: {e.value}"
    return e.value


def workspace_with(owner: str, members: dict[str, str] | None = None) -> str:
    """Workspace владельца с участниками {user_id: role} через настоящие приглашения."""
    ws = rpc(owner, "create_workspace", p_name=f"WS {uuid.uuid4().hex[:6]}")
    for user, role in (members or {}).items():
        inv = rpc(owner, "invite_member", p_workspace=ws, p_email=email_of(user), p_role=role)
        assert rpc(user, "accept_invitation", p_token=inv["token"]) == ws
    return ws


def users(n: int) -> list[str]:
    return [make_user() for _ in range(n)]
