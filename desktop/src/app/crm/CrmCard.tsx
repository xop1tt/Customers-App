// Карточка CRM-записи в панели сведений: поля, связанные записи, лента (заметки, события, комментарии),
// задачи, история этапов сделки и конфликты синхронизации. Новая запись создаётся здесь же.

import { CustomFieldsSection } from "./CustomFields";
import { WatchingNow } from "./Presence";
import { AttachmentsSection } from "./Attachments";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type { CrmRecord, WsCard, WsConflict } from "../../api/types";
import { byTable, can, cellText, CURRENCIES, ENUMS, ENTITIES, type EntityMeta, type FieldMeta, fromInput, type Lookup, memberName, STATUS_TONE, toInput } from "../../lib/crm";
import { fullRu, money, shortRelative } from "../../lib/format";
import { Button, EmptyState, Field, IconButton, Notice, Select, Spinner, Tabs, Tag, TextArea, TextInput } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { confirmDialog } from "../../ui/overlay";
import { attempt, openRecord, toast, useStore } from "../../state/store";
import { actionsFor, actionUrl } from "../../state/market";
import { openLink } from "../../state/actions";
import { defaultStage, stagesOf, useLookup, useWsQuery } from "./useCrm";

type Tab = "overview" | "feed" | "tasks" | "history";

export function CrmCard() {
  const record = useStore((s) => s.record);
  const e = record ? byTable(record.table) : undefined;
  if (!record || !e) return <div className="inspector-body"><EmptyState icon="note" title="Выберите запись">Здесь появятся поля, связанные записи, задачи и лента.</EmptyState></div>;
  if (record.id === "new") return <NewRecord key={`new-${e.table}`} e={e} />;
  return <RecordCard key={record.id} e={e} id={record.id} />;
}

// ---------------------------------------------------------------- поля

function FieldInput({ f, e, value, lk, onCommit, disabled, pipeline }: { f: FieldMeta; e: EntityMeta; value: unknown; lk: Lookup; onCommit: (v: unknown) => void; disabled?: boolean; pipeline?: unknown }) {
  const [text, setText] = useState(toInput(f.kind, value));
  useEffect(() => setText(toInput(f.kind, value)), [value, f.kind]);
  const commit = () => { if (text !== toInput(f.kind, value)) onCommit(fromInput(f.kind, text)); };
  const none = { value: "", label: "—" };
  const select = (options: { value: string; label: string }[], allowEmpty = true) => (
    <Select value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(v) => onCommit(v || null)} options={allowEmpty ? [none, ...options] : options} width="100%" />
  );
  switch (f.kind) {
    case "member": return select(lk.members.map((m) => ({ value: m.userId, label: m.displayName })));
    case "enum": return select(Object.entries(ENUMS[`${e.table}.${f.name}`] ?? {}).map(([v, label]) => ({ value: v, label })), false);
    case "currency": return select(CURRENCIES.map((c) => ({ value: c, label: c })), false);
    case "company": return select([...lk.companies.values()].filter((c) => !c.deleted_at).map((c) => ({ value: c.id, label: String(c.name ?? "") })));
    case "pipeline": return select([...lk.pipelines.values()].map((p) => ({ value: p.id, label: String(p.name ?? "") })), false);
    case "stage": return select(stagesOf(lk, pipeline).map((s) => ({ value: s.id, label: String(s.name ?? "") })), false);
    case "long": return <TextArea value={text} onChange={setText} onBlur={commit} disabled={disabled} rows={3} />;
    default:
      return (
        <TextInput
          value={text}
          onChange={setText}
          onBlur={commit}
          onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }}
          disabled={disabled}
          type={f.kind === "date" ? "date" : f.kind === "datetime" ? "datetime-local" : "text"}
          inputMode={f.kind === "money" ? "decimal" : undefined}
          placeholder={f.kind === "list" ? "через запятую" : undefined}
        />
      );
  }
}

