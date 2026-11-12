// Встроенные интеграции («Интеграции» → «Каталог») и настройки локальной модели («Ai»).
// Здесь только описания и чистая логика: сеть, секреты и хранение — в ядре (`hub_*`, `ai_*`).

import type { MarketCategory } from "../api/types";

export type HubId = "slack" | "telegram" | "discord" | "teams" | "notion" | "bitrix" | "webhook" | "drives";
/** Куда уходят сообщения: настраивается здесь. Остальные интеграции настраиваются существующими панелями. */
export type Messenger = "slack" | "telegram" | "discord" | "teams";
export const MESSENGERS: Messenger[] = ["slack", "telegram", "discord", "teams"];
export const isMessenger = (id: string): id is Messenger => (MESSENGERS as string[]).includes(id);

/** События приложения, о которых интеграция может сообщать. */
export type HubEvent = "search.finished" | "deal.stage_changed";
export const HUB_EVENTS: { id: HubEvent; title: string; hint: string }[] = [
  { id: "search.finished", title: "Поиск клиентов завершён", hint: "Сводка: сколько нашлось новых лидов" },
  { id: "deal.stage_changed", title: "Сделка сменила этап", hint: "Название сделки, этап и сумма" },
];

export interface HubField { key: "webhook" | "token" | "chat"; label: string; placeholder: string; secret: boolean; hint?: string }

export interface HubApp {
  id: HubId;
  name: string;
  category: MarketCategory;
  /** Цвет плитки логотипа. */
  color: string;
  tagline: string;
  description: string;
  version: string;
  updated: string;
  developer: string;
  /** Что интеграция добавляет в приложение. */
  adds: string[];
  /** Что понадобится от вас (ключи, адреса): создаёт пользователь, приложение их не выдаёт. */
  needs: string[];
  steps: string[];
  /** Страница, где создаётся ключ. */
  consoleUrl: string | null;
  /** Настройка в самом приложении: свои поля (мессенджеры) или готовая панель. */
  setup: "messenger" | "crm" | "drives";
  fields: HubField[];
  /** Что уходит наружу: показывается в подтверждении установки. */
  sends: string;
}

