// Настройки Ai: подключение локальной модели (LM Studio, Ollama и др.), режим подтверждений, что разрешено модели.

import { useEffect, useState } from "react";
import { api } from "../../api";
import { AI_GROUPS, AI_PROVIDERS, type AiMode, type AiProvider, isLocalUrl } from "../../lib/hub";
import { AI_TOOLS } from "../../lib/aiTools";
import { Button, Checkbox, Group, Notice, PasswordInput, Select, SettingRow, Switch, TextArea, TextInput } from "../../ui/kit";
import { saveAi, useHub } from "../../state/hub";

const MODES: { value: AiMode; label: string; hint: string }[] = [
  { value: "writes", label: "Правки — с вопросом", hint: "Чтение и переходы без вопросов; всё, что что-то меняет, — после вашего «Выполнить»" },
  { value: "all", label: "Каждое действие", hint: "Подтверждается даже чтение: самый осторожный режим" },
  { value: "safe", label: "Безопасное — без вопросов", hint: "Без вопросов: чтение, переходы, настройки и обратимые правки (избранное, архив, заметки)" },
];

export function AiSection() {
  const { ai } = useHub();
  const [url, setUrl] = useState(ai.baseUrl);
  const [key, setKey] = useState(ai.apiKey);
  const [system, setSystem] = useState(ai.system);
  const [models, setModels] = useState<string[]>(ai.model ? [ai.model] : []);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { setUrl(ai.baseUrl); setKey(ai.apiKey); setSystem(ai.system); }, [ai.baseUrl, ai.apiKey, ai.system]);
  const provider = AI_PROVIDERS.find((p) => p.id === ai.provider)!;

  const check = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const list = await api.aiModels(url, key || undefined);
      setModels(list);
      await saveAi({ baseUrl: url.trim(), apiKey: key });
      setStatus({ ok: true, text: list.length ? `Сервер отвечает. Моделей: ${list.length}.` : "Сервер отвечает, но моделей в нём нет: загрузите модель." });
      if (list.length && !list.includes(ai.model)) await saveAi({ model: list[0]! });
    } catch (e) {
      setStatus({ ok: false, text: (e as { message?: string })?.message ?? "Не удалось подключиться." });
    }
    setBusy(false);
  };
  const pickProvider = (id: AiProvider) => {
    const p = AI_PROVIDERS.find((x) => x.id === id)!;
    const next = p.url || url;
    setUrl(next); setStatus(null); setModels([]);
    void saveAi({ provider: id, baseUrl: next, model: "" });
  };
  const toggleGroup = (g: (typeof AI_GROUPS)[number]["id"], on: boolean) => void saveAi({ allow: on ? [...new Set([...ai.allow, g])] : ai.allow.filter((x) => x !== g) });

  return (
    <>
      <Group title="Модель" sub="model" note="Приложение не поставляется с моделью и не отправляет разговор в интернет: оно обращается к серверу модели, который вы запускаете сами.">
        <SettingRow title="Помощник Ai" hint="Чат Ai (кнопка «Ai» внизу левой рейки) работает, когда помощник включён и выбрана модель.">
          <Switch checked={ai.enabled} onChange={(v) => void saveAi({ enabled: v })} label="Включить помощника" />
        </SettingRow>
        <SettingRow title="Провайдер" hint={provider.hint}>
          <Select width={280} value={ai.provider} label="Провайдер модели" options={AI_PROVIDERS.map((p) => ({ value: p.id, label: p.title }))} onChange={pickProvider} />
        </SettingRow>
        <SettingRow title="Адрес сервера" hint="OpenAI-совместимый адрес, обычно оканчивается на /v1." stack>
          <TextInput value={url} onChange={setUrl} placeholder="http://localhost:1234/v1" aria-label="Адрес сервера модели" />
        </SettingRow>
        <SettingRow title="Ключ доступа" hint="Нужен только если сервер его требует; у LM Studio и Ollama ключа нет. Хранится в защищённом хранилище системы." stack>
          <PasswordInput value={key} onChange={setKey} placeholder="Необязательно" aria-label="Ключ доступа к серверу модели" />
        </SettingRow>
        {url.trim() && !isLocalUrl(url) && <Notice tone="warn">Адрес не локальный: разговор и данные, которые видит модель, будут отправляться на этот сервер. Используйте только сервер, которому доверяете.</Notice>}
        <SettingRow title="Подключение" hint="Проверяет сервер и загружает список моделей.">
          <Button icon="refresh" busy={busy} onClick={() => void check()} disabled={!url.trim()}>Проверить и загрузить модели</Button>
        </SettingRow>
        {status && <Notice tone={status.ok ? "ok" : "error"}>{status.text}</Notice>}
        <SettingRow title="Модель">
          {models.length ? (
            <Select width={280} value={ai.model} label="Модель" placeholder="Выберите модель" options={models.map((m) => ({ value: m, label: m }))} onChange={(v) => void saveAi({ model: v })} />
          ) : (
            <TextInput value={ai.model} onChange={(v) => void saveAi({ model: v })} placeholder="Название модели" aria-label="Название модели" />
          )}
        </SettingRow>
        <SettingRow title="Указания модели" hint="Необязательно: например, «Отвечай кратко» или как называть клиентов." stack>
          <TextArea value={system} onChange={setSystem} onBlur={() => { if (system !== ai.system) void saveAi({ system }); }} rows={3} placeholder="Дополнительные указания" />
        </SettingRow>
        <SettingRow title="Точность ответов" hint="Ниже — предсказуемее, выше — разнообразнее. Для управления приложением лучше 0–0,3.">
          <Select width={160} value={String(ai.temperature)} label="Температура" options={["0", "0.2", "0.5", "0.8", "1"].map((v) => ({ value: v, label: v.replace(".", ",") }))} onChange={(v) => void saveAi({ temperature: Number(v) })} />
        </SettingRow>
      </Group>

      <Group title="Доступ и подтверждения" sub="access" note="Удаление и отправка сообщений во внешние сервисы подтверждаются всегда, в любом режиме. Содержимое лидов и записей модель считает данными, а не указаниями.">
        <SettingRow title="Когда спрашивать" hint={MODES.find((m) => m.value === ai.mode)?.hint}>
          <Select width={280} value={ai.mode} label="Режим подтверждений" options={MODES} onChange={(v) => void saveAi({ mode: v })} />
        </SettingRow>
        {AI_GROUPS.map((g) => (
          <SettingRow key={g.id} title={g.title} hint={g.hint}>
            <Checkbox checked={ai.allow.includes(g.id)} onChange={(v) => toggleGroup(g.id, v)} label={`Разрешить: ${g.title}`} />
          </SettingRow>
        ))}
        <SettingRow title="Уведомлять об Ai" hint="Сообщать, когда модель закончила или ждёт вашего ответа (подтверждения действия). Если окно не на виду — системным уведомлением, если вы в другом разделе при закрытом чате — подсказкой. Пока чат открыт перед вами, уведомлений нет.">
          <Switch checked={ai.notify} onChange={(v) => void saveAi({ notify: v })} label="Уведомлять, когда модель закончила или требует ответа" />
        </SettingRow>
        <SettingRow title="Модель понимает изображения" hint="Включите, если выбрана мультимодальная модель (например, с «vision»): тогда в чат можно прикладывать картинки. Текстовые файлы (txt, csv, json и др.) работают с любой моделью.">
          <Switch checked={ai.vision} onChange={(v) => void saveAi({ vision: v })} label="Модель понимает изображения" />
        </SettingRow>
        <SettingRow title="Модель понимает звук" hint="Для моделей с приёмом аудио: можно прикладывать файлы wav и mp3.">
          <Switch checked={ai.audio} onChange={(v) => void saveAi({ audio: v })} label="Модель понимает звук" />
        </SettingRow>
        <SettingRow title="Шагов за один ответ" hint="Сколько действий модель может выполнить подряд, прежде чем остановится.">
          <Select width={120} value={String(ai.maxSteps)} label="Предел шагов" options={["2", "4", "6", "8", "12"].map((v) => ({ value: v, label: v }))} onChange={(v) => void saveAi({ maxSteps: Number(v) })} />
        </SettingRow>
        <details className="ai-tools">
          <summary>Что умеет помощник ({AI_TOOLS.length} действий)</summary>
          <ul>{AI_TOOLS.map((t) => <li key={t.name}><b>{t.name}</b> — {t.description}</li>)}</ul>
        </details>
      </Group>
    </>
  );
}
