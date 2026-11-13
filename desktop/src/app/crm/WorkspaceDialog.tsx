// Рабочее пространство: выбор и создание Workspace, участники и роли, приглашения, очередь синхронизации.

import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type { WsIncoming, WsInvitation, WsInvite, WsOp } from "../../api/types";
import { copyText } from "../../lib/platform";
import { fullRu, integer, shortRelative } from "../../lib/format";
import { Avatar, Button, Group, IconButton, Notice, Select, SettingRow, Tag, TextInput } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { confirmDialog } from "../../ui/overlay";
import { attempt, openSettings, refreshWorkspace, setSection, setState, toast, useStore } from "../../state/store";
import { openMarket } from "../../state/market";
import { useWsQuery } from "./useCrm";
import { PipelineEditor, RolesEditor } from "./Editors";
import { HandoverDialog, type HandoverTarget } from "./Handover";
import { AuditDialog } from "./AuditLog";
import { DangerZone } from "./Danger";
import { MyRights } from "./MyRights";
import { POSITIONS, assignable, canManageDepartments, isHr, isOwner } from "../../lib/positions";
import { departmentsOf } from "../../lib/departments";
import { useActor } from "../team/actor";
import { RequestDialog } from "../team/Requests";
import { usePresence } from "./Presence";
import { CustomFieldsEditor } from "./CustomFields";

const ROLES = [
  { value: "admin", label: "Администратор" },
  { value: "manager", label: "Менеджер" },
  { value: "employee", label: "Сотрудник" },
  { value: "viewer", label: "Наблюдатель" },
];

export function WorkspaceDialog() {
  const open = useStore((s) => s.workspaceOpen);
  if (!open) return null;
  return <WorkspacePanel />;
}

type Page = "overview" | "people" | "invite" | "structure" | "sync" | "danger";
type Tile = { id: string; title: string; hint: string; icon: string; tone: "blue" | "green" | "orange" | "purple" | "red"; tag?: string; show: boolean; go: () => void };