function Fields({ e, rec, lk, editable, onChange }: { e: EntityMeta; rec: Record<string, unknown>; lk: Lookup; editable: boolean; onChange: (field: string, v: unknown) => void }) {
  return (
    <div className="crm-fields">
      {e.fields.map((f) => {
        if (f.name === "lost_reason" && rec.status !== "lost") return null;
        return (
          <Field key={f.name} label={f.label + (f.required ? " *" : "")}>
            <FieldInput f={f} e={e} value={rec[f.name]} lk={lk} disabled={!editable} pipeline={rec.pipeline_id}
              onCommit={(v) => {
                // Смена воронки сбрасывает этап на первый этап новой воронки.
                if (f.name === "pipeline_id") {
                  const first = stagesOf(lk, v)[0];
                  onChange("pipeline_id", v);
                  if (first) onChange("stage_id", first.id);
                } else onChange(f.name, v);
              }} />
          </Field>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- новая запись

function NewRecord({ e }: { e: EntityMeta }) {
  const ws = useStore((s) => s.ws);
  const lk = useLookup();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [similar, setSimilar] = useState<CrmRecord[]>([]);
  const base = useMemo(() => {
    const d: Record<string, unknown> = {};
    if (e.type === "deal") Object.assign(d, defaultStage(lk) ?? {}, { currency: ws?.workspaces.find((w) => w.id === ws.active)?.defaultCurrency ?? "RUB" });
    if (e.type === "task") Object.assign(d, { status: "todo", priority: "normal", assignee_id: ws?.me });
    if (e.type === "crm_lead") d.status = "new";
    return d;
  }, [e.type, lk, ws]);
  const rec = { ...base, ...draft };

  // «Похоже на…» до сохранения (те же ключи, что у ядра: телефон, почта, домен, название).
  const keyText = JSON.stringify([rec.name, rec.title, rec.first_name, rec.last_name, rec.phones, rec.emails, rec.website, rec.inn]);
  useEffect(() => {
    if (!["company", "contact"].includes(e.type)) return;
    const t = setTimeout(() => {
      void api.wsDuplicates(e.table, rec).then(setSimilar, () => setSimilar([]));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyText, e.table, e.type]);

  const create = async () => {
    setBusy(true);
    const saved = await attempt(() => api.wsSave(e.table, null, rec));
    setBusy(false);
    if (saved) { toast(`${e.one}: создано`, "success"); openRecord(e.table, saved.id); }
  };

  return (
    <div className="inspector-body">
      <div className="insp-head">
        <div className="row insp-tags"><Tag>{e.emoji} {e.one}</Tag></div>
        <h3 className="insp-title">Новая запись</h3>
      </div>
      <div className="insp-scroll">
        <div className="insp-sections">
          {similar.length > 0 && (
            <Notice tone="warn">
              Похоже на: {similar.slice(0, 3).map((s, i) => (
                <span key={s.id}>{i > 0 ? ", " : ""}<a onClick={() => openRecord(e.table, s.id)}>{e.title(s)}</a></span>
              ))}
            </Notice>
          )}
          <Fields e={e} rec={rec} lk={lk} editable onChange={(f, v) => setDraft((d) => ({ ...d, [f]: v }))} />
          <div className="row" style={{ gap: 8 }}>
            <Button variant="primary" busy={busy} onClick={() => void create()}>Создать</Button>
            <Button variant="ghost" onClick={() => openRecord(e.table, null)}>Отмена</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- карточка

function RecordCard({ e, id }: { e: EntityMeta; id: string }) {
  const ws = useStore((s) => s.ws);
  const lk = useLookup();
  const { data, error } = useWsQuery(() => api.wsCard(e.table, id), [e.table, id]);
  const [tab, setTab] = useState<Tab>("overview");
  const market = useStore((st) => st.marketInstalled);
  if (error) return <div className="inspector-body"><EmptyState icon="alert" title="Запись не открылась">{error}</EmptyState></div>;
  if (!data) return <div className="inspector-body"><div className="boot"><Spinner size={18} /></div></div>;
  const r = data.record;
  const perms = ws?.permissions ?? [];
  const editable = !r.deleted_at && can(perms, "edit", r, ws?.me);
  const deletable = can(perms, "delete");
  const save = (fields: Record<string, unknown>) => void attempt(() => api.wsSave(e.table, id, fields));
  const status = typeof r.status === "string" ? (ENUMS[`${e.table}.status`]?.[r.status] ?? r.status) : null;

  const remove = async () => {
    if (!(await confirmDialog({ title: `Удалить: ${e.title(r)}?`, message: "Запись попадёт в корзину Workspace, её можно восстановить.", confirm: "Удалить", danger: true }))) return;
    await attempt(() => api.wsDelete(e.table, id));
  };

  const tabs: { id: Tab; label: string }[] = [{ id: "overview", label: "Обзор" }];
  if (e.type !== "task") tabs.push({ id: "feed", label: "Лента" }, { id: "tasks", label: `Задачи${data.tasks?.length ? ` · ${data.tasks.length}` : ""}` });
  if (e.type === "deal") tabs.push({ id: "history", label: "Этапы" });

  return (
    <div className="inspector-body">
      <div className="insp-head">
        <div className="row insp-tags">
          <Tag>{e.emoji} {e.one}</Tag>
          {status && <Tag tone={STATUS_TONE[String(r.status)] ?? "gray"}>{status}</Tag>}
          {e.type === "deal" && typeof r.amount === "number" && <Tag tone="blue">{money(r.amount, String(r.currency ?? "RUB"))}</Tag>}
          {r.archived_at && <Tag icon="archive">В архиве</Tag>}
          {r.deleted_at && <Tag tone="red" icon="trash">Удалено</Tag>}
        </div>
        <h3 className="insp-title selectable">{e.title(r)}</h3>
        <WatchingNow type={e.type} id={r.id} />
        <div className="row insp-actions">
          {e.type === "task" && editable && (
            <IconButton icon="check" tip={r.status === "done" ? "Вернуть в работу" : "Выполнено"} active={r.status === "done"} onClick={() => save({ status: r.status === "done" ? "todo" : "done" })} />
          )}
          {"archived_at" in r && editable && <IconButton icon="archive" tip={r.archived_at ? "Вернуть из архива" : "В архив"} active={!!r.archived_at} onClick={() => save({ archived_at: r.archived_at ? null : new Date().toISOString() })} />}
          {!r.deleted_at && actionsFor(market, e.type).map(({ app, action }) => (
            <Button key={`${app.app_id}:${action.id}`} small variant="ghost" title={`${app.name}: ${action.label}`} onClick={() => {
              const url = actionUrl(action, app.scopes, { id, type: e.type, title: e.title(r) });
              if (url) void openLink(url); else toast("Адрес кнопки интеграции некорректен.", "error");
            }}><span aria-hidden>{app.icon}</span> {action.label}</Button>
          ))}
          <span className="grow" />
          {deletable && (r.deleted_at
            ? <Button small icon="refresh" onClick={() => void attempt(() => api.wsRestore(e.table, id))}>Восстановить</Button>
            : <IconButton icon="trash" tip="Удалить" onClick={() => void remove()} />)}
          <IconButton icon="x" tip="Закрыть" onClick={() => openRecord(e.table, null)} />
        </div>
      </div>
      {tabs.length > 1 && <Tabs value={tab} onChange={setTab} tabs={tabs} />}
      <div className="insp-scroll">
        <div className="insp-sections">
          {data.conflicts.map((c) => <ConflictNotice key={c.id} c={c} e={e} lk={lk} />)}
          {tab === "overview" && <Overview e={e} data={data} lk={lk} editable={editable} save={save} />}
          {tab === "feed" && <Feed e={e} data={data} lk={lk} />}
          {tab === "tasks" && <Tasks e={e} id={id} tasks={data.tasks ?? []} lk={lk} />}
          {tab === "history" && <StageHistory data={data} lk={lk} />}
        </div>
      </div>
    </div>
  );
}

function ConflictNotice({ c, e, lk }: { c: WsConflict; e: EntityMeta; lk: Lookup }) {
  const label = c.field === "*deleted" ? "запись" : e.fields.find((f) => f.name === c.field)?.label ?? c.field;
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "пусто" : cellText(e, { [c.field]: v } as CrmRecord, c.field, lk) || String(v));
  return (
    <Notice tone="warn" action={
      <div className="row" style={{ gap: 6 }}>
        <Button small onClick={() => void attempt(() => api.wsResolveConflict(c.id, false))}>Оставить</Button>
        {c.field !== "*deleted" && <Button small variant="ghost" onClick={() => void attempt(() => api.wsResolveConflict(c.id, true))}>Вернуть «{show(c.lost)}»</Button>}
      </div>
    }>
      {c.field === "*deleted"
        ? "Запись удалил другой участник, ваши правки не применены."
        : <>Поле «{label}» одновременно изменили: сохранено «{show(c.kept)}»{c.keptBy ? ` (${memberName(lk.members, c.keptBy)})` : ""}, ваше «{show(c.lost)}» не применено.</>}
    </Notice>
  );
}

function Overview({ e, data, lk, editable, save }: { e: EntityMeta; data: WsCard; lk: Lookup; editable: boolean; save: (f: Record<string, unknown>) => void }) {
  const r = data.record;
  const ws = useStore((s) => s.ws);
  const creatable = can(ws?.permissions ?? [], "create");
  const stages = e.type === "deal" ? stagesOf(lk, r.pipeline_id) : [];
  return (
    <>
      {e.type === "deal" && stages.length > 0 && (
        <div className="stage-bar" role="radiogroup" aria-label="Этап сделки">
          {stages.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={s.id === r.stage_id} disabled={!editable}
              className={`stage-step ${String(s.kind)}${s.id === r.stage_id ? " on" : ""}`} data-tip={String(s.name)} onClick={() => s.id !== r.stage_id && save({ stage_id: s.id })}>
              <span className="ellipsis">{String(s.name)}</span>
            </button>
          ))}
        </div>
      )}
      <Fields e={e} rec={r} lk={lk} editable={editable} onChange={(f, v) => save({ [f]: v })} />
      <CustomFieldsSection e={e} data={data} editable={editable} />
      <AttachmentsSection e={e} data={data} />
      {data.contacts && (
        <section className="insp-sec">
          <h4 className="row"><span className="grow">Контакты</span>{creatable && <a onClick={() => void quick("contacts", { company_id: r.id, first_name: "Новый контакт" })}>Добавить</a>}</h4>
          <Related rows={data.contacts} e={ENTITIES.contact} lk={lk} />
        </section>
      )}
      {data.deals && (
        <section className="insp-sec">
          <h4 className="row"><span className="grow">Сделки</span>{creatable && <a onClick={() => { const d = defaultStage(lk); if (d) void quick("deals", { ...d, company_id: r.id, title: `Сделка: ${e.title(r)}`, currency: "RUB" }); }}>Добавить</a>}</h4>
          <Related rows={data.deals} e={ENTITIES.deal} lk={lk} />
        </section>
      )}
      {e.type === "contact" && typeof r.company_id === "string" && lk.companies.get(r.company_id) && (
        <section className="insp-sec"><h4>Компания</h4><Related rows={[lk.companies.get(r.company_id)!]} e={ENTITIES.company} lk={lk} /></section>
      )}
      {e.type === "deal" && typeof r.company_id === "string" && lk.companies.get(r.company_id) && (
        <section className="insp-sec"><h4>Компания</h4><Related rows={[lk.companies.get(r.company_id)!]} e={ENTITIES.company} lk={lk} /></section>
      )}
      <section className="insp-sec">
        <h4>Сведения</h4>
        <dl className="kv">
          <div><dt>Создано</dt><dd>{fullRu(r.created_at)}{r.created_by ? ` · ${memberName(lk.members, r.created_by)}` : ""}</dd></div>
          <div><dt>Изменено</dt><dd>{fullRu(r.updated_at)}{r.updated_by ? ` · ${memberName(lk.members, r.updated_by)}` : ""}</dd></div>
          {typeof r.source === "string" && r.source && <div><dt>Источник</dt><dd>{r.source}</dd></div>}
          {e.type === "deal" && typeof r.closed_at === "string" && <div><dt>Закрыта</dt><dd>{fullRu(r.closed_at)}</dd></div>}
          {e.type === "task" && typeof r.completed_at === "string" && <div><dt>Выполнена</dt><dd>{fullRu(r.completed_at)}</dd></div>}
          <div><dt>Версия</dt><dd className="num">{r.version}</dd></div>
        </dl>
      </section>
    </>
  );
}

async function quick(table: string, fields: Record<string, unknown>) {
  const saved = await attempt(() => api.wsSave(table, null, fields));
  if (saved) openRecord(table, saved.id);
}

function Related({ rows, e, lk }: { rows: CrmRecord[]; e: EntityMeta; lk: Lookup }) {
  if (!rows.length) return <p className="faint">Пока нет.</p>;
  return (
    <ul className="crm-related">
      {rows.map((r) => (
        <li key={r.id}>
          <button type="button" className="crm-link" onClick={() => openRecord(e.table, r.id)}>
            <span className="ellipsis grow">{e.title(r)}</span>
            <span className="faint ellipsis">{cellText(e, r, e.columns[1] ?? "updated_at", lk)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- лента: заметки, события, комментарии

const ACTIVITY_TYPES = ["call", "email", "meeting", "follow_up", "agreement", "payment", "custom"] as const;

function Feed({ e, data, lk }: { e: EntityMeta; data: WsCard; lk: Lookup }) {
  const ws = useStore((s) => s.ws);
  const [kind, setKind] = useState<"note" | "comment" | (typeof ACTIVITY_TYPES)[number]>("note");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const creatable = can(ws?.permissions ?? [], "create");
  const link = { entity_type: e.type, entity_id: data.record.id };
  const items = useMemo(() => {
    const all = [
      ...(data.notes ?? []).map((r) => ({ r, k: "note" as const, at: r.created_at })),
      ...(data.comments ?? []).map((r) => ({ r, k: "comment" as const, at: r.created_at })),
      ...(data.activities ?? []).map((r) => ({ r, k: "activity" as const, at: String(r.occurred_at ?? r.created_at) })),
    ];
    return all.sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [data]);

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const ok = kind === "note"
      ? await attempt(() => api.wsSave("notes", null, { ...link, body: text.trim() }))
      : kind === "comment"
        ? await attempt(() => api.wsSave("comments", null, { ...link, body: text.trim() }))
        : await attempt(() => api.wsSave("activities", null, { ...link, type: kind, summary: text.trim(), occurred_at: new Date().toISOString(), payload: {} }));
    setBusy(false);
    if (ok) setText("");
  };

  return (
    <>
      {creatable && (
        <section className="insp-sec">
          <Select value={kind} onChange={setKind} small options={[
            { value: "note", label: "Заметка" }, { value: "comment", label: "Комментарий" },
            ...ACTIVITY_TYPES.map((t) => ({ value: t, label: ENUMS["activities.type"]![t]! })),
          ]} />
          <TextArea value={text} onChange={setText} rows={3} placeholder={kind === "note" ? "Что важно помнить о клиенте" : kind === "comment" ? "Комментарий для коллег" : "Кратко: что произошло"} />
          <div className="row"><span className="grow" /><Button small variant="primary" busy={busy} disabled={!text.trim()} onClick={() => void add()}>Добавить</Button></div>
        </section>
      )}
      {items.length === 0 ? <p className="faint">Лента пуста: здесь будут заметки, звонки, письма и комментарии.</p> : (
        <ul className="timeline">
          {items.map(({ r, k, at }) => (
            <li key={r.id}>
              <span className="tl-icon"><Icon name={k === "note" ? "note" : k === "comment" ? "users" : r.type === "call" ? "phone" : r.type === "email" ? "mail" : r.type === "system" ? "info" : "dot"} size={13} /></span>
              <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
                  {k === "note" ? "Заметка" : k === "comment" ? "Комментарий" : ENUMS["activities.type"]![String(r.type)] ?? String(r.type)} · {shortRelative(at)}{r.created_by ? ` · ${memberName(lk.members, r.created_by)}` : ""}
                </span>
                <span className="selectable crm-body">{String(r.body ?? r.summary ?? "")}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------- задачи карточки

function Tasks({ e, id, tasks, lk }: { e: EntityMeta; id: string; tasks: CrmRecord[]; lk: Lookup }) {
  const ws = useStore((s) => s.ws);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const creatable = can(ws?.permissions ?? [], "create");
  const add = async () => {
    if (!title.trim()) return;
    const ok = await attempt(() => api.wsSave("tasks", null, {
      title: title.trim(), entity_type: e.type, entity_id: id, assignee_id: ws?.me ?? null, status: "todo", priority: "normal", due_at: due ? new Date(due).toISOString() : null,
    }));
    if (ok) { setTitle(""); setDue(""); }
  };
  return (
    <>
      {creatable && (
        <section className="insp-sec">
          <TextInput value={title} onChange={setTitle} placeholder="Новая задача" onKeyDown={(ev) => { if (ev.key === "Enter") void add(); }} />
          <div className="row" style={{ gap: 8 }}>
            <TextInput value={due} onChange={setDue} type="datetime-local" aria-label="Срок" />
            <span className="grow" />
            <Button small variant="primary" disabled={!title.trim()} onClick={() => void add()}>Добавить</Button>
          </div>
        </section>
      )}
      {tasks.length === 0 ? <p className="faint">Задач нет.</p> : (
        <ul className="crm-related">
          {tasks.map((t) => {
            const overdue = typeof t.due_at === "string" && t.due_at < new Date().toISOString() && t.status !== "done" && t.status !== "cancelled";
            return (
              <li key={t.id} className="row" style={{ gap: 6 }}>
                <IconButton icon={t.status === "done" ? "check" : "dot"} tip={t.status === "done" ? "Вернуть в работу" : "Выполнено"} active={t.status === "done"}
                  disabled={!can(ws?.permissions ?? [], "edit", t, ws?.me)} onClick={() => void attempt(() => api.wsSave("tasks", t.id, { status: t.status === "done" ? "todo" : "done" }))} />
                <button type="button" className="crm-link grow" onClick={() => openRecord("tasks", t.id)}>
                  <span className={`ellipsis grow${t.status === "done" ? " done" : ""}`}>{String(t.title)}</span>
                  <span className={`ellipsis ${overdue ? "bad" : "faint"}`}>{typeof t.due_at === "string" ? shortRelative(t.due_at) : ""}{t.assignee_id ? ` · ${memberName(lk.members, t.assignee_id)}` : ""}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function StageHistory({ data, lk }: { data: WsCard; lk: Lookup }) {
  const h = data.history ?? [];
  if (!h.length) return <p className="faint">Сделка ещё не меняла этап.</p>;
  const name = (id: string | null) => (id ? String(lk.stages.get(id)?.name ?? "Этап удалён") : "—");
  return (
    <ul className="timeline">
      {[...h].reverse().map((x, i) => (
        <li key={`${x.changed_at}-${i}`}>
          <span className="tl-icon"><Icon name="chevronRight" size={13} /></span>
          <div className="col grow" style={{ gap: 2 }}>
            <span>{name(x.from_stage_id)} → <b>{name(x.to_stage_id)}</b></span>
            <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{fullRu(x.changed_at)}{x.changed_by ? ` · ${memberName(lk.members, x.changed_by)}` : ""}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
