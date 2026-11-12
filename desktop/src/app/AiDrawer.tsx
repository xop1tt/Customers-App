// Чат Ai: выдвижная панель, прикреплённая к кнопке «Ai» в нижней части рейки. Остаётся открытой при смене раздела и вкладки,
// растягивается за верхний и правый край. Здесь же — вложения (файлы), карточки подтверждения действий и кнопка настроек Ai.

import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Button, EmptyState, IconButton, Notice, Tag } from "../ui/kit";
import { Icon } from "../ui/icons";
import { type ViewItem, answerAction, askAi, clearChat, stopChat, useAi } from "../state/ai";
import { useHub } from "../state/hub";
import { openSettings, toast, toggleAi, useStore } from "../state/store";
import { AI_PROVIDERS } from "../lib/hub";
import type { AiRisk } from "../lib/aiTools";
import { type AiAttachment, MAX_FILES, acceptList, readAttachment, refusal } from "../lib/aiFiles";
import { RAIL_W } from "./ModuleRail";

const RISK_TEXT: Record<AiRisk, { text: string; tone: "gray" | "orange" | "red" | "blue" }> = {
  read: { text: "Чтение", tone: "gray" }, nav: { text: "Переход", tone: "gray" }, setting: { text: "Настройка", tone: "blue" },
  soft: { text: "Правка", tone: "blue" }, write: { text: "Изменение данных", tone: "orange" }, external: { text: "Уходит наружу", tone: "orange" }, danger: { text: "Удаление", tone: "red" },
};
const STATUS_TEXT = { pending: "Ждёт вашего решения", running: "Выполняется…", done: "Выполнено", rejected: "Отклонено", error: "Ошибка" } as const;

const SIZE_KEY = "customers.aiDrawer";
const MIN_W = 340;
const MIN_H = 320;
const loadSize = (): { w: number; h: number } => {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null") as { w?: number; h?: number } | null;
    if (v && typeof v.w === "number" && typeof v.h === "number") return { w: v.w, h: v.h };
  } catch { /* размер не сохранился — берём обычный */ }
  return { w: 420, h: 560 };
};
const saveSize = (s: { w: number; h: number }) => { try { localStorage.setItem(SIZE_KEY, JSON.stringify(s)); } catch { /* не критично */ } };

/** Размер не больше окна: панель не должна выходить за экран, даже если окно стало меньше. */
const fit = (s: { w: number; h: number }) => ({
  w: Math.max(Math.min(MIN_W, window.innerWidth - RAIL_W - 16), Math.min(s.w, window.innerWidth - RAIL_W - 16)),
  h: Math.max(Math.min(MIN_H, window.innerHeight - 16), Math.min(s.h, window.innerHeight - 16)),
});

export function AiDrawer() {
  const aiOn = useHub().ai.enabled;
  const open = useStore((s) => s.aiOpen) && aiOn;
  const [size, setSize] = useState(() => fit(loadSize()));
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useEffect(() => {
    const on = () => setSize((s) => fit(s));
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  if (!open) return null;

  const drag = (axis: "w" | "h" | "both") => (e: RPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, ...sizeRef.current };
    const move = (m: PointerEvent) => setSize(fit({ w: axis === "h" ? start.w : start.w + (m.clientX - start.x), h: axis === "w" ? start.h : start.h - (m.clientY - start.y) }));
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); saveSize(sizeRef.current); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const key = (axis: "w" | "h") => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 60 : 20;
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
    if (!d) return;
    e.preventDefault();
    const next = fit({ w: size.w + (axis === "w" ? d : 0), h: size.h + (axis === "h" ? d : 0) });
    setSize(next);
    saveSize(next);
  };

  return (
    <section id="ai-drawer" className="ai-drawer" role="complementary" aria-label="Чат Ai" style={{ left: RAIL_W + 8, width: size.w, height: size.h }}
      onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); toggleAi(false); document.getElementById("ai-toggle")?.focus(); } }}>
      <div className="ai-grip ai-grip-top" role="separator" aria-orientation="horizontal" aria-label="Высота чата" tabIndex={0} onPointerDown={drag("h")} onKeyDown={key("h")} />
      <div className="ai-grip ai-grip-right" role="separator" aria-orientation="vertical" aria-label="Ширина чата" tabIndex={0} onPointerDown={drag("w")} onKeyDown={key("w")} />
      <div className="ai-grip ai-grip-corner" aria-hidden="true" onPointerDown={drag("both")} />
      <AiChat />
    </section>
  );
}