/** Окно на весь экран: управление рабочим пространством. Главная — плитки по задачам; плитка открывает свой раздел, «Назад» возвращает к плиткам. */
function WorkspacePanel() {
  const ws = useStore((s) => s.ws);
  const team = useStore((s) => s.team);
  const ref = useRef<HTMLElement>(null);
  const [editor, setEditor] = useState<"pipelines" | "roles" | "fields" | null>(null);
  const [audit, setAudit] = useState(false);
  const [page, setPage] = useState<Page | null>(null);
  const close = () => setState({ workspaceOpen: false });
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { prev?.focus?.(); };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".popover, .scrim")) { e.stopPropagation(); if (page) setPage(null); else close(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [page]);
  const current = ws?.workspaces.find((w) => w.id === ws.active);
  const perms = ws?.permissions ?? [];
  const showDanger = !!current && !current.personal;
  const canDanger = perms.includes("ownership.transfer") || perms.includes("workspace.delete");
  const done = async (p: Promise<unknown>) => { const r = await attempt(() => p); await refreshWorkspace(); return r; };
  const deps = departmentsOf(team).filter((d) => d.name).length;

  const groups: { title: string; tiles: Tile[] }[] = ws && current ? [
    { title: "Люди", tiles: [
      { id: "people", title: "Сотрудники", hint: "Список, роли, должности, статус онлайн.", icon: "users", tone: "blue", tag: `${integer(ws.members.length)} чел.`, show: true, go: () => setPage("people") },
      { id: "invite", title: "Приглашения", hint: "Позвать коллегу по почте или ссылке.", icon: "mail", tone: "blue", show: true, go: () => setPage("invite") },
      { id: "structure", title: "Отделы и должности", hint: "Структура и кто что может назначать.", icon: "building", tone: "blue", tag: `${integer(deps)} отд.`, show: true, go: () => setPage("structure") },
    ] },
    { title: "Настройка CRM", tiles: [
      { id: "pipelines", title: "Воронки и этапы", hint: "Названия, порядок, вероятность, тип этапа.", icon: "tree", tone: "green", show: true, go: () => setEditor("pipelines") },
      { id: "fields", title: "Свои поля", hint: "Дополнительные поля в карточках.", icon: "edit", tone: "green", show: true, go: () => setEditor("fields") },
      { id: "roles", title: "Роли и права", hint: "Свои роли с набором разрешений.", icon: "shield", tone: "green", show: true, go: () => setEditor("roles") },
      { id: "connectors", title: "Коннекторы", hint: "Подключения сторонних компаний.", icon: "link", tone: "purple", show: true, go: () => { close(); openMarket(); } },
    ] },
    { title: "Данные и безопасность", tiles: [
      { id: "sync", title: "Синхронизация", hint: "Состояние, очередь изменений, конфликты.", icon: "refresh", tone: "orange", tag: ws.pending > 0 ? `ждут отправки: ${integer(ws.pending)}` : "без очереди", show: true, go: () => setPage("sync") },
      { id: "audit", title: "Журнал действий", hint: "Кто и что менял.", icon: "history", tone: "orange", show: perms.includes("audit.view"), go: () => setAudit(true) },
      { id: "export", title: "Экспорт и копии", hint: "Выгрузка CRM, резервные копии.", icon: "download", tone: "orange", show: true, go: () => { close(); openSettings("data"); } },
      { id: "danger", title: canDanger ? "Опасная зона" : "Выход", hint: canDanger ? "Передача владения, выход, удаление." : "Покинуть рабочее пространство.", icon: "alert", tone: "red", show: showDanger, go: () => setPage("danger") },
    ] },
  ] : [];
  const TITLES: Record<Page, string> = { overview: "Пространства", people: "Сотрудники", invite: "Приглашения", structure: "Отделы и должности", sync: "Синхронизация", danger: canDanger ? "Опасная зона" : "Выход" };

  return (
    <aside ref={ref} tabIndex={-1} className="ws-panel" role="dialog" aria-label="Рабочее пространство">
      <header className="ws-panel-head">
        {page && <IconButton icon="chevronLeft" tip="Назад к плиткам" onClick={() => setPage(null)} />}
        <Avatar name={current?.name ?? "?"} size={30} />
        <span className="col grow" style={{ gap: 0, minWidth: 0 }}>
          <strong className="ellipsis">{page ? TITLES[page] : current?.name ?? "Рабочее пространство"}</strong>
          <span className="faint ellipsis" style={{ fontSize: "var(--fs-sm)" }}>{page ? current?.name : "Рабочее пространство"}{current ? ` · ${current.roleName}` : ""}</span>
        </span>
        {ws?.pending ? <Tag tone="orange">Ждут отправки: {integer(ws.pending)}</Tag> : null}
        <IconButton icon="x" tip="Закрыть" onClick={close} />
      </header>
      <div className="ws-panel-body">
        {!ws ? (
          <Notice tone="error">База рабочего пространства не открылась. Проверьте журнал ошибок в настройках «Отчёты».</Notice>
        ) : !page ? (
          <>
            <IncomingCards done={done} />
            {current && (
              <div className="ws-stats" aria-label="Сводка">
                <div className="ws-stat"><strong>{integer(ws.members.length)}</strong><span className="faint">участников</span></div>
                <div className="ws-stat"><strong>{integer(deps)}</strong><span className="faint">отделов</span></div>
                <div className="ws-stat"><strong>{current.roleName}</strong><span className="faint">ваша роль</span></div>
                <div className="ws-stat"><strong>{ws.pending > 0 ? integer(ws.pending) : "0"}</strong><span className="faint">ждут отправки</span></div>
              </div>
            )}
            {groups.map((g) => (
              <section key={g.title} className="ws-tiles-group" aria-label={g.title}>
                <h4 className="ws-tiles-title">{g.title}</h4>
                <div className="ws-tiles">
                  {g.tiles.filter((t) => t.show).map((t) => (
                    <button key={t.id} type="button" className={`ws-tile ${t.tone}`} onClick={t.go}>
                      <span className="ws-tile-icon"><Icon name={t.icon as never} size={16} /></span>
                      <strong>{t.title}</strong>
                      <span className="faint ws-tile-hint">{t.hint}</span>
                      {t.tag && <span className="faint ws-tile-tag">{t.tag}</span>}
                    </button>
                  ))}
                </div>
              </section>
            ))}
            <p className="ws-tiles-more"><button type="button" className="link" onClick={() => setPage("overview")}>Другие рабочие пространства, новое пространство и код приглашения</button></p>
          </>
        ) : (
          <>
            {page === "overview" && <Overview done={done} />}
            {page === "people" && <><MyRights /><Members /></>}
            {page === "invite" && <InviteOrRequest />}
            {page === "structure" && <Structure />}
            {page === "sync" && <SyncQueue />}
            {page === "danger" && showDanger && (
              <>
                <DangerZone />
                <Group title="Выход">
                  <SettingRow title="Покинуть рабочее пространство" hint="Копия данных этого рабочего пространства будет удалена с устройства. Владелец не может выйти, пока не передаст владение.">
                    <Button small variant="danger" onClick={async () => {
                      if (await confirmDialog({ title: `Покинуть «${current!.name}»?`, message: "Доступ к данным пропадёт. Вернуться можно только по новому приглашению.", confirm: "Покинуть", danger: true })) void done(api.wsLeave());
                    }}>Покинуть</Button>
                  </SettingRow>
                </Group>
              </>
            )}
          </>
        )}
      </div>
      {editor === "pipelines" && <PipelineEditor onClose={() => setEditor(null)} />}
      {editor === "fields" && <CustomFieldsEditor onClose={() => setEditor(null)} />}
      {editor === "roles" && <RolesEditor onClose={() => setEditor(null)} />}
      {audit && <AuditDialog onClose={() => setAudit(false)} />}
    </aside>
  );
}

