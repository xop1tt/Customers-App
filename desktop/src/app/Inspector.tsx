import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { Lead, LeadEvent, MailState } from "../api/types";
import { KIND_TITLE, RELEVANCE_TITLE, isNegativeReason, scoreTone } from "../lib/leads";
import { t } from "../lib/i18n";
import { fullRu, integer, money, plural } from "../lib/format";
import { sourceTitle } from "../lib/sources";
import { Button, Checkbox, EmptyState, Field, IconButton, Notice, Score, Select, Tabs, Tag, TextArea, TextInput } from "../ui/kit";
import { Icon } from "../ui/icons";
import { confirmDialog } from "../ui/overlay";
import { attempt, openSettings, select, setState, toast, useStore } from "../state/store";
import { copyToClipboard, deleteLeads, excludeLeads, openExport, openLink, setArchived, setFavorite } from "../state/actions";

type Tab = "overview" | "write" | "history";

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const leads = useStore((s) => s.snap.leads);
  const lead = selection.length === 1 ? leads.find((l) => l.id === selection[0]) : undefined;
  if (selection.length > 1) {
    return (
      <div className="inspector-body">
        <EmptyState icon="list" title={`Выбрано: ${integer(selection.length)} ${plural(selection.length, "лид", "лида", "лидов")}`} action={
          <div className="col" style={{ alignItems: "stretch", width: 220 }}>
            <Button icon="upload" onClick={() => openExport(selection)}>Экспортировать</Button>
            <Button icon="trash" variant="danger" onClick={() => void deleteLeads(selection)}>Удалить</Button>
            <Button variant="ghost" onClick={() => select([])}>Снять выделение</Button>
          </div>
        }>Действия над несколькими лидами доступны на панели под списком.</EmptyState>
      </div>
    );
  }
  if (!lead) return <div className="inspector-body"><EmptyState icon="note" title="Выберите лид">Здесь появятся оценка, контакты, заметка и история.</EmptyState></div>;
  return <LeadInspector key={lead.id} lead={lead} />;
}

function LeadInspector({ lead }: { lead: Lead }) {
  const [tab, setTab] = useState<Tab>("overview");
  const d = lead.data;
  return (
    <div className="inspector-body">
      <div className="insp-head">
        <div className="row insp-tags">
          <Tag tone={d.kind === "order" ? "blue" : "gray"}>{KIND_TITLE[d.kind]}</Tag>
          <Tag>{sourceTitle(d.source)}</Tag>
          {d.region && <Tag icon="pin">{d.region}</Tag>}
        </div>
        <h3 className="insp-title selectable">{d.title}</h3>
        <div className="row insp-actions">
          <IconButton icon="star" tip={lead.favorite ? "Убрать из избранного" : "В избранное"} active={lead.favorite} onClick={() => void setFavorite([lead.id], !lead.favorite)} />
          <IconButton icon="archive" tip={lead.archived ? "Вернуть из архива" : "В архив"} active={lead.archived} onClick={() => void setArchived([lead.id], !lead.archived)} />
          {d.url && <IconButton icon="external" tip="Открыть источник" onClick={() => void openLink(d.url)} />}
          <IconButton icon="upload" tip="Экспортировать" onClick={() => openExport([lead.id])} />
          <span className="grow" />
          <IconButton icon="ban" tip="Исключить" onClick={() => void excludeLeads([lead.id])} />
          <IconButton icon="trash" tip="Удалить" onClick={() => void deleteLeads([lead.id])} />
        </div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: "overview", label: "Обзор" }, { id: "write", label: "Написать" }, { id: "history", label: "История" }]} />
      <div className="insp-scroll">
        {tab === "overview" && <Overview lead={lead} onWrite={() => setTab("write")} />}
        {tab === "write" && <Compose lead={lead} />}
        {tab === "history" && <History lead={lead} />}
      </div>
    </div>
  );
}

