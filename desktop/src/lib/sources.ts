// Источники лидов: ключи совпадают с Rust-ядром.

import type { SearchSettings } from "../api/types";

export interface SourceMeta {
  key: string;
  title: string;
  icon: string;
  group: "rss" | "telegram" | "vk" | "osm";
  access: string;
  note: string;
}

export const SOURCES: SourceMeta[] = [
  { key: "fl_ru", title: "RSS-ленты", icon: "rss", group: "rss", access: "Бесплатно", note: "Любые публичные RSS- и Atom-ленты заказов, например FL.ru. Ленты хранят только последние записи." },
  { key: "telegram_channels", title: "Telegram-каналы", icon: "telegram", group: "telegram", access: "Бесплатно", note: "Только публичные каналы с веб-превью t.me/s. Bot API чужие каналы не читает." },
  { key: "vk_communities", title: "VK-сообщества", icon: "vk", group: "vk", access: "Бесплатный ключ", note: "Нужен бесплатный сервисный ключ VK (dev.vk.com). Читаются стены выбранных сообществ." },
  { key: "osm_organizations", title: "OpenStreetMap", icon: "pin", group: "osm", access: "Бесплатно", note: "Overpass API, данные ODbL (© участники OpenStreetMap). Полнота в РФ ниже, чем у Яндекса и 2ГИС." },
];

export const sourceTitle = (key: string) => SOURCES.find((s) => s.key === key)?.title ?? key;

export function sourceSettings(s: SearchSettings, group: SourceMeta["group"]) {
  return group === "rss" ? s.rss : group === "telegram" ? s.telegram : group === "vk" ? s.vk : s.osm;
}

/** Сколько значений задано у источника: лент, каналов, сообществ, регионов. */
export function sourceItemCount(s: SearchSettings, group: SourceMeta["group"]): number {
  switch (group) {
    case "rss": return s.rss.feeds.length;
    case "telegram": return s.telegram.channels.length;
    case "vk": return s.vk.communities.length;
    case "osm": return s.osm.regions.length;
  }
}

export const INTERVAL_OPTIONS = [1, 2, 3, 6, 12, 24, 48, 120, 168].map((h) => h);