/** Входящие приглашения: адресованы почте вашей учётной записи, принимаются кнопкой, без ссылки (ADR-082). */
function IncomingCards({ done }: { done: (p: Promise<unknown>) => Promise<unknown> }) {
  const list = useStore((s) => s.incoming);
  if (!list.length) return null;
  const accept = async (i: WsIncoming) => { const r = await done(api.wsAcceptIncoming(i.id)); if (r) toast(`Вы присоединились к «${i.workspaceName}»`, "success"); };
  const decline = async (i: WsIncoming) => {
    if (!(await confirmDialog({ title: `Отклонить приглашение в «${i.workspaceName}»?`, message: "Руководитель сможет пригласить вас снова.", confirm: "Отклонить", danger: true }))) return;
    await done(api.wsDeclineIncoming(i.id));
  };
  return (
    <section className="ws-incoming" aria-label="Приглашения">
      <h4>Вас приглашают · {integer(list.length)}</h4>
      {list.map((i) => (
        <div key={i.id} className="ws-incoming-card">
          <span className="col grow" style={{ gap: 0, minWidth: 0 }}>
            <strong className="ellipsis">{i.workspaceName}</strong>
            <span className="faint">{i.invitedByName} приглашает вас на роль «{i.roleName}». Действует до {fullRu(i.expiresAt)}.</span>
          </span>
          <Button small variant="primary" onClick={() => void accept(i)}>Принять</Button>
          <Button small variant="ghost" onClick={() => void decline(i)}>Отклонить</Button>
        </div>
      ))}
    </section>
  );
}

