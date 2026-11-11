# Workspace, участники, роли и разрешения

Статус: **реализовано** (этап 3): миграция `20261110120000_workspaces.sql`, тесты `supabase/tests/test_workspaces.py`, `tests/stack.rs`. Таблицы — [DATABASE_SCHEMA.md §3.1](DATABASE_SCHEMA.md), безопасность —
[SECURITY_MODEL.md](SECURITY_MODEL.md).

## 1. Модель

* Пользователь (`auth.users` + `user_profiles`) состоит в любом числе Workspace; в каждом — одна роль.
* Роль — набор разрешений. Системные роли — шаблоны (`roles.workspace_id IS NULL`, `is_system`), их
  разрешения меняются только миграцией. Свои роли — строки с `workspace_id` (создаёт `roles.manage`).
* Проверка в SQL — только по разрешению: `private.has_perm(workspace_id, 'records.edit')`. Названия ролей в
  проверках не используются; `rank` нужен только для правила «нельзя назначить роль выше своей».
* Активный Workspace хранится на устройстве (`device.json`: `activeWorkspace`), не в JWT: права всегда читаются
  из таблиц в момент запроса, поэтому удаление участника действует сразу.

## 2. Каталог разрешений

| Ключ | Что разрешает |
|---|---|
| `records.view` | читать компании, контакты, лиды CRM, сделки, задачи, ленту |
| `records.create` | создавать записи |
| `records.edit_own` | менять записи, где пользователь — автор, ответственный или исполнитель |
| `records.edit` | менять любые записи Workspace |
| `records.delete` | мягко удалять и восстанавливать записи |
| `records.export` | экспорт и массовая выгрузка (каждый экспорт — запись в `audit_log`) |
| `members.view` | видеть список участников |
| `members.manage` | менять роли участников (не выше своей), удалять участников |
| `invitations.manage` | приглашать, повторно отправлять и отзывать приглашения |
| `roles.manage` | создавать и менять свои роли (только из разрешений, которые есть у самого) |
| `workspace.manage` | название, валюта, настройки Workspace |
| `workspace.delete` | удалить Workspace |
| `ownership.transfer` | передать владение |
| `pipelines.manage` | воронки и этапы |
| `fields.manage` | пользовательские поля |
| `collections.manage` | общие коллекции Workspace (личные — может любой с `records.view`) |
| `analytics.view` | аналитика и отчёты |
| `audit.view` | журнал действий |

## 3. Системные роли

| Разрешение | Owner | Admin | Manager | Employee | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| records.view | ✓ | ✓ | ✓ | ✓ | ✓ |
| records.create | ✓ | ✓ | ✓ | ✓ | |
| records.edit_own | ✓ | ✓ | ✓ | ✓ | |
| records.edit | ✓ | ✓ | ✓ | | |
| records.delete | ✓ | ✓ | ✓ | | |
| records.export | ✓ | ✓ | ✓ | | |
| members.view | ✓ | ✓ | ✓ | ✓ | ✓ |
| members.manage | ✓ | ✓ | | | |
| invitations.manage | ✓ | ✓ | ✓ | | |
| roles.manage | ✓ | ✓ | | | |
| workspace.manage | ✓ | ✓ | | | |
| workspace.delete, ownership.transfer | ✓ | | | | |
| pipelines.manage, fields.manage, collections.manage | ✓ | ✓ | ✓ | | |
| analytics.view | ✓ | ✓ | ✓ | ✓ | ✓ |
| audit.view | ✓ | ✓ | | | |

`rank`: owner 100, admin 80, manager 60, employee 40, viewer 20. Своя роль получает `rank` не выше ранга создателя.

## 4. Сценарии (RPC, все — `security definer`, `set search_path = ''`, явная проверка `auth.uid()`)

| Сценарий | RPC | Проверки |
|---|---|---|
| Создать Workspace | `create_workspace(name)` | вход выполнен; создатель становится owner; создаются воронка-шаблон и встроенные коллекции; не больше 20 Workspace на пользователя |
| Первый Workspace | `ensure_personal_workspace()` | идемпотентно: уникальный индекс `workspaces_one_personal`; повтор возвращает существующий |
| Пригласить | `invite_member(ws, email, role)` | `invitations.manage`; роль с `rank` не выше своего; не больше 50 открытых приглашений; почта нормализована; возвращает токен один раз (sha256 в базе) |
| Повторно отправить | `resend_invitation(id)` | `invitations.manage`; не чаще раза в 10 минут и не больше 5 раз; продлевает срок; лимиты писем — `private.email_limits` |
| Отозвать | `revoke_invitation(id)` | `invitations.manage` |
| Принять | `accept_invitation(token)` | приглашение не отозвано, не принято, не истекло; `lower(auth.email()) = email_norm`; почта подтверждена (`auth.users.email_confirmed_at`); пользователь ещё не активный участник |
| Изменить роль | `set_member_role(ws, user, role)` | `members.manage`; нельзя менять себя; нельзя назначить и нельзя менять участника с `rank` ≥ своего (кроме owner); роль owner так не назначается |
| Удалить участника | `remove_member(ws, user)` | `members.manage`; ранг цели ниже своего; owner удалить нельзя |
| Передать владение | `transfer_ownership(ws, user)` | только текущий owner; цель — активный участник; в одной транзакции цель → owner, прежний → admin |
| Выйти | `leave_workspace(ws)` | любой участник, кроме последнего owner |
| Переключить | — (на устройстве) | список — `select` из `workspace_members` своих строк; данные — локальная база выбранного Workspace |
| Удалить Workspace | `delete_workspace(ws, confirm_name)` | `workspace.delete`; имя введено повторно; мягкое удаление, данные очищаются через 30 дней |

## 5. Инварианты (проверяет база, а не интерфейс)

1. В каждом не удалённом Workspace есть хотя бы один активный owner: отложенный триггер
   `private.workspace_has_owner()` на `workspace_members` (`constraint trigger … deferrable initially deferred`).
2. Прямые `insert/update/delete` в `workspace_members`, `roles`, `role_permissions`, `workspace_invitations` для
   `authenticated` запрещены (нет политик на запись) — только через RPC выше.
3. `role_permissions` своей роли ⊆ разрешений вызывающего (`roles.manage` не даёт выдать то, чего нет у себя).
4. `owner_id`/`assignee_id` любой записи — активный участник того же Workspace (триггер).
5. Удалённый участник (`status <> 'active'`) не проходит ни одну проверку `has_perm` — доступ пропадает с
   ближайшим запросом; его локальная копия удаляется при следующей синхронизации (сервер отвечает `403 not a member`).

## 6. Отличия реализации (этап 3)

* Приглашение не отправляет письмо: `invite_member` возвращает токен один раз, приложение показывает ссылку
  `leadgenerator://invite?token=…`, её передают приглашённому. Принять может только пользователь с
  той же подтверждённой почтой. Повторная отправка — не чаще раза в 10 минут, до 5 раз; открытых приглашений — до 50.
* Свои роли создаются RPC `save_role`; редактора ролей в интерфейсе пока нет (запланировано).
* Удалённый участник: сервер отвечает на отправку «not a member», Workspace пропадает из `my_workspaces`;
  приложение сохраняет неотправленные изменения в JSON-файл в папке учётной записи и удаляет локальную копию.
* У локальной учётной записи один локальный Workspace на устройстве (без участников и приглашений).
