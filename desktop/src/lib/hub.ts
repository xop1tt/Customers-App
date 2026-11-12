// Настройки локальной модели («Ai»). Встроенных интеграций в приложении больше нет (ADR-083): каталог «Коннекторы» наполняют только сторонние компании.
// Здесь только описания и чистая логика: сеть, секреты и хранение — в ядре (`hub_*`, `ai_*`).

export type AiMode = "writes" | "all" | "safe";
export type AiProvider = "lmstudio" | "ollama" | "llamacpp" | "jan" | "custom";

export interface AiConfig {
  enabled: boolean;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  mode: AiMode;
  /** Дополнительные указания модели. */
  system: string;
  temperature: number;
  /** Ограничение числа шагов (вызовов инструментов) за один ответ. */
  maxSteps: number;
  /** Какие группы действий разрешены модели. */
  allow: AiGroup[];
  /** Модель понимает изображения (можно прикладывать картинки к сообщению). */
  vision: boolean;
  /** Модель понимает звук (wav, mp3). */
  audio: boolean;
  /** Уведомлять, когда модель закончила или ждёт ответа (подтверждения действия), если чат Ai сейчас не на виду. */
  notify: boolean;
}

export type AiGroup = "read" | "navigate" | "settings" | "data";
export const AI_GROUPS: { id: AiGroup; title: string; hint: string }[] = [
  { id: "read", title: "Читать данные", hint: "Лиды, записи CRM, сводка, состояние настроек" },
  { id: "navigate", title: "Открывать разделы и настройки", hint: "Переходить между экранами и окнами" },
  { id: "settings", title: "Менять настройки приложения", hint: "Тема, масштаб, компактный вид и подобное" },
  { id: "data", title: "Менять данные", hint: "Избранное, архив, заметки, задачи и события, ответственные, запуск поиска, удаление лидов" },
];

export const AI_PROVIDERS: { id: AiProvider; title: string; url: string; hint: string }[] = [
  { id: "lmstudio", title: "LM Studio", url: "http://localhost:1234/v1", hint: "Вкладка «Developer» → «Start Server». Модель должна быть загружена." },
  { id: "ollama", title: "Ollama", url: "http://localhost:11434/v1", hint: "Запустите Ollama и скачайте модель: ollama pull llama3.1" },
  { id: "llamacpp", title: "llama.cpp (llama-server)", url: "http://localhost:8080/v1", hint: "Запустите llama-server с флагом --jinja для вызова инструментов." },
  { id: "jan", title: "Jan", url: "http://localhost:1337/v1", hint: "Включите локальный API-сервер в настройках Jan." },
  { id: "custom", title: "Другой сервер (OpenAI-совместимый)", url: "", hint: "Любой сервер с адресом /v1/chat/completions: vLLM, LocalAI, свой." },
];

export const defaultAi = (): AiConfig => ({
  enabled: false, provider: "lmstudio", baseUrl: AI_PROVIDERS[0]!.url, model: "", apiKey: "", mode: "writes", system: "", temperature: 0.2, maxSteps: 6,
  allow: ["read", "navigate", "settings", "data"], vision: false, audio: false, notify: true,
});

/** Сохранённые настройки. Поле `integrations` старых версий (адреса вебхуков и токены мессенджеров) при первом сохранении стирается. */
export interface HubConfig { ai: AiConfig }

export function normalizeHub(raw: unknown): HubConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as { ai?: Partial<AiConfig> };
  const d = defaultAi();
  const a = o.ai ?? {};
  const ai: AiConfig = {
    enabled: a.enabled === true,
    provider: AI_PROVIDERS.some((p) => p.id === a.provider) ? (a.provider as AiProvider) : d.provider,
    baseUrl: typeof a.baseUrl === "string" ? a.baseUrl : d.baseUrl,
    model: typeof a.model === "string" ? a.model : "",
    apiKey: typeof a.apiKey === "string" ? a.apiKey : "",
    mode: a.mode === "all" || a.mode === "safe" ? a.mode : "writes",
    system: typeof a.system === "string" ? a.system.slice(0, 4000) : "",
    temperature: typeof a.temperature === "number" ? Math.min(2, Math.max(0, a.temperature)) : d.temperature,
    maxSteps: typeof a.maxSteps === "number" ? Math.min(12, Math.max(1, Math.round(a.maxSteps))) : d.maxSteps,
    allow: Array.isArray(a.allow) ? a.allow.filter((g): g is AiGroup => AI_GROUPS.some((x) => x.id === g)) : d.allow,
    vision: a.vision === true,
    audio: a.audio === true,
    notify: a.notify !== false,
  };
  return { ai };
}

/** Локальный ли адрес: для остальных в настройках Ai показывается предупреждение, что разговор уходит из компьютера. */
export function isLocalUrl(raw: string): boolean {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".local") || /^(10|192\.168)\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch {
    return false;
  }
}