/** Обзор: выбор и создание пространства, переименование, приглашение по коду, сводка. */
function Overview({ done }: { done: (p: Promise<unknown>) => Promise<unknown> }) {
  const ws = useStore((s) => s.ws)!;
  const team = useStore((s) => s.team);
  const [name, setName] = useState("");
  const [rename, setRename] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const current = ws.workspaces.find((w) => w.id === ws.active);
  const perms = ws.permissions;
  const deps = departmentsOf(team).filter((d) => d.name).length;
  return (
    <Group title="Рабочее пространство" note={ws.isCloud ? "Данные CRM общие для участников и синхронизируются через облако." : "Локальная учётная запись: рабочее пространство хранится только на этом компьютере. Совместная работа — в облачной учётной записи."}>
      {current && (
        <div className="ws-stats" aria-label="Сводка">
          <div className="ws-stat"><strong>{integer(ws.members.length)}</strong><span className="faint">участников</span></div>
          {ws.isCloud && <div className="ws-stat"><strong>{integer(deps)}</strong><span className="faint">отделов</span></div>}
          <div className="ws-stat"><strong>{current.roleName}</strong><span className="faint">ваша роль</span></div>
          {ws.pending > 0 && <div className="ws-stat"><strong>{integer(ws.pending)}</strong><span className="faint">ждут отправки</span></div>}
        </div>
      )}
      <SettingRow title="Текущий">
        <Select value={ws.active ?? ""} width={240} onChange={(id) => void done(api.wsSwitch(id))} options={ws.workspaces.map((w) => ({ value: w.id, label: w.name, hint: w.roleName }))} />
      </SettingRow>
      {current && perms.includes("workspace.manage") && (
        <SettingRow title="Название">
          {rename === null ? <Button small icon="edit" onClick={() => setRename(current.name)}>Переименовать</Button> : (
            <div className="row" style={{ gap: 6 }}>
              <TextInput value={rename} onChange={setRename} maxLength={120} aria-label="Новое название" />
              <Button small variant="primary" onClick={() => void done(api.wsRenameWorkspace(rename)).then(() => setRename(null))}>Сохранить</Button>
            </div>
          )}
        </SettingRow>
      )}
      <SettingRow title="Новое рабочее пространство" hint="Например, для отдельной команды или компании. Вы станете владельцем.">
        <div className="row" style={{ gap: 6 }}>
          <TextInput value={name} onChange={setName} maxLength={120} placeholder="Название" aria-label="Название нового рабочего пространства" />
          <Button small icon="plus" disabled={!name.trim()} onClick={() => void done(api.wsCreateWorkspace(name)).then((r) => { if (r) setName(""); })}>Создать</Button>
        </div>
      </SettingRow>
      {ws.isCloud && (
        <SettingRow title="Приглашение" hint="Вставьте ссылку или код из приглашения.">
          <div className="row" style={{ gap: 6 }}>
            <TextInput value={token} onChange={setToken} placeholder="Ссылка или код из приглашения" aria-label="Код приглашения" />
            <Button small disabled={!token.trim()} onClick={() => void done(api.wsAcceptInvitation(token)).then((r) => { if (r) { setToken(""); toast("Вы присоединились к рабочему пространству", "success"); } })}>Принять</Button>
          </div>
        </SettingRow>
      )}
    </Group>
  );
}

/** Структура: должности (справочник с правами, ADR-079) и отделы. Менять их — на странице «Сотрудники», здесь видно, кто что может. */
function Structure() {
  const team = useStore((s) => s.team);
  const actor = useActor();
  const mine = assignable(actor);
  const manageDeps = canManageDepartments(actor);
  const deps = departmentsOf(team);
  const open = () => { setState({ workspaceOpen: false }); setSection("people"); };
  return (
    <Group title="Структура" note="Должность задаёт роль и права в рабочем пространстве. Отделы — группы сотрудников; создавать и закрывать их могут владелец, заместители и руководители.">
      <SettingRow title="Отделы" hint={deps.filter((d) => d.name).length ? deps.filter((d) => d.name).map((d) => `${d.name} (${d.members.length})`).join(", ") : "Отделов пока нет."}>
        <Button small icon="users" onClick={() => open()}>{manageDeps ? "Управлять отделами" : "Открыть отделы"}</Button>
      </SettingRow>
      <SettingRow title="Ваша должность" hint={`${actor?.title ? actor.title : isOwner(actor) ? "Владелец" : "Не назначена"}. ${mine.length ? `Можете назначать: ${mine.map((p) => p.name).join(", ")}` : "Назначать должности вы не можете"}`} />
      <div className="col" style={{ gap: 4, marginTop: 8 }} role="list" aria-label="Должности и их возможности">
        {POSITIONS.map((p) => (
          <div key={p.key} role="listitem" className="ws-position">
            <span className="grow ellipsis"><strong>{p.name}</strong><span className="faint"> · {p.hint}</span></span>
            {p.deputy && <Tag tone="blue">Заместитель</Tag>}
            {p.hr && <Tag tone="orange">Кадры</Tag>}
            {p.lead && !p.deputy && <Tag>Руководящая</Tag>}
            {mine.some((m) => m.key === p.key) && <Icon name="check" size={14} />}
          </div>
        ))}
      </div>
    </Group>
  );
}