function Overview({ lead, onWrite }: { lead: Lead; onWrite: () => void }) {
  const d = lead.data;
  const account = useStore((s) => s.account);
  const [note, setNote] = useState(lead.note);
  const saved = useRef(lead.note);
  useEffect(() => { setNote(lead.note); saved.current = lead.note; }, [lead.note]);
  const saveNote = () => {
    if (note === saved.current) return;
    saved.current = note;
    void attempt(() => api.setNote(lead.id, note));
  };
  const call = async (phone: string) => {
    if (account?.confirmCalls) {
      const ok = await confirmDialog({ title: "Позвонить?", message: `Откроется приложение для звонков: ${phone}`, confirm: "Позвонить" });
      if (!ok) return;
    }
    await attempt(() => api.callPhone(phone, lead.id));
  };
  const facts: [string, string][] = [];
  if (d.budget !== undefined) facts.push(["Бюджет", money(d.budget, d.currency)]);
  if (d.address) facts.push(["Адрес", d.address]);
  if (d.category) facts.push(["Категория", d.category]);
  if (d.project_type) facts.push(["Тип проекта", d.project_type]);
  if (d.customer_name) facts.push(["Заказчик", d.customer_name]);
  facts.push(["Найден", fullRu(lead.discoveredAt)]);
  if (d.published_at) facts.push(["Опубликован", fullRu(d.published_at)]);

  return (
    <div className="insp-sections">
      <ToCrm lead={lead} />
      <div className="insp-score">
        <Score value={d.score} big />
        <div className="col grow" style={{ gap: 2 }}>
          <strong>{RELEVANCE_TITLE[d.relevance]} релевантность</strong>
          <span className="muted">{scoreTone(d.score) === "good" ? "Стоит связаться в первую очередь" : scoreTone(d.score) === "mid" ? "Подходит, если есть время" : "Низкий приоритет"}</span>
        </div>
      </div>

      {d.score_reasons.length > 0 && (
        <section className="insp-sec">
          <h4>Почему такая оценка</h4>
          <ul className="reasons">
            {d.score_reasons.map((r) => (
              <li key={r} className={isNegativeReason(r) ? "neg" : "pos"}>
                <Icon name={isNegativeReason(r) ? "minus" : "plus"} size={12} stroke={2.2} />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(lead.phones.length > 0 || lead.emails.length > 0 || d.website) && (
        <section className="insp-sec">
          <h4>Контакты</h4>
          <ul className="contacts">
            {lead.phones.map((p) => (
              <li key={p} className="contact">
                <Icon name="phone" size={14} />
                <span className="ellipsis grow selectable">{p}</span>
                <IconButton icon="phone" tip="Позвонить" onClick={() => void call(p)} />
                <IconButton icon="copy" tip="Копировать" onClick={() => void copyToClipboard(p, "Телефон скопирован")} />
              </li>
            ))}
            {lead.emails.map((m) => (
              <li key={m} className="contact">
                <Icon name="mail" size={14} />
                <span className="ellipsis grow selectable">{m}</span>
                <IconButton icon="send" tip="Написать" onClick={onWrite} />
                <IconButton icon="copy" tip="Копировать" onClick={() => void copyToClipboard(m, "Почта скопирована")} />
              </li>
            ))}
            {d.website && (
              <li className="contact">
                <Icon name="globe" size={14} />
                <span className="ellipsis grow selectable">{d.website}</span>
                <IconButton icon="external" tip="Открыть сайт" onClick={() => void openLink(/^https?:/.test(d.website as string) ? (d.website as string) : `https://${d.website}`)} />
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="insp-sec">
        <h4>Сведения</h4>
        <dl className="kv">
          {facts.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd className="selectable">{v}</dd></div>))}
        </dl>
      </section>

      {d.description && <section className="insp-sec"><h4>Описание</h4><p className="selectable desc">{d.description}</p></section>}

      {d.facts.length > 0 && (
        <section className="insp-sec"><h4>Факты</h4><ul className="bullets">{d.facts.map((f) => <li key={f} className="selectable">{f}</li>)}</ul></section>
      )}
      {d.assumptions.length > 0 && (
        <section className="insp-sec"><h4>Предположения</h4><ul className="bullets soft">{d.assumptions.map((f) => <li key={f} className="selectable">{f}</li>)}</ul></section>
      )}
      {d.external_results.length > 0 && (
        <section className="insp-sec">
          <h4>Результаты анализа</h4>
          <ul className="bullets">
            {d.external_results.map((r) => <li key={r.service} className="selectable">{r.service}: {r.ok ? `${r.label ?? "готово"}${r.score !== undefined ? ` (${r.score})` : ""}` : r.error ?? "ошибка"}</li>)}
          </ul>
        </section>
      )}

      <section className="insp-sec">
        <h4>Заметка</h4>
        <TextArea value={note} onChange={setNote} onBlur={saveNote} placeholder="Что важно помнить об этом лиде" rows={4} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- «Написать»

function template(lead: Lead, signature: string): { subject: string; body: string } {
  const d = lead.data;
  const sign = signature.trim() ? `\n\n${signature.trim()}` : "";
  if (d.kind === "order") {
    return {
      subject: t("Отклик на заказ: {title}").replace("{title}", d.title).slice(0, 120),
      body: t("Здравствуйте!\n\nУвидел ваш запрос «{title}». Могу взяться за эту задачу: сделаю аккуратно и в срок. Расскажите, пожалуйста, подробнее о задаче и желаемых сроках, и я предложу решение и стоимость.").replace("{title}", d.title) + sign,
    };
  }
  return {
    subject: t("Предложение для «{title}»").replace("{title}", d.title).slice(0, 120),
    body: t("Здравствуйте!\n\nПишу вам по поводу «{title}». Помогаю компаниям привлекать клиентов через сайты и онлайн-запись. Посмотрел ваши публичные данные и вижу, что можно улучшить присутствие в интернете. Если интересно, расскажу подробнее и предложу варианты без обязательств.").replace("{title}", d.title) + sign,
  };
}

function Compose({ lead }: { lead: Lead }) {
  const account = useStore((s) => s.account);
  const initial = useMemo(() => template(lead, account?.signature ?? ""), [lead, account?.signature]);
  const [to, setTo] = useState(lead.emails[0] ?? "");
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [mail, setMail] = useState<MailState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.mailState().then(setMail).catch(() => {}); }, []);
  const canSend = mail?.delivery === "smtp" && mail.smtpReady;
  const valid = /^\S+@\S+\.\S+$/.test(to.trim());

  const open = async () => { await attempt(() => api.openInMailApp(to.trim(), subject, body, lead.id)); };
  const send = async () => {
    setBusy(true);
    const r = await attempt(() => api.mailSend(to.trim(), subject, body, lead.id));
    setBusy(false);
    if (r) toast(typeof r === "string" && r ? r : "Письмо отправлено", "success");
  };

  return (
    <div className="insp-sections">
      <Field label="Кому">
        {lead.emails.length > 1 ? (
          <Select value={to} options={lead.emails.map((e) => ({ value: e, label: e }))} onChange={setTo} />
        ) : (
          <TextInput value={to} onChange={setTo} placeholder="Адрес получателя" invalid={to !== "" && !valid} />
        )}
      </Field>
      {lead.emails.length === 0 && <Notice tone="info">У лида нет почты. Введите адрес вручную или свяжитесь по телефону.</Notice>}
      <Field label="Тема"><TextInput value={subject} onChange={setSubject} /></Field>
      <Field label="Текст"><TextArea value={body} onChange={setBody} rows={11} /></Field>
      {mail && mail.delivery === "smtp" && !mail.smtpReady && (
        <Notice tone="warn" action={<Button small onClick={() => setState({ settings: "outreach" })}>Настроить</Button>}>Почтовый сервер не настроен: письмо можно открыть в почтовой программе.</Notice>
      )}
      <div className="row insp-send">
        <Button icon="mail" onClick={() => void open()} disabled={!valid}>Открыть в почте</Button>
        {canSend && <Button variant="primary" icon="send" busy={busy} onClick={() => void send()} disabled={!valid}>Отправить</Button>}
        <span className="grow" />
        <Button variant="ghost" onClick={() => { setSubject(initial.subject); setBody(initial.body); }}>Сбросить текст</Button>
      </div>
      <p className="faint" style={{ fontSize: "var(--fs-sm)" }}>Подпись берётся из настроек рассылки. <button type="button" className="link" onClick={() => openSettings("outreach")}>Изменить</button></p>
    </div>
  );
}

// ---------------------------------------------------------------- история

function History({ lead }: { lead: Lead }) {
  const [events, setEvents] = useState<LeadEvent[] | null>(null);
  useEffect(() => {
    let alive = true;
    void api.leadEvents(lead.id).then((e) => alive && setEvents(e)).catch(() => alive && setEvents([]));
    return () => { alive = false; };
  }, [lead.id, lead.note, lead.favorite, lead.archived]);
  if (!events) return <p className="faint">Загрузка…</p>;
  if (events.length === 0) return <EmptyState icon="history" title="Событий пока нет">Здесь появятся звонки, письма и другие действия.</EmptyState>;
  return (
    <ul className="timeline">
      {events.map((e) => (
        <li key={e.id}>
          <span className="tl-dot" />
          <div className="col" style={{ gap: 1 }}>
            <span className="selectable">{e.action}</span>
            <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{fullRu(e.at)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** «Добавить в CRM»: компания, контакт и (по желанию) сделка в активном Workspace. Повторно не дублирует. */
function ToCrm({ lead }: { lead: Lead }) {
  const ws = useStore((s) => s.ws);
  const collections = useStore((s) => s.collections);
  const [deal, setDeal] = useState(true);
  const [busy, setBusy] = useState(false);
  if (!ws?.active) return null;
  const mark = lead.data.crm;
  const open = (companyId: string) => {
    const c = collections.find((x) => x.entity_type === "company" && x.builtin === "all_clients") ?? collections.find((x) => x.entity_type === "company");
    if (c) setState({ section: "collection", collectionId: c.id, record: { table: "companies", id: companyId }, selection: [], anchor: null });
  };
  if (mark && mark.workspace_id === ws.active) {
    return (
      <Notice tone="ok" action={<Button small onClick={() => open(mark.company_id)}>Открыть</Button>}>
        В CRM с {fullRu(mark.converted_at)}{mark.deal_id ? ", есть сделка" : ""}.
      </Notice>
    );
  }
  if (!ws.permissions.includes("records.create")) return null;
  const go = async () => {
    setBusy(true);
    const r = await attempt(() => api.wsConvertLead(lead.id, { createDeal: deal }));
    setBusy(false);
    if (!r) return;
    toast(r.reusedCompany ? "Компания уже была в CRM: лид связан с ней" : `Перенесено в CRM: компания${r.contactId ? ", контакт" : ""}${r.dealId ? " и сделка" : ""}`, "success");
  };
  return (
    <div className="row crm-convert">
      <Button icon="upload" busy={busy} onClick={() => void go()}>Добавить в CRM</Button>
      <Checkbox checked={deal} onChange={setDeal} label="со сделкой" />
    </div>
  );
}
