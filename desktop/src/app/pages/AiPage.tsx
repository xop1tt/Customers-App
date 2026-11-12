// Вкладка «Ai»: разговор с локальной моделью, которая может управлять приложением. Изменения — только после подтверждения по режиму из настроек.

import { useEffect, useRef, useState } from "react";
import { Button, EmptyState, Notice, Tag } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { type ViewItem, answerAction, askAi, clearChat, stopChat, useAi } from "../../state/ai";
import { useHub } from "../../state/hub";
import { openSettings } from "../../state/store";
import { AI_PROVIDERS } from "../../lib/hub";
import type { AiRisk } from "../../lib/aiTools";

const RISK_TEXT: Record<AiRisk, { text: string; tone: "gray" | "orange" | "red" | "blue" }> = {
  read: { text: "Чтение", tone: "gray" }, nav: { text: "Переход", tone: "gray" }, setting: { text: "Настройка", tone: "blue" },
  soft: { text: "Правка", tone: "blue" }, write: { text: "Изменение данных", tone: "orange" }, external: { text: "Уходит наружу", tone: "orange" }, danger: { text: "Удаление", tone: "red" },
};
const STATUS_TEXT = { pending: "Ждёт вашего решения", running: "Выполняется…", done: "Выполнено", rejected: "Отклонено", error: "Ошибка" } as const;

export function AiPage() {
  const { ai } = useHub();
  const { view, busy } = useAi();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [view.length, busy]);
  const ready = ai.enabled && !!ai.baseUrl && !!ai.model;
  const provider = AI_PROVIDERS.find((p) => p.id === ai.provider)?.title ?? "Модель";
  const send = () => { const t = text.trim(); if (!t || busy || !ready) return; setText(""); void askAi(t); };

  if (!ready) {
    return (
      <div className="page"><div className="page-body">
        <EmptyState icon="bot" title="Подключите локальную модель"
          action={<Button variant="primary" icon="settings" onClick={() => openSettings("ai")}>Открыть настройки Ai</Button>}>
          Работает с LM Studio, Ollama и другими серверами с OpenAI-совместимым API. Модель запускается на вашем компьютере, разговор никуда не уходит.
        </EmptyState>
      </div></div>
    );
  }
  return (
    <div className="page ai-page">
      <div className="ai-bar">
        <Tag tone="green" icon="check">{provider}: {ai.model}</Tag>
        <span className="faint">{ai.mode === "all" ? "Подтверждаю каждое действие" : ai.mode === "safe" ? "Без вопросов — только безопасное" : "Правки — с подтверждением"}</span>
        <span className="grow" />
        <Button small variant="ghost" icon="settings" onClick={() => openSettings("ai")}>Настройки</Button>
        <Button small variant="ghost" icon="trash" disabled={!view.length} onClick={clearChat}>Очистить</Button>
      </div>
      <div className="ai-log" role="log" aria-label="Разговор с помощником" aria-live="polite">
        {view.length === 0 && (
          <div className="ai-hint faint">
            <p>Попросите что-нибудь сделать в приложении:</p>
            <ul>
              {["Сколько новых лидов и когда был последний поиск?", "Найди лиды из Москвы с оценкой выше 70 и добавь их в избранное", "Включи тёмную тему и компактный вид", "Создай задачу «Позвонить клиенту» на завтра"].map((x) => (
                <li key={x}><button type="button" className="link-btn" onClick={() => setText(x)}>{x}</button></li>
              ))}
            </ul>
          </div>
        )}
        {view.map((v) => <Item key={v.id} v={v} />)}
        {busy && <div className="ai-msg assistant faint" role="status">Модель думает…</div>}
        <div ref={end} />
      </div>
      <form className="ai-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea aria-label="Сообщение помощнику" value={text} rows={2} placeholder="Что сделать? Enter — отправить, Shift+Enter — новая строка"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        {busy ? <Button icon="x" onClick={stopChat}>Остановить</Button> : <Button variant="primary" icon="send" type="submit" disabled={!text.trim()}>Отправить</Button>}
      </form>
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
  return <div className={`ai-msg ${v.kind} selectable`}>{v.text}</div>;
}