export const HUB_APPS: HubApp[] = [
  {
    id: "slack", name: "Slack", category: "messaging", color: "#4A154B",
    tagline: "Сообщения о новых лидах и сделках в канал Slack",
    description: "Customers пишет в выбранный канал Slack, когда завершился поиск клиентов или сделка перешла на новый этап. Команда видит результат, не заходя в приложение. Работает через входящий вебхук канала: доступ только на отправку сообщений в один канал, читать ваш Slack интеграция не может.",
    version: "1.0.0", updated: "2026-11-12", developer: "Customers",
    adds: ["Сообщения в канал Slack о событиях Customers", "Кнопка «Проверить» отправляет пробное сообщение", "Помощник Ai может отправить сообщение в Slack по вашей просьбе, с подтверждением"],
    needs: ["Адрес входящего вебхука Slack (создаёте вы в своём Slack)"],
    steps: ["Откройте api.slack.com/apps и создайте приложение («From scratch») в нужном пространстве", "Включите «Incoming Webhooks» и нажмите «Add New Webhook to Workspace»", "Выберите канал и скопируйте адрес вида https://hooks.slack.com/services/…", "Вставьте адрес ниже и нажмите «Проверить»"],
    consoleUrl: "https://api.slack.com/apps", setup: "messenger",
    fields: [{ key: "webhook", label: "Адрес вебхука", placeholder: "https://hooks.slack.com/services/…", secret: true }],
    sends: "Текст сообщений о выбранных событиях уходит в hooks.slack.com",
  },
  {
    id: "telegram", name: "Telegram", category: "messaging", color: "#229ED9",
    tagline: "Уведомления о лидах и сделках в чат или канал Telegram",
    description: "Бот Telegram присылает в ваш чат, группу или канал сообщения о завершённом поиске и движении сделок. Бот создаётся у @BotFather за минуту и принадлежит вам.",
    version: "1.0.0", updated: "2026-11-12", developer: "Customers",
    adds: ["Сообщения бота о событиях Customers", "Проверка соединения одной кнопкой", "Помощник Ai может написать в Telegram по вашей просьбе, с подтверждением"],
    needs: ["Токен бота от @BotFather", "Номер чата или @имя канала, куда бот добавлен"],
    steps: ["В Telegram откройте @BotFather, отправьте /newbot и получите токен", "Добавьте бота в нужную группу или канал (в канале — администратором)", "Номер чата: отправьте боту сообщение и откройте https://api.telegram.org/bot<токен>/getUpdates, нужное значение — chat.id. Для публичного канала достаточно @имени", "Вставьте токен и чат ниже, нажмите «Проверить»"],
    consoleUrl: "https://t.me/BotFather", setup: "messenger",
    fields: [
      { key: "token", label: "Токен бота", placeholder: "123456789:AA…", secret: true },
      { key: "chat", label: "Чат или канал", placeholder: "-1001234567890 или @my_channel", secret: false },
    ],
    sends: "Текст сообщений о выбранных событиях уходит в api.telegram.org",
  },
  {
    id: "discord", name: "Discord", category: "messaging", color: "#5865F2",
    tagline: "Сообщения о событиях Customers в канал Discord",
    description: "Вебхук канала Discord получает сообщения о завершённом поиске клиентов и смене этапов сделок. Упоминания всех участников отключены: сообщение не может «пингануть» сервер.",
    version: "1.0.0", updated: "2026-11-12", developer: "Customers",
    adds: ["Сообщения в канал Discord о событиях Customers", "Проверка соединения одной кнопкой", "Помощник Ai может написать в Discord по вашей просьбе, с подтверждением"],
    needs: ["Адрес вебхука канала Discord (создаёте вы)"],
    steps: ["В Discord откройте настройки канала → «Интеграции» → «Вебхуки»", "Нажмите «Новый вебхук» и «Копировать URL вебхука»", "Вставьте адрес (https://discord.com/api/webhooks/…) ниже и нажмите «Проверить»"],
    consoleUrl: null, setup: "messenger",
    fields: [{ key: "webhook", label: "Адрес вебхука", placeholder: "https://discord.com/api/webhooks/…", secret: true }],
    sends: "Текст сообщений о выбранных событиях уходит в discord.com",
  },
  {
    id: "teams", name: "Microsoft Teams", category: "messaging", color: "#5059C9",
    tagline: "Сообщения о событиях Customers в канал Teams",
    description: "Канал Teams получает сообщения о завершённом поиске и смене этапов сделок через рабочий процесс Workflows с веб-запросом. Читать переписку Teams интеграция не может.",
    version: "1.0.0", updated: "2026-11-12", developer: "Customers",
    adds: ["Сообщения в канал Teams о событиях Customers", "Проверка соединения одной кнопкой", "Помощник Ai может написать в Teams по вашей просьбе, с подтверждением"],
    needs: ["Адрес веб-запроса из Workflows в Teams (создаёте вы)"],
    steps: ["В Teams откройте канал → «…» → «Workflows»", "Выберите шаблон «Post to a channel when a webhook request is received»", "Скопируйте адрес рабочего процесса и вставьте ниже, нажмите «Проверить»"],
    consoleUrl: null, setup: "messenger",
    fields: [{ key: "webhook", label: "Адрес веб-запроса", placeholder: "https://…logic.azure.com/workflows/…", secret: true }],
    sends: "Текст сообщений о выбранных событиях уходит в Microsoft (webhook.office.com, logic.azure.com)",
  },
  {
    id: "notion", name: "Notion", category: "documents", color: "#191919",
    tagline: "Выгрузка лидов в базу данных Notion",
    description: "Лиды из поиска клиентов отправляются в вашу базу данных Notion: название, телефон, сайт, оценка и другие поля. Приложение само сопоставляет поля базы с полями лида. Уже отправленные лиды повторно не уходят.",
    version: "1.0.0", updated: "2026-11-12", developer: "Customers",
    adds: ["Команда «Экспорт → Notion» в списках лидов", "Сопоставление полей базы Notion с полями лида", "Защита от повторной отправки одного лида"],
    needs: ["Внутренняя интеграция Notion: токен (создаёте вы)", "База данных, к которой вы открыли доступ этой интеграции"],
    steps: ["Откройте notion.so/my-integrations и создайте внутреннюю интеграцию, скопируйте токен", "В нужной базе данных: «…» → «Подключения» → добавьте созданную интеграцию", "Вставьте токен и ссылку на базу ниже"],
    consoleUrl: "https://www.notion.so/my-integrations", setup: "crm", fields: [],
    sends: "Данные выгружаемых лидов уходят в api.notion.com",
  },
  {
    id: "bitrix", name: "Битрикс24", category: "crm", color: "#2FC6F6",
    tagline: "Отправка лидов в ваш Битрикс24 как лиды CRM",
    description: "Выбранные лиды отправляются в CRM Битрикс24 через входящий вебхук. Вебхук даёт доступ только к тем разделам, которые вы разрешили при создании.",
    version: "1.0.0", updated: "2026-11-12", developer: "Customers",
    adds: ["Команда «Экспорт → Битрикс24» в списках лидов", "Защита от повторной отправки"],
    needs: ["Адрес входящего вебхука Битрикс24 с правом CRM (создаёте вы)"],
    steps: ["В Битрикс24: «Разработчикам» → «Другое» → «Входящий вебхук»", "Разрешите доступ «CRM» и скопируйте адрес", "Вставьте адрес ниже"],
    consoleUrl: null, setup: "crm", fields: [],
    sends: "Данные выгружаемых лидов уходят на адрес вашего Битрикс24",
  },
  {
    id: "webhook", name: "Вебхук (Zapier, Make, n8n)", category: "other", color: "#E4572E",
    tagline: "Передача лидов в любой сервис через сценарий автоматизации",
    description: "Универсальный выход: каждый выгруженный лид уходит JSON-запросом на адрес вашего сценария в Zapier, Make, n8n или собственный сервис. Так Customers соединяется с тысячами приложений, для которых нет отдельной интеграции.",
    version: "1.0.0", updated: "2026-11-12", developer: "Customers",
    adds: ["Команда «Экспорт → Вебхук» в списках лидов", "Все поля лида, телефоны и почта списками"],
    needs: ["Адрес https вебхука вашего сценария (создаёте вы в Zapier, Make, n8n)"],
    steps: ["В Zapier/Make/n8n создайте сценарий с триггером «Webhook» и скопируйте адрес", "Вставьте адрес ниже"],
    consoleUrl: null, setup: "crm", fields: [],
    sends: "Данные выгружаемых лидов уходят на адрес вашего сценария",
  },
  {
    id: "drives", name: "Облачные диски", category: "documents", color: "#34A853",
    tagline: "Резервные копии в Google Диск, Dropbox, Яндекс Диск, WebDAV",
    description: "Резервные копии Customers автоматически кладутся на выбранный диск. Яндекс Диск и WebDAV подключаются паролем приложения, Google Диск и Dropbox — через вход в аккаунт (нужен ключ приложения, его создаёте вы).",
    version: "1.0.0", updated: "2026-11-12", developer: "Customers",
    adds: ["Копия базы на облачном диске после каждого резервного копирования", "Выгрузка файлов экспорта на диск"],
    needs: ["Яндекс Диск и WebDAV: пароль приложения", "Google Диск и Dropbox: ключ OAuth-приложения (создаёте вы, шаги в панели)"],
    steps: ["Выберите диск в панели ниже", "Следуйте подсказкам: для каждого диска они свои"],
    consoleUrl: null, setup: "drives", fields: [],
    sends: "Зашифрованные копии базы уходят на выбранный диск",
  },
];