function AiChat() {
  const { ai } = useHub();
  const { view, busy } = useAi();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<AiAttachment[]>([]);
  const [over, setOver] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [view.length, busy]);
  const ready = ai.enabled && !!ai.baseUrl && !!ai.model;
  const provider = AI_PROVIDERS.find((p) => p.id === ai.provider)?.title ?? "Модель";
  const send = () => {
    const t = text.trim();
    if ((!t && !files.length) || busy || !ready) return;
    const f = files;
    setText(""); setFiles([]);
    void askAi(t || "Посмотри вложенные файлы.", f);
  };

  const add = async (list: FileList | File[]) => {
    const incoming = [...list];
    let room = MAX_FILES - files.length;
    const got: AiAttachment[] = [];
    for (const f of incoming) {
      const why = refusal(f.name, f.type, f.size, ai.vision, ai.audio);
      if (why) { toast(why, "error"); continue; }
      if (room <= 0) { toast(`Не больше ${MAX_FILES} файлов в одном сообщении.`, "error"); break; }
      try { got.push(await readAttachment(f)); room--; } catch (e) { toast((e as Error).message, "error"); }
    }
    if (got.length) setFiles((cur) => [...cur, ...got].slice(0, MAX_FILES));
  };

  return (
    <div className={`ai-chat${over ? " over" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); setOver(false); void add(e.dataTransfer.files); } }}>
      <header className="ai-head">
        <Icon name="bot" size={16} />
        <strong>Ai</strong>
        {ready && <Tag tone="green">{provider}: {ai.model}</Tag>}
        <span className="grow" />
        <IconButton icon="trash" tip="Очистить разговор" disabled={!view.length} onClick={clearChat} />
        <IconButton icon="settings" tip="Настройки Ai" onClick={() => openSettings("ai")} />
        <IconButton icon="x" tip="Закрыть чат" onClick={() => { toggleAi(false); document.getElementById("ai-toggle")?.focus(); }} />
      </header>
      {!ready ? (
        <div className="ai-empty">
          <EmptyState icon="bot" title="Подключите локальную модель"
            action={<Button variant="primary" icon="settings" onClick={() => openSettings("ai")}>Открыть настройки Ai</Button>}>
            Работает с LM Studio, Ollama и другими серверами с OpenAI-совместимым API. Модель запускается на вашем компьютере, разговор никуда не уходит.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="ai-log" role="log" aria-label="Разговор с помощником" aria-live="polite">
            {view.length === 0 && (
              <div className="ai-hint faint">
                <p>Попросите что-нибудь сделать в приложении{ai.vision ? ", можно приложить картинку или файл" : " или приложите файл"}:</p>
                <ul>
                  {["Сколько новых лидов и когда был последний поиск?", "Перенеси завтрашнюю встречу на пятницу, 15:00", "Назначь Анну ответственной за сделку «Поставка»", "Создай задачу «Позвонить клиенту» на завтра"].map((x) => (
                    <li key={x}><button type="button" className="link-btn" onClick={() => setText(x)}>{x}</button></li>
                  ))}
                </ul>
              </div>
            )}
            {view.map((v) => <Item key={v.id} v={v} />)}
            {busy && <div className="ai-msg assistant faint" role="status">Модель думает…</div>}
            <div ref={end} />
          </div>
          {files.length > 0 && (
            <ul className="ai-files" aria-label="Вложения">
              {files.map((f) => (
                <li key={f.id} className="ai-file">
                  <Icon name={f.kind === "image" ? "image" : f.kind === "audio" ? "mic" : "file"} size={13} />
                  <span className="ellipsis" title={f.name}>{f.name}</span>
                  {f.truncated && <span className="faint">начало</span>}
                  <IconButton icon="x" size={12} tip={`Убрать «${f.name}»`} onClick={() => setFiles((c) => c.filter((x) => x.id !== f.id))} />
                </li>
              ))}
            </ul>
          )}
          <form className="ai-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input ref={pick} type="file" multiple hidden aria-label="Выбрать файлы" accept={acceptList(ai.vision, ai.audio)}
              onChange={(e) => { if (e.target.files) void add(e.target.files); e.target.value = ""; }} />
            <IconButton icon="paperclip" tip="Приложить файл" disabled={busy || files.length >= MAX_FILES} onClick={() => pick.current?.click()} />
            <textarea aria-label="Сообщение помощнику" value={text} rows={2} placeholder="Что сделать? Enter — отправить, Shift+Enter — новая строка"
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void add(e.clipboardData.files); } }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
            {busy ? <Button icon="x" onClick={stopChat}>Стоп</Button> : <Button variant="primary" icon="send" type="submit" disabled={!text.trim() && !files.length}>Отправить</Button>}
          </form>
        </>
      )}
    </div>
  );
}

function Item({ v }: { v: ViewItem }) {
  if (v.kind === "action") {
    const r = RISK_TEXT[v.risk];
    return (
      <div className={`ai-action ${v.status}`} role="group" aria-label={`Действие: ${v.summary}`}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Icon name={v.risk === "danger" ? "alert" : "sparkles"} size={15} />
          <span className="grow selectable">{v.summary}</span>
          <Tag tone={r.tone}>{r.text}</Tag>
        </div>
        {v.status === "pending" ? (
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <Button small variant={v.risk === "danger" ? "danger" : "primary"} onClick={() => answerAction(v.id, true)}>Выполнить</Button>
            <Button small onClick={() => answerAction(v.id, false)}>Отклонить</Button>
          </div>
        ) : (
          <div className="faint ai-status">{STATUS_TEXT[v.status]}{v.result ? ` · ${v.result}` : ""}</div>
        )}
      </div>
    );
  }
  if (v.kind === "error") return <Notice tone="error">{v.text}</Notice>;
  return (
    <div className={`ai-msg ${v.kind} selectable`}>
      {v.text}
      {v.kind === "user" && v.files && <div className="ai-msg-files faint"><Icon name="paperclip" size={12} /> {v.files.join(", ")}</div>}
    </div>
  );
}
