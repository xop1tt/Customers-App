// Мастер первого запуска (пакет G7, ADR-063, макеты одобрены Maksim): компания, воронка, клиенты, звонки и письма.
// Каждый шаг можно пропустить; всё, что он настраивает, меняется потом в настройках.

import { useState } from "react";
import { api } from "../api";
import { back, canGoBack, canSkip, finish, isLast, newFlow, next, position, progress, skip, stepOf, type WelcomeFlow } from "../lib/welcomeFlow";
import { PIPELINE_TEMPLATES, planStages, type TemplateId } from "../lib/onboarding";
import { Button, Field, Group, ProgressBar, Segmented, Select, Tag, TextArea, TextInput } from "../ui/kit";
import { Icon } from "../ui/icons";
import { attempt, getState, openSettings, patchAccount, refreshWorkspace, setSection, setState, toast, useStore } from "../state/store";
import { MailPanel } from "./panels/MailPanel";
import { CallApps } from "./settings/OutreachSection";
import { ImportDialog } from "./crm/ImportDialog";
import { Brand } from "./Auth";

export const CURRENCIES = [
  { value: "RUB", label: "₽ Российский рубль" },
  { value: "USD", label: "$ Доллар США" },
  { value: "EUR", label: "€ Евро" },
  { value: "KZT", label: "₸ Казахстанский тенге" },
  { value: "BYN", label: "Br Белорусский рубль" },
  { value: "UZS", label: "сум Узбекский сум" },
];

/** Название по умолчанию: имя Workspace, если пользователь уже его менял. */
const PERSONAL = /^Личное пространство/;

/** Шаблон воронки к воронке по умолчанию активного Workspace. Возвращает текст для пользователя или null. */
export async function applyTemplate(id: TemplateId): Promise<string | null> {
  const tpl = PIPELINE_TEMPLATES.find((t) => t.id === id);
  if (!tpl) return null;
  const [pipelines, stages, deals] = await Promise.all([api.wsList("pipelines", { limit: 500 }), api.wsList("pipeline_stages", { limit: 5000 }), api.wsList("deals", { limit: 1 })]);
  // Этапы со сделками не трогаем: мастер не должен перекладывать чужие данные.
  if (deals.total > 0 || deals.items.length > 0) return "В воронке уже есть сделки, этапы не изменены. Настроить их можно в настройках Workspace.";
  const alive = pipelines.items.filter((p) => !p.deleted_at);
  const pipe = alive.find((p) => p.is_default) ?? alive[0];
  if (!pipe) return "Воронка ещё загружается. Этапы можно настроить позже в настройках Workspace.";
  const plan = planStages(stages.items, pipe.id, tpl);
  for (const u of plan.update) await api.wsSave("pipeline_stages", u.id, u.patch);
  for (const c of plan.create) await api.wsSave("pipeline_stages", null, c);
  for (const r of plan.remove) await api.wsDelete("pipeline_stages", r);
  return null;
}

interface Setup {
  name: string;
  currency: string;
  team: boolean;
  template: TemplateId;
  thenSearch: boolean;
  added: number;
  signature: string;
}

