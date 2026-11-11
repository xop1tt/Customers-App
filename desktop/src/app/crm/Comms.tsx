// Коммуникации в карточке CRM (пакет G6, docs/COMMUNICATIONS.md): «Позвонить», «Написать» по шаблону и
// «Встреча» у компании, контакта и сделки; «Следующее действие» сделки. Звонок и письмо записываются в ленту
// событием (activities), встреча — задачей со сроком, поэтому видна в календаре. Схема базы не меняется.

import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import type { CrmRecord, MailState, WsCard } from "../../api/types";
import { can, type EntityMeta, type Lookup } from "../../lib/crm";
import { contactPoints, fillTemplate, isEmail, nextAction, quickDue, TEMPLATES, type ContactPoint, type TemplateId } from "../../lib/comms";
import { shortRelative } from "../../lib/format";
import { t } from "../../lib/i18n";
import { Button, Field, Notice, Select, TextArea, TextInput } from "../../ui/kit";
import { Dialog, showMenu } from "../../ui/overlay";
import { attempt, openRecord, openSettings, toast, useStore } from "../../state/store";
import { useWsQuery } from "./useCrm";

export const COMMS_TYPES = new Set(["company", "contact", "deal"]);

/** Записи, чьи телефоны и почта доступны из карточки: сама запись, контакты компании, компания и контакты сделки. */
function usePeople(e: EntityMeta, data: WsCard, lk: Lookup): CrmRecord[] {
  const r = data.record;
  const dealContactIds = e.type === "deal" ? (data.dealContacts ?? []).map((x) => String(x.contact_id)).filter(Boolean) : [];
  const { data: dealContacts } = useWsQuery(
    () => Promise.all(dealContactIds.map((id) => api.wsCard("contacts", id).then((c) => c.record).catch(() => null))),
    [dealContactIds.join(",")],
  );
  return useMemo(() => {
    if (e.type === "contact") {
      const company = typeof r.company_id === "string" ? lk.companies.get(r.company_id) : undefined;
      return company ? [r, company] : [r];
    }
    if (e.type === "company") return [r, ...(data.contacts ?? []).filter((c) => !c.deleted_at)];
    const company = typeof r.company_id === "string" ? lk.companies.get(r.company_id) : undefined;
    const people = (dealContacts ?? []).filter((c): c is CrmRecord => !!c && !c.deleted_at);
    return [...people, ...(company ? [company] : [])];
  }, [e.type, r, data.contacts, lk.companies, dealContacts]);
}

const log = (e: EntityMeta, id: string, type: "call" | "email", summary: string, payload: Record<string, unknown>) =>
  api.wsSave("activities", null, { entity_type: e.type, entity_id: id, type, summary, occurred_at: new Date().toISOString(), payload });