function Members() {
  const ws = useStore((s) => s.ws)!;
  const { data: rolesData } = useWsQuery(() => api.wsRoles().catch(() => null), []);
  const roleOptions = rolesData?.roles.length ? rolesData.roles.filter((r) => r.key !== "owner").map((r) => ({ value: r.key, label: r.name })) : ROLES;
  const rankOf = (key: string) => rolesData?.roles.find((r) => r.key === key)?.rank ?? ({ admin: 80, manager: 60, employee: 40, viewer: 20 } as Record<string, number>)[key] ?? 0;
  const actor = useActor();
  const manage = ws.permissions.includes("members.manage") && !isHr(actor);
  const online = new Set(usePresence().map((p) => p.user_id));
  const myRank = ws.workspaces.find((w) => w.id === ws.active)?.rank ?? 0;
  const canHand = ws.permissions.includes("records.edit");
  const [hand, setHand] = useState<{ target: HandoverTarget; leaving: boolean } | null>(null);
  return (
    <Group title={`Участники · ${integer(ws.members.length)}`}>
      <ul className="ws-member-list">
        {ws.members.map((m) => {
          const editable = manage && m.userId !== ws.me && m.rank < myRank && m.role !== "owner";
          return (
            <li key={m.userId} className="ws-member">
              <Avatar name={m.displayName} src={m.avatarPath} size={28} />
              <span className="col grow" style={{ gap: 0, minWidth: 0 }}>
                <span className="ellipsis">{(m.userId === ws.me || online.has(m.userId)) && <span className="presence-dot" title="Онлайн" />}{m.displayName}{m.userId === ws.me ? <span className="faint"> · вы</span> : null}</span>
                {m.email && <span className="faint ellipsis" style={{ fontSize: "var(--fs-sm)" }}>{m.email}</span>}
              </span>
              {editable ? (
                <>
                  <Select small value={m.role} width={150} onChange={(role) => void attempt(() => api.wsSetMemberRole(m.userId, role)).then(() => refreshWorkspace())}
                    options={roleOptions.filter((r) => rankOf(r.value) < myRank)} />
                  {canHand && <IconButton icon="users" tip="Передать записи коллеге" onClick={() => setHand({ target: { userId: m.userId, displayName: m.displayName }, leaving: false })} />}
                  <IconButton icon="x" tip="Удалить из рабочего пространства" onClick={() => setHand({ target: { userId: m.userId, displayName: m.displayName }, leaving: true })} />
                </>
              ) : <Tag>{m.roleName}</Tag>}
            </li>
          );
        })}
      </ul>
      {hand && <HandoverDialog from={hand.target} leaving={hand.leaving} onClose={() => setHand(null)} onRemove={async () => { await api.wsRemoveMember(hand.target.userId); }} />}
    </Group>
  );
}

/** Отдел кадров приглашает только запросом: выполняет владелец или заместитель (ADR-079). */
function InviteOrRequest() {
  const actor = useActor();
  const team = useStore((s) => s.team);
  const [asking, setAsking] = useState(false);
  if (!isHr(actor)) return <Invite />;
  const me = team.find((m) => m.user_id === actor?.user_id);
  return (
    <Group title="Оформление сотрудника" note="Создать учётную запись может владелец рабочего пространства или его заместитель. Отправьте запрос: в нём почта, имя профиля и должность нового сотрудника.">
      <div><Button variant="primary" icon="mail" disabled={!me} onClick={() => setAsking(true)}>Запросить оформление</Button></div>
      {asking && me && <RequestDialog kind="hire" author={me} team={team} onClose={() => setAsking(false)} />}
    </Group>
  );
}

