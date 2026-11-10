// Debug Menu — только в Beta. Загружается отдельным модулем (import()) лишь когда открыт в Beta;
// в Stable ядро не знает его команд. Все значения — из ядра; если показатель недоступен, так и написано.

import { useCallback, useEffect, useMemo, useState } from "react";
import { toCmdError } from "../api/backend";
import { copyText, pickSavePath } from "../lib/platform";
import { getState, openDebug, patchDevice, toast, useStore } from "../state/store";
import { Icon } from "../ui/icons";
import { Button, Checkbox, EmptyState, NumberInput, Segmented, Select, Spinner, Tabs, Tag, TextInput } from "../ui/kit";
import { Dialog } from "../ui/overlay";
import {
  type Check, type Dashboard, debugApi, LEVELS, type Level, type LogEntry, type LogQuery, type ScenarioInfo, type ScenarioReport, type TestDataState,
} from "./api";

type Tab = "dashboard" | "scenarios" | "data" | "logs" | "diagnostics" | "ui";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "chart" },
  { id: "scenarios", label: "Сценарии", icon: "play" },
  { id: "data", label: "Тестовые данные", icon: "database" },
  { id: "logs", label: "Журнал", icon: "list" },
  { id: "diagnostics", label: "Диагностика", icon: "shield" },
  { id: "ui", label: "Интерфейс", icon: "eye" },
];

const fail = (e: unknown) => toast(toCmdError(e).message, "error");
const noData = "нет данных";