export function Welcome() {
  const [flow, setFlow] = useState<WelcomeFlow>(newFlow());
  const [busy, setBusy] = useState(false);
  const step = stepOf(flow);
  const name = useStore((s) => s.session?.displayName);
  const ws = useStore((s) => s.ws);
  const account = useStore((s) => s.account);
  const active = ws?.workspaces.find((w) => w.id === ws.active);
  const [setup, setSetup] = useState<Setup>(() => ({
    name: active && !PERSONAL.test(active.name) ? active.name : "",
    currency: active?.defaultCurrency || "RUB",
    team: false,
    template: "services",
    thenSearch: false,
    added: 0,
    signature: account?.signature ?? "",
  }));
  const patch = (p: Partial<Setup>) => setSetup((s) => ({ ...s, ...p }));

  const done = async () => {
    await patchAccount({ welcomeDone: true });
    setState({ phase: "ready" });
    if (setup.thenSearch) { setSection("home"); openSettings("search"); } else if (getState().ws) setSection("today");
  };

  /** Что сохраняет шаг при «Далее». false — остаться на шаге (ошибка показана). */
  const save = async (): Promise<boolean> => {
    if (step.id === "company") {
      const title = setup.name.trim();
      if (!title) return true;
      const cloudTeam = setup.team && ws?.isCloud;
      const r = await attempt(() => (cloudTeam ? api.wsCreateWorkspace(title) : active?.remote ? api.wsRenameWorkspace(title) : api.wsSetLocalDetails(title, setup.currency)));
      if (!r) return false;
      await refreshWorkspace();
    }
    if (step.id === "pipeline") {
      const note = await attempt(() => applyTemplate(setup.template));
      if (note === undefined) return false;
      if (note) toast(note);
      await refreshWorkspace();
    }
    if (step.id === "comms" && setup.signature !== (account?.signature ?? "")) await patchAccount({ signature: setup.signature });
    return true;
  };
  const go = async (f: WelcomeFlow) => { setFlow(f); if (f.finished) await done(); };
  const forward = async () => {
    setBusy(true);
    const ok = await save();
    setBusy(false);
    if (ok) await go(isLast(flow) ? finish(flow) : next(flow));
  };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <header className="welcome-head">
          <div className="row"><Brand size={32} /><span className="faint">{position(flow)}</span><span className="grow" /><Button variant="ghost" small onClick={() => void done()}>Пропустить настройку</Button></div>
          <ProgressBar value={progress(flow)} label="Ход настройки" />
          <h1>{step.id === "intro" ? `Добро пожаловать${name ? `, ${name}` : ""}` : step.title}</h1>
        </header>
        <div className="welcome-body">
          {step.id === "intro" && <Intro />}
          {step.id === "company" && <CompanyStep setup={setup} patch={patch} cloud={!!ws?.isCloud} />}
          {step.id === "pipeline" && <PipelineStep value={setup.template} onChange={(template) => patch({ template })} />}
          {step.id === "clients" && <ClientsStep setup={setup} patch={patch} />}
          {step.id === "comms" && <CommsStep signature={setup.signature} onSignature={(signature) => patch({ signature })} />}
        </div>
        <footer className="welcome-foot">
          {canGoBack(flow) && <Button onClick={() => setFlow(back(flow))}>Назад</Button>}
          <span className="grow" />
          {canSkip(flow) && <Button variant="ghost" onClick={() => void go(skip(flow))}>Позже</Button>}
          <Button variant="primary" busy={busy} onClick={() => void forward()}>{step.id === "intro" ? "Начать" : isLast(flow) ? "Начать работу" : "Далее"}</Button>
        </footer>
      </div>
    </div>
  );
}

function Intro() {
  const items: [string, string, string][] = [
    ["list", "Клиенты и сделки", "Компании, контакты, сделки на доске этапов, задачи, календарь и отчёты."],
    ["search", "Поиск новых клиентов", "Заказы из RSS, Telegram и VK, организации с карт — с оценкой и переносом в CRM в один клик."],
    ["lock", "Данные у вас", "База зашифрована на компьютере. Облако нужно только для работы командой."],
  ];
  return (
    <>
      <p className="muted" style={{ marginBottom: 12 }}>Customers — CRM для небольшой компании: клиенты, сделки, задачи и звонки в одном окне. За пару минут настроим всё под вас.</p>
      <ul className="intro">
        {items.map(([icon, title, text]) => (
          <li key={title}><span className="intro-ico"><Icon name={icon} size={18} /></span><div className="col" style={{ gap: 2 }}><strong>{title}</strong><span className="muted">{text}</span></div></li>
        ))}
      </ul>
    </>
  );
}

function CompanyStep({ setup, patch, cloud }: { setup: Setup; patch: (p: Partial<Setup>) => void; cloud: boolean }) {
  // Валюта облачного Workspace задаётся на сервере: мастер меняет её только у Workspace на этом устройстве.
  const currencyHere = !(setup.team && cloud);
  return (
    <div className="col" style={{ gap: 14 }}>
      <Field label="Название"><TextInput value={setup.name} onChange={(name) => patch({ name })} placeholder="Например, Студия «Пиксель»" maxLength={120} autoFocus /></Field>
      {currencyHere && <Field label="Основная валюта сделок"><Select value={setup.currency} options={CURRENCIES} onChange={(currency) => patch({ currency })} /></Field>}
      <Field label="Как вы работаете">
        <Segmented value={setup.team ? "team" : "solo"} onChange={(v) => patch({ team: v === "team" })} options={[{ value: "solo", label: "Один" }, { value: "team", label: "С командой" }]} />
      </Field>
      <p className="faint" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>
        {setup.team
          ? cloud
            ? "«С командой» создаёт облачный Workspace; пригласить коллег можно позже в разделе «Команда»."
            : "Работа командой — в облачной учётной записи. Пока всё будет на этом компьютере; облако можно подключить позже в настройках учётной записи."
          : "Без облака всё работает на этом компьютере."}
      </p>
    </div>
  );
}