/** Кнопки «Позвонить», «Написать», «Встреча» под заголовком карточки. */
export function CommsBar({ e, data, lk }: { e: EntityMeta; data: WsCard; lk: Lookup }) {
  const ws = useStore((s) => s.ws);
  const people = usePeople(e, data, lk);
  const [dialog, setDialog] = useState<"mail" | "meeting" | null>(null);
  const r = data.record;
  if (!COMMS_TYPES.has(e.type) || r.deleted_at || !can(ws?.permissions ?? [], "create")) return null;
  const phones = contactPoints(people, "phones");
  const emails = contactPoints(people, "emails");

  const dial = async (p: ContactPoint) => {
    if (await attempt(() => api.callPhone(p.value)) === undefined) return;
    const who = p.owner && p.owner !== e.title(r) ? ` (${p.owner})` : "";
    if (await attempt(() => log(e, r.id, "call", `${t("Звонок")}: ${p.value}${who}`, { phone: p.value, direction: "out" }))) toast("Звонок записан в ленту", "success");
  };
  const call = (anchor: DOMRect) => {
    if (phones.length === 1) void dial(phones[0]!);
    else showMenu(phones.map((p) => ({ label: p.value, hint: p.owner, icon: "phone", onSelect: () => void dial(p) })), anchor);
  };

  return (
    <div className="row comms-bar" role="group" aria-label="Связаться">
      <Button small icon="phone" disabled={!phones.length} title={phones.length ? undefined : t("Нет телефона")} onClick={(ev) => call(ev.currentTarget.getBoundingClientRect())}>Позвонить</Button>
      <Button small icon="mail" onClick={() => setDialog("mail")}>Написать</Button>
      <Button small icon="calendar" onClick={() => setDialog("meeting")}>Встреча</Button>
      {dialog === "mail" && <ComposeDialog e={e} record={r} lk={lk} emails={emails} people={people} onClose={() => setDialog(null)} />}
      {dialog === "meeting" && <MeetingDialog e={e} record={r} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- письмо

function ComposeDialog({ e, record, lk, emails, people, onClose }: { e: EntityMeta; record: CrmRecord; lk: Lookup; emails: ContactPoint[]; people: CrmRecord[]; onClose: () => void }) {
  const account = useStore((s) => s.account);
  const [mail, setMail] = useState<MailState | null>(null);
  useEffect(() => { void api.mailState().then(setMail).catch(() => {}); }, []);
  const [to, setTo] = useState(emails[0]?.value ?? "");
  const [tpl, setTpl] = useState<TemplateId>(e.type === "deal" ? "offer" : "intro");
  const signature = account?.signature || mail?.signature || "";
  const ctx = useMemo(() => {
    const person = people.find((p) => Array.isArray(p.emails) && p.emails.some((x) => String(x).toLowerCase() === to.trim().toLowerCase())) ?? people[0];
    const first = person && typeof person.first_name === "string" && person.first_name.trim() ? person.first_name.trim() : "";
    const companyRec = e.type === "company" ? record : typeof record.company_id === "string" ? lk.companies.get(record.company_id) : undefined;
    return {
      name: first || (e.type === "contact" ? e.title(record) : ""),
      company: companyRec && typeof companyRec.name === "string" ? companyRec.name : "",
      deal: e.type === "deal" ? e.title(record) : "",
      signature,
    };
  }, [people, to, e, record, lk.companies, signature]);
  const initial = useMemo(() => fillTemplate(TEMPLATES.find((x) => x.id === tpl)!, ctx), [tpl, ctx]);
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [touched, setTouched] = useState(false);
  // Пока текст не правили руками, он следует за шаблоном, получателем и подписью.
  useEffect(() => { if (!touched) { setSubject(initial.subject); setBody(initial.body); } }, [initial, touched]);
  const [busy, setBusy] = useState(false);
  const valid = isEmail(to);
  const smtp = mail?.delivery === "smtp" && mail.smtpReady;

  const done = async (how: "app" | "smtp") => {
    const summary = `${t("Письмо")}: ${subject.trim() || t("без темы")}`;
    await attempt(() => log(e, record.id, "email", summary, { to: to.trim(), subject: subject.trim(), via: how === "smtp" ? "smtp" : "mail_app" }));
    onClose();
  };
  const open = async () => {
    if (await attempt(() => api.openInMailApp(to.trim(), subject, body)) === undefined) return;
    toast("Письмо открыто в почте и записано в ленту", "success");
    await done("app");
  };
  const send = async () => {
    setBusy(true);
    const res = await attempt(() => api.mailSend(to.trim(), subject, body));
    setBusy(false);
    if (res === undefined) return;
    toast(typeof res === "string" && res ? res : "Письмо отправлено", "success");
    await done("smtp");
  };

  return (
    <Dialog title="Написать письмо" onClose={onClose} width={560} className="comms-dialog" footer={
      <>
        <Button variant="ghost" onClick={() => { setTouched(false); setSubject(initial.subject); setBody(initial.body); }}>Сбросить текст</Button>
        <span className="grow" />
        <Button icon="mail" variant={smtp ? "default" : "primary"} disabled={!valid} onClick={() => void open()}>Открыть в почте</Button>
        {smtp && <Button icon="send" variant="primary" busy={busy} disabled={!valid} onClick={() => void send()}>Отправить</Button>}
      </>
    }>
      <div className="col" style={{ gap: 10 }}>
        <Field label="Кому">
          {emails.length > 1
            ? <Select value={to} onChange={setTo} options={emails.map((m) => ({ value: m.value, label: m.owner ? `${m.value} · ${m.owner}` : m.value }))} />
            : <TextInput value={to} onChange={setTo} aria-label="Кому" placeholder="Адрес получателя" invalid={to !== "" && !valid} />}
        </Field>
        {emails.length === 0 && <Notice tone="info">В карточке нет почты. Введите адрес вручную или добавьте его в поле «Почта».</Notice>}
        <Field label="Шаблон">
          <Select value={tpl} onChange={(v) => { setTpl(v); setTouched(false); }} options={TEMPLATES.map((x) => ({ value: x.id, label: t(x.title) }))} />
        </Field>
        <Field label="Тема"><TextInput value={subject} aria-label="Тема" onChange={(v) => { setSubject(v); setTouched(true); }} /></Field>
        <Field label="Текст"><TextArea value={body} aria-label="Текст" onChange={(v) => { setBody(v); setTouched(true); }} rows={10} /></Field>
        <p className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          Подпись берётся из настроек рассылки. <a onClick={() => { onClose(); openSettings("outreach"); }}>Изменить</a>
        </p>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- встреча

const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function MeetingDialog({ e, record, onClose }: { e: EntityMeta; record: CrmRecord; onClose: () => void }) {
  const ws = useStore((s) => s.ws);
  const [title, setTitle] = useState(`${t("Встреча")}: ${e.title(record)}`);
  const [at, setAt] = useState(toLocalInput(quickDue("tomorrow")));
  const [place, setPlace] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = title.trim() !== "" && at !== "" && !Number.isNaN(new Date(at).getTime());
  const save = async () => {
    setBusy(true);
    const ok = await attempt(() => api.wsSave("tasks", null, {
      title: title.trim(), description: place.trim() || null, entity_type: e.type, entity_id: record.id,
      assignee_id: ws?.me ?? null, status: "todo", priority: "normal", due_at: new Date(at).toISOString(),
    }));
    setBusy(false);
    if (ok) { toast("Встреча запланирована: она есть в задачах и в календаре", "success"); onClose(); }
  };
  return (
    <Dialog title="Запланировать встречу" onClose={onClose} width={440} footer={
      <>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" busy={busy} disabled={!valid} onClick={() => void save()}>Запланировать</Button>
      </>
    }>
      <div className="col" style={{ gap: 10 }}>
        <Field label="Тема"><TextInput value={title} onChange={setTitle} aria-label="Тема" /></Field>
        <Field label="Когда"><TextInput type="datetime-local" value={at} onChange={setAt} aria-label="Когда" /></Field>
        <Field label="Место или ссылка"><TextInput value={place} onChange={setPlace} aria-label="Место или ссылка" placeholder="Офис клиента, Zoom, Телемост…" /></Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- следующее действие сделки

/** Блок «Следующее действие» в обзоре открытой сделки: ближайшая задача или предупреждение и быстрое планирование. */
export function NextStep({ e, data, lk }: { e: EntityMeta; data: WsCard; lk: Lookup }) {
  const ws = useStore((s) => s.ws);
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState<"today" | "tomorrow" | "week">("tomorrow");
  const [planning, setPlanning] = useState(false);
  const r = data.record;
  const stage = typeof r.stage_id === "string" ? lk.stages.get(r.stage_id) : undefined;
  if (e.type !== "deal" || r.deleted_at || (stage && stage.kind !== "open")) return null;
  const next = nextAction(data.tasks ?? []);
  const creatable = can(ws?.permissions ?? [], "create");
  const add = async () => {
    if (!title.trim()) return;
    const ok = await attempt(() => api.wsSave("tasks", null, {
      title: title.trim(), entity_type: "deal", entity_id: r.id, assignee_id: ws?.me ?? null,
      status: "todo", priority: "normal", due_at: quickDue(when).toISOString(),
    }));
    if (ok) { setTitle(""); setPlanning(false); }
  };
  return (
    <section className="insp-sec next-step" aria-label="Следующее действие">
      <h4>Следующее действие</h4>
      {next ? (
        <button type="button" className="crm-link next-task" onClick={() => openRecord("tasks", next.task.id)}>
          <span className="ellipsis grow">{String(next.task.title)}</span>
          <span className={next.overdue ? "bad" : "faint"}>{next.dated ? `${next.overdue ? `${t("просрочено")} · ` : ""}${shortRelative(String(next.task.due_at))}` : t("без срока")}</span>
        </button>
      ) : !planning && (
        <Notice tone="warn" action={creatable ? <Button small onClick={() => setPlanning(true)}>Запланировать</Button> : undefined}>
          Нет следующего шага: сделка может остыть.
        </Notice>
      )}
      {planning && (
        <div className="col" style={{ gap: 6 }}>
          <TextInput value={title} onChange={setTitle} placeholder="Что сделать: позвонить, отправить КП…" aria-label="Следующий шаг"
            onKeyDown={(ev) => { if (ev.key === "Enter") void add(); }} />
          <div className="row" style={{ gap: 6 }}>
            <Select small value={when} onChange={setWhen} label="Срок" options={[
              { value: "today", label: "Сегодня" }, { value: "tomorrow", label: "Завтра" }, { value: "week", label: "Через неделю" },
            ]} />
            <span className="grow" />
            <Button small variant="ghost" onClick={() => setPlanning(false)}>Отмена</Button>
            <Button small variant="primary" disabled={!title.trim()} onClick={() => void add()}>Добавить</Button>
          </div>
        </div>
      )}
    </section>
  );
}