export const hubApp = (id: string): HubApp | undefined => HUB_APPS.find((a) => a.id === id);

// ------------------------------------------------------------------ сохранённые настройки

export interface HubIntegration { enabled: boolean; installedAt: string; events: HubEvent[]; webhook?: string; token?: string; chat?: string }

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
}

export type AiGroup = "read" | "navigate" | "settings" | "data" | "messages";
export const AI_GROUPS: { id: AiGroup; title: string; hint: string }[] = [
  { id: "read", title: "Читать данные", hint: "Лиды, записи CRM, сводка, состояние настроек" },
  { id: "navigate", title: "Открывать разделы и настройки", hint: "Переходить между экранами и окнами" },
  { id: "settings", title: "Менять настройки приложения", hint: "Тема, масштаб, компактный вид и подобное" },
  { id: "data", title: "Менять данные", hint: "Избранное, архив, заметки, задачи, запуск поиска, удаление лидов" },
  { id: "messages", title: "Отправлять сообщения в интеграции", hint: "Slack, Telegram, Discord, Teams" },
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
  allow: ["read", "navigate", "settings", "data", "messages"],
});

export interface HubConfig { integrations: Record<string, HubIntegration>; ai: AiConfig }

export function normalizeHub(raw: unknown): HubConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as { integrations?: Record<string, Partial<HubIntegration>>; ai?: Partial<AiConfig> };
  const integrations: Record<string, HubIntegration> = {};
  for (const [id, v] of Object.entries(o.integrations ?? {})) {
    if (!v || typeof v !== "object" || !hubApp(id)) continue;
    integrations[id] = {
      enabled: v.enabled !== false, installedAt: typeof v.installedAt === "string" ? v.installedAt : new Date(0).toISOString(),
      events: (Array.isArray(v.events) ? v.events : []).filter((e): e is HubEvent => HUB_EVENTS.some((x) => x.id === e)),
      webhook: typeof v.webhook === "string" ? v.webhook : undefined, token: typeof v.token === "string" ? v.token : undefined, chat: typeof v.chat === "string" ? v.chat : undefined,
    };
  }
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
  };
  return { integrations, ai };
}

/** Ключевые поля заполнены: интеграцию можно проверять и включать. */
export function isConfigured(app: HubApp, cfg: Partial<HubIntegration> | undefined): boolean {
  if (!cfg) return false;
  return app.fields.every((f) => !!(cfg[f.key] ?? "").trim());
}

export function stageMessage(deal: string, stage: string, amount?: number | null, currency?: string | null): string {
  const sum = amount ? `, ${new Intl.NumberFormat("ru-RU").format(amount)} ${currency ?? "RUB"}` : "";
  return `Сделка «${deal}» перешла на этап «${stage}»${sum}`;
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