function PipelineStep({ value, onChange }: { value: TemplateId; onChange: (v: TemplateId) => void }) {
  return (
    <div className="col" role="radiogroup" aria-label="Шаблон воронки" style={{ gap: 10 }}>
      <p className="muted" style={{ margin: 0 }}>Готовые этапы под тип бизнеса. Поменять их можно потом в настройках Workspace.</p>
      {PIPELINE_TEMPLATES.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={value === t.id} className={`tpl-option${value === t.id ? " on" : ""}`} onClick={() => onChange(t.id)}>
          <span className="tpl-radio" aria-hidden="true" />
          <span className="col grow" style={{ gap: 6, alignItems: "flex-start" }}>
            <strong>{t.title}</strong>
            <span className="muted">{t.hint}</span>
            <span className="tpl-stages">{t.open.map((s) => <Tag key={s}>{s}</Tag>)}<Tag tone="green">{t.won}</Tag></span>
          </span>
        </button>
      ))}
    </div>
  );
}

function ClientsStep({ setup, patch }: { setup: Setup; patch: (p: Partial<Setup>) => void }) {
  const [importing, setImporting] = useState(false);
  const [manual, setManual] = useState(false);
  const [company, setCompany] = useState("");
  const add = async () => {
    const title = company.trim();
    if (!title) return;
    if (await attempt(() => api.wsSave("companies", null, { name: title }))) { setCompany(""); patch({ added: setup.added + 1 }); toast(`Компания «${title}» добавлена`, "success"); }
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="start-option">
        <span className="intro-ico"><Icon name="upload" size={18} /></span>
        <div className="col grow" style={{ gap: 2 }}><strong>Из Excel или CSV</strong><span className="muted">Перенесите клиентов из таблицы или другой CRM. Колонки сопоставятся сами.</span></div>
        <Button onClick={() => setImporting(true)}>Выбрать файл</Button>
      </div>
      <div className="start-option">
        <span className="intro-ico"><Icon name="plus" size={18} /></span>
        <div className="col grow" style={{ gap: 6 }}>
          <strong>Вручную</strong>
          <span className="muted">Добавьте первую компанию и контакт.{setup.added ? ` Добавлено: ${setup.added}.` : ""}</span>
          {manual && (
            <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void add(); }}>
              <TextInput value={company} onChange={setCompany} placeholder="Название компании" aria-label="Название компании" autoFocus wrapClass="grow" />
              <Button type="submit" variant="primary" disabled={!company.trim()}>Сохранить</Button>
            </form>
          )}
        </div>
        {!manual && <Button onClick={() => setManual(true)}>Добавить</Button>}
      </div>
      <div className="start-option">
        <span className="intro-ico"><Icon name="search" size={18} /></span>
        <div className="col grow" style={{ gap: 2 }}><strong>Найти новых</strong><span className="muted">Выбрать город и каналы для поиска заказов и организаций.</span></div>
        {setup.thenSearch ? <Button variant="ghost" icon="check" onClick={() => patch({ thenSearch: false })}>После мастера</Button> : <Button onClick={() => patch({ thenSearch: true })}>Настроить поиск</Button>}
      </div>
      <p className="faint" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>После импорта или добавления мастер продолжится с этого шага.</p>
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}

function CommsStep({ signature, onSignature }: { signature: string; onSignature: (v: string) => void }) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <p className="muted" style={{ marginBottom: 8 }}>Чтобы «Позвонить» и «Написать» в карточке клиента работали сразу.</p>
      <h2 className="welcome-sub">Письма</h2>
      <Group><MailPanel /></Group>
      <h2 className="welcome-sub">Подпись в письмах</h2>
      <TextArea value={signature} onChange={onSignature} rows={3} placeholder={"Анна Смирнова, Студия «Пиксель»\n+7 900 000-00-00"} aria-label="Подпись в письмах" />
      <h2 className="welcome-sub">Звонки</h2>
      <Group><CallApps /></Group>
    </div>
  );
}
