// Коннекторы (прежде «Маркетплейс»): окно каталога и кнопки установленных коннекторов в карточках CRM.

import { useEffect } from "react";
import { api } from "../api";
import type { MarketAction, MarketInstalled } from "../api/types";
import { getState, setState, useStore } from "./store";

export type MarketPage = "catalog" | "installed" | "review" | "developer";

export const openMarket = (page: MarketPage = "catalog") => setState({ market: page });
export const closeMarket = () => setState({ market: null });

/** Кнопки коннекторов активного Workspace (только включённые и опубликованные). */
export async function refreshMarketInstalled(): Promise<void> {
  try {
    setState({ marketInstalled: await api.wsMarket<MarketInstalled[]>("market_installed") });
  } catch {
    setState({ marketInstalled: [] });
  }
}

export function useMarketInstalled() {
  const cloud = useStore((s) => s.ws?.isCloud ?? false);
  const active = useStore((s) => s.ws?.active ?? null);
  useEffect(() => {
    setState({ marketInstalled: [] });
    if (cloud && active) void refreshMarketInstalled();
  }, [cloud, active]);
}

/** Действия коннекторов для карточки этого типа. */
export function actionsFor(list: MarketInstalled[], entity: string): { app: MarketInstalled; action: MarketAction }[] {
  return list.flatMap((app) => app.actions.filter((a) => a.entity === entity).map((action) => ({ app, action })));
}

/**
 * Адрес действия: {id}, {type}, {workspace_id} и — при праве crm.read — {title}. Значения кодируются,
 * так что подставленный текст не может поменять адрес, а только его параметр.
 */
export function actionUrl(action: MarketAction, scopes: string[], vars: { id: string; type: string; title: string }): string | null {
  const ws = getState().ws?.active ?? "";
  const values: Record<string, string> = { id: vars.id, type: vars.type, workspace_id: ws, title: scopes.includes("crm.read") ? vars.title : "" };
  const url = action.url.replace(/\{(id|type|workspace_id|title)\}/g, (_, k: string) => encodeURIComponent(values[k] ?? ""));
  return /^https:\/\/[^\s<>"]+$/.test(url) ? url : null;
}

export const SCOPE_TEXT: Record<string, string> = {
  "crm.read": "Читать поля записей CRM (названия, контакты, суммы) в событиях и ссылках",
};

export const EVENT_TEXT: Record<string, string> = {
  "record.created": "Создание записей",
  "record.updated": "Изменение записей",
  "record.deleted": "Удаление записей",
  "deal.stage_changed": "Смена этапа сделки",
};

export const CATEGORY_TEXT: Record<string, string> = {
  crm: "CRM и данные",
  telephony: "Телефония",
  messaging: "Мессенджеры",
  email: "Почта",
  documents: "Документы",
  analytics: "Аналитика",
  marketing: "Маркетинг",
  other: "Другое",
};