export default function DebugMenu() {
  const [tab, setTab] = useState<Tab>("dashboard");
  return (
    <Dialog title="Debug Menu" onClose={() => openDebug(false)} width={920} className="debug-menu">
      <Tabs value={tab} tabs={TABS} onChange={setTab} />
      <div className="debug-pane">
        {tab === "dashboard" && <DashboardPane />}
        {tab === "scenarios" && <ScenariosPane />}
        {tab === "data" && <TestDataPane />}
        {tab === "logs" && <LogsPane />}
        {tab === "diagnostics" && <DiagnosticsPane />}
        {tab === "ui" && <UiPane />}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Dashboard

function duration(secs: number) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? `${h} ч ${m} мин` : m ? `${m} мин ${secs % 60} с` : `${secs} с`;
}

const TONE: Record<string, "green" | "gray" | "blue" | "orange" | "red"> = { ok: "green", off: "gray", busy: "blue", warning: "orange", error: "red" };
const STATE_LABEL: Record<string, string> = { ok: "работает", off: "выключено", busy: "занято", warning: "внимание", error: "ошибка" };

function DashboardPane() {
  const [d, setD] = useState<Dashboard | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => debugApi.dashboard().then((v) => { if (alive) setD(v); }).catch(fail);
    void load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (!d) return <div className="debug-center"><Spinner /></div>;
  const w = d.window;
  const rows: [string, string][] = [
    ["Версия", `${d.version} (${d.channel}, ${d.buildProfile})`],
    ["Идентификатор", d.identifier],
    ["Git", d.gitCommit ? `${d.gitCommit}${d.gitBranch ? ` · ${d.gitBranch}` : ""}` : noData],
    ["Система", [d.os, d.osVersion].filter(Boolean).join(" ") || noData],
    ["Ядро ОС", d.kernel ?? noData],
    ["Архитектура", d.arch],
    ["Tauri", d.tauri],
    ["WebView", d.webview ?? noData],
    ["Окно", w.logicalWidth != null && w.logicalHeight != null ? `${Math.round(w.logicalWidth)}×${Math.round(w.logicalHeight)} pt (${w.physicalWidth}×${w.physicalHeight} px)` : noData],
    ["Масштаб", `${w.scaleFactor != null ? `система ${Math.round(w.scaleFactor * 100)} %` : noData} · devicePixelRatio ${window.devicePixelRatio} · интерфейс ${Math.round(getState().device.uiScale * 100)} %`],
    ["Время работы", duration(d.uptimeSecs)],
    ["Процесс", d.pid != null ? `PID ${d.pid}` : noData],
    ["Память", d.memoryBytes != null ? `${(d.memoryBytes / 1048576).toFixed(1)} МБ` : noData],
    ["Процессор", d.cpuPercent != null ? `${d.cpuPercent.toFixed(1)} %` : "измеряется…"],
    ["Данные", d.dataDir],
    ["Журналы", d.logsDir],
  ];
  return (
    <div className="debug-grid">
      <dl className="kv debug-kv selectable">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <div className="debug-components">
        <h4>Компоненты</h4>
        {d.components.map((c) => (
          <div key={c.name} className="debug-row">
            <span className="grow">{c.name}</span>
            <Tag tone={TONE[c.state] ?? "gray"}>{STATE_LABEL[c.state] ?? c.state}</Tag>
            <div className="debug-sub selectable">{c.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ сценарии

const STATUS_TONE = { PASS: "green", FAIL: "red", SKIPPED: "orange" } as const;

function ScenariosPane() {
  const [list, setList] = useState<ScenarioInfo[]>([]);
  const [report, setReport] = useState<ScenarioReport | null>(null);
  const [running, setRunning] = useState<string[] | null>(null);
  useEffect(() => { debugApi.scenarios().then(setList).catch(fail); }, []);
  const run = useCallback(async (ids: string[]) => {
    setRunning(ids);
    try {
      const r = await debugApi.runScenarios(ids);
      // Повтор части сценариев обновляет только их строки.
      setReport((prev) => (prev && ids.length ? { ...r, results: prev.results.filter((x) => !ids.includes(x.id)).concat(r.results) } : r));
    } catch (e) { fail(e); } finally { setRunning(null); }
  }, []);
  const byId = useMemo(() => new Map((report?.results ?? []).map((r) => [r.id, r])), [report]);
  const failed = (report?.results ?? []).filter((r) => r.status === "FAIL").map((r) => r.id);
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0 };
  for (const r of byId.values()) counts[r.status] += 1;
  return (
    <div className="debug-col">
      <div className="debug-toolbar">
        <Button variant="primary" icon="play" busy={running?.length === 0} disabled={running !== null} onClick={() => void run([])}>Запустить все</Button>
        <Button icon="refresh" disabled={running !== null || failed.length === 0} onClick={() => void run(failed)}>Повторить неудачные</Button>
        <span className="grow" />
        {report && (
          <span className="debug-summary" aria-label="Итог">
            <Tag tone="green">PASS {counts.PASS}</Tag> <Tag tone="red">FAIL {counts.FAIL}</Tag> <Tag tone="orange">SKIPPED {counts.SKIPPED}</Tag>
          </span>
        )}
      </div>
      <div className="debug-list">
        {list.map((s) => {
          const r = byId.get(s.id);
          return (
            <div key={s.id} className="debug-row" data-scenario={s.id}>
              <span className="debug-group">{s.group}</span>
              <span className="grow" title={s.description}>{s.title}</span>
              {r && <span className="debug-ms">{r.durationMs} мс</span>}
              {running?.includes(s.id) || (running?.length === 0) ? <Spinner size={14} /> : r ? <Tag tone={STATUS_TONE[r.status]}>{r.status}</Tag> : <Tag>не запускался</Tag>}
              <Button small icon="play" disabled={running !== null} onClick={() => void run([s.id])} aria-label={`Запустить «${s.title}»`}>Запустить</Button>
              {r?.error && <div className="debug-sub debug-error selectable">{r.error}</div>}
              {r && r.details.length > 0 && <div className="debug-sub selectable">{r.details.join(" · ")}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ тестовые данные

function TestDataPane() {
  const [st, setSt] = useState<TestDataState | null>(null);
  const [count, setCount] = useState(1000);
  const [seed, setSeed] = useState(1);
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => debugApi.testDataState().then(setSt).catch(fail);
  useEffect(() => { void refresh(); }, []);
  const act = async (name: string, f: () => Promise<string>) => {
    setBusy(name);
    try { toast(await f(), "success"); } catch (e) { fail(e); } finally { setBusy(null); void refresh(); }
  };
  if (!st) return <div className="debug-center"><Spinner /></div>;
  if (!st.hasSession) return <EmptyState icon="user" title="Нет входа">Войдите в локальную учётную запись Beta, чтобы работать с тестовыми данными.</EmptyState>;
  return (
    <div className="debug-col">
      <div className="debug-row">
        <span className="grow">Учётная запись тестовая</span>
        <Checkbox checked={st.isTest} disabled={!st.canMark || busy !== null} onChange={(on) => void act("mark", async () => { await debugApi.markTestAccount(on); return on ? "Учётная запись помечена тестовой" : "Метка снята"; })} />
        <div className="debug-sub">{st.reason ?? "Генерация, очистка и сброс работают только в учётной записи с этой отметкой."}</div>
      </div>
      <div className="debug-row">
        <span className="grow">Лидов в базе: {st.totalLeads}, из них тестовых: {st.testLeads}</span>
      </div>
      <div className="debug-toolbar">
        <span>Количество</span><NumberInput value={count} onChange={setCount} min={1} max={50000} step={100} width={110} />
        <span>seed</span><NumberInput value={seed} onChange={setSeed} min={0} max={1_000_000} width={100} />
        <Button variant="primary" icon="plus" busy={busy === "gen"} disabled={!st.isTest || busy !== null} onClick={() => void act("gen", async () => {
          const g = await debugApi.generate(count, seed);
          return `Создано лидов: ${g.added}${g.skipped ? `, пропущено дублей: ${g.skipped}` : ""} за ${g.durationMs} мс`;
        })}>Создать лиды</Button>
        <Button icon="trash" busy={busy === "clear"} disabled={!st.isTest || busy !== null || st.testLeads === 0} onClick={() => void act("clear", async () => `Удалено тестовых лидов: ${await debugApi.clearTestData()}`)}>Удалить тестовые</Button>
      </div>
      <p className="debug-note">Компании, контакты, сделки и задачи появятся в генераторе вместе с этими разделами CRM (этапы 4–7).</p>
      <div className="debug-toolbar debug-danger">
        <span>Сброс к исходному состоянию — удалит все лиды, историю и исключения этой учётной записи. Введите «сброс»:</span>
        <TextInput value={word} onChange={setWord} placeholder="сброс" className="debug-word" />
        <Button variant="danger" busy={busy === "reset"} disabled={!st.isTest || busy !== null || word.trim().toLowerCase() !== "сброс"} onClick={() => void act("reset", async () => { await debugApi.resetTestAccount(word); setWord(""); return "Учётная запись сброшена"; })}>Сбросить</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ журнал

const PERIODS = [
  { value: 0, label: "За всё время" },
  { value: 15, label: "15 минут" },
  { value: 60, label: "1 час" },
  { value: 1440, label: "24 часа" },
];

const LEVEL_TONE: Record<Level, "gray" | "blue" | "orange" | "red" | "purple"> = { DEBUG: "gray", INFO: "blue", WARNING: "orange", ERROR: "red", CRITICAL: "purple" };

function LogsPane() {
  const [levels, setLevels] = useState<Level[]>([]);
  const [text, setText] = useState("");
  const [minutes, setMinutes] = useState(0);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const query = useMemo<LogQuery>(() => ({ levels, text, since: minutes ? new Date(Date.now() - minutes * 60_000).toISOString() : null, limit: 1000 }), [levels, text, minutes]);
  useEffect(() => {
    let alive = true;
    const load = () => debugApi.logs(query).then((v) => { if (alive) setEntries(v); }).catch(fail);
    void load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [query]);
  const toggle = (l: Level, on: boolean) => setLevels((cur) => (on ? [...cur, l] : cur.filter((x) => x !== l)));
  const asText = () => entries.map((e) => `${e.at} ${e.level} [${e.module}] ${e.message}`).join("\n");
  return (
    <div className="debug-col">
      <div className="debug-toolbar">
        {LEVELS.map((l) => <Checkbox key={l} checked={levels.includes(l)} onChange={(on) => toggle(l, on)} label={l} />)}
      </div>
      <div className="debug-toolbar">
        <TextInput value={text} onChange={setText} icon="search" placeholder="Поиск в журнале" onClear={() => setText("")} wrapClass="grow" />
        <Select value={minutes} options={PERIODS} onChange={setMinutes} width={150} />
        <Button icon="copy" onClick={() => void copyText(asText()).then(() => toast("Скопировано", "success"))}>Копировать</Button>
        <Button icon="download" onClick={async () => {
          const path = await pickSavePath("Сохранить журнал", "customers-beta-events.jsonl", "jsonl");
          if (path) debugApi.exportLogs(query, path).then((m) => toast(m, "success")).catch(fail);
        }}>Экспорт</Button>
        <Button icon="trash" onClick={() => void debugApi.clearLogs().then(() => setEntries([])).catch(fail)}>Очистить</Button>
      </div>
      <div className="debug-log selectable" role="log">
        {entries.length === 0 && <div className="debug-note">Записей нет.</div>}
        {entries.slice().reverse().map((e) => (
          <div key={e.seq} className="debug-log-row">
            <span className="debug-ms">{e.at.replace("T", " ").slice(0, 19)}</span>
            <Tag tone={LEVEL_TONE[e.level]}>{e.level}</Tag>
            <span className="debug-group">{e.module}</span>
            <span className="grow">{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ диагностика

const CHECK_TONE = { pass: "green", warn: "orange", fail: "red", skipped: "gray" } as const;
const CHECK_LABEL = { pass: "OK", warn: "внимание", fail: "ошибка", skipped: "пропущено" } as const;

function DiagnosticsPane() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setChecks(await debugApi.diagnostics()); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  useEffect(() => { void run(); }, []);
  return (
    <div className="debug-col">
      <div className="debug-toolbar">
        <Button icon="refresh" busy={busy} onClick={() => void run()}>Проверить снова</Button>
        <Button icon="download" onClick={async () => {
          const stamp = new Date().toISOString().slice(0, 10);
          const path = await pickSavePath("Сохранить отчёт диагностики", `diagnostics-${stamp}.zip`, "zip");
          if (path) debugApi.exportDiagnostics(path).then((p) => toast(`Отчёт сохранён: ${p}`, "success")).catch(fail);
        }}>Отчёт ZIP</Button>
        <span className="grow" />
        <span className="debug-note">В отчёт не входят базы, ключи и пароли; почта, телефоны и пути скрыты.</span>
      </div>
      <div className="debug-list">
        {checks?.map((c) => (
          <div key={c.id} className="debug-row" data-check={c.id}>
            <span className="grow">{c.title}</span>
            <Tag tone={CHECK_TONE[c.status]}>{CHECK_LABEL[c.status]}</Tag>
            <div className="debug-sub selectable">{c.detail}{c.hint ? ` — ${c.hint}` : ""}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ проверка интерфейса

const SIZES: [number, number][] = [[880, 560], [1024, 700], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440]];
const ZOOMS = [1, 1.25, 1.5, 1.75, 2];

/** Элементы, у которых содержимое выходит за край, хотя прокрутки нет: признак сломанной раскладки. */
export function findOverflow(root: ParentNode = document): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("body *")) {
    if (el.closest(".debug-menu")) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || el.clientWidth === 0) continue;
    const clipsX = cs.overflowX !== "visible";
    if (!clipsX && el.scrollWidth > el.clientWidth + 1 && el.children.length === 0) {
      out.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : ""}: ${el.scrollWidth}>${el.clientWidth}`);
    }
  }
  return out;
}

function UiPane() {
  const device = useStore((s) => s.device);
  const [overflow, setOverflow] = useState<string[] | null>(null);
  return (
    <div className="debug-col">
      <div className="debug-row"><span className="grow">Размер окна</span></div>
      <div className="debug-toolbar">
        {SIZES.map(([w, h]) => <Button key={`${w}x${h}`} small onClick={() => void debugApi.setWindowSize(w, h).catch(fail)}>{w}×{h}</Button>)}
      </div>
      <div className="debug-row"><span className="grow">Масштаб интерфейса</span></div>
      <div className="debug-toolbar">
        <Segmented value={ZOOMS.includes(device.uiScale) ? device.uiScale : 1} options={ZOOMS.map((z) => ({ value: z, label: `${Math.round(z * 100)} %` }))} onChange={(v) => void patchDevice({ uiScale: v })} />
      </div>
      <div className="debug-toolbar">
        <Checkbox checked={device.navOpen} onChange={(on) => void patchDevice({ navOpen: on })} label="Левая панель развёрнута" />
        <Checkbox checked={device.inspectorShown} onChange={(on) => void patchDevice({ inspectorShown: on })} label="Правая панель показана" />
        <Checkbox checked={device.compactRows} onChange={(on) => void patchDevice({ compactRows: on })} label="Компактные строки" />
      </div>
      <div className="debug-toolbar">
        <Button icon="search" onClick={() => setOverflow(findOverflow())}>Найти переполнение</Button>
        {overflow && <span className="debug-note">{overflow.length ? `Найдено: ${overflow.length}` : "Переполнения нет"}</span>}
      </div>
      {overflow && overflow.length > 0 && <div className="debug-log selectable">{overflow.map((o) => <div key={o} className="debug-log-row"><Icon name="alert" size={13} /> {o}</div>)}</div>}
      <p className="debug-note">Снимки окна при разных размерах и масштабах: npm run shots. Переключение рабочих пространств появится с этапом 3.</p>
    </div>
  );
}