function Invite() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("employee");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<WsInvite | null>(null);
  const [version, setVersion] = useState(0);
  const send = async () => {
    setBusy(true);
    const r = await attempt(() => api.wsInvite(email.trim(), role));
    setBusy(false);
    if (r) { setSent(r); setEmail(""); setVersion((v) => v + 1); }
  };
  return (
    <Group title="Пригласить" note="Если у человека есть учётная запись с этой почтой, он увидит приглашение в приложении (красный значок у учётной записи). Ссылку можно передать и самому: она действует 7 дней и показывается один раз.">
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <TextInput value={email} onChange={setEmail} type="email" placeholder="почта коллеги" aria-label="Почта приглашённого" wrapClass="grow" />
        <Select value={role} onChange={setRole} options={ROLES} width={160} />
        <Button variant="primary" busy={busy} disabled={!email.includes("@")} onClick={() => void send()}>Пригласить</Button>
      </div>
      {sent && (
        <Notice tone="ok" action={<Button small icon="copy" onClick={() => void copyText(sent.link).then(() => toast("Ссылка скопирована", "success"))}>Копировать</Button>}>
          Приглашение для {sent.email} {sent.id ? "готово" : "создано"}. <span className="selectable mono">{sent.link}</span>
        </Notice>
      )}
      <OpenInvitations version={version} onLink={(r) => setSent(r)} onChange={() => setVersion((v) => v + 1)} />
    </Group>
  );
}

/** Открытые приглашения: ждут ответа, можно отправить ещё раз (новая ссылка) или отозвать. */
function OpenInvitations({ version, onLink, onChange }: { version: number; onLink: (r: WsInvite) => void; onChange: () => void }) {
  const { data } = useWsQuery(() => api.wsInvitations().catch(() => [] as WsInvitation[]), [version]);
  const list = data ?? [];
  if (!list.length) return null;
  return (
    <div className="col" style={{ gap: 6, marginTop: 10 }}>
      <div className="faint">Ждут ответа · {integer(list.length)}</div>
      <ul className="ws-member-list" aria-label="Открытые приглашения">
        {list.map((i) => {
          const expired = Date.parse(i.expiresAt) < Date.now();
          return (
            <li key={i.id} className="ws-member">
              <span className="col grow" style={{ gap: 0, minWidth: 0 }}>
                <span className="ellipsis">{i.email}</span>
                <span className="faint ellipsis" style={{ fontSize: "var(--fs-sm)" }}>{i.roleName} · {expired ? "срок истёк" : `действует до ${fullRu(i.expiresAt)}`} · отправлено: {i.sentCount}</span>
              </span>
              {expired && <Tag tone="orange">Истекло</Tag>}
              <Button small icon="refresh" onClick={async () => { const r = await attempt(() => api.wsResendInvitation(i.id)); if (r) { onLink(r); onChange(); } }}>Отправить ещё раз</Button>
              <IconButton icon="x" tip="Отозвать приглашение" onClick={async () => {
                if (await confirmDialog({ title: `Отозвать приглашение для ${i.email}?`, message: "Ссылка перестанет работать. Пригласить можно будет заново.", confirm: "Отозвать", danger: true })) {
                  await attempt(() => api.wsRevokeInvitation(i.id));
                  onChange();
                }
              }} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SyncQueue() {
  const ws = useStore((s) => s.ws)!;
  const { data } = useWsQuery(() => api.wsConflicts(), []);
  const rejected: WsOp[] = data?.rejected ?? [];
  return (
    <Group title="Синхронизация">
      <SettingRow title="Состояние" hint={ws.error ?? (ws.lastSync ? `Последняя: ${shortRelative(ws.lastSync)}` : ws.isCloud ? "Ещё не выполнялась" : "Только на этом устройстве")}>
        <div className="row" style={{ gap: 8 }}>
          {ws.pending > 0 && <Tag tone="orange">Ждут отправки: {integer(ws.pending)}</Tag>}
          {ws.conflicts > 0 && <Tag tone="orange">Конфликтов: {integer(ws.conflicts)}</Tag>}
          {ws.isCloud && <Button small icon="refresh" busy={ws.syncing} onClick={() => void attempt(() => api.wsSyncNow()).then(() => refreshWorkspace())}>Синхронизировать</Button>}
        </div>
      </SettingRow>
      {rejected.length > 0 && (
        <Notice tone="warn" action={<Button small onClick={() => void attempt(() => api.wsDismissRejected()).then(() => refreshWorkspace())}>Понятно</Button>}>
          Сервер отклонил {integer(rejected.length)} изм.: {[...new Set(rejected.map((o) => o.last_error ?? "нет прав"))].slice(0, 2).join("; ")}. Записи перечитаны с сервера.
        </Notice>
      )}
    </Group>
  );
}
