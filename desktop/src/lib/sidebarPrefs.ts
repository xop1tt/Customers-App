// Порядок и видимость разделов боковой панели (порт SidebarPrefs).

export const MAIN_GROUP = ["home", "all", "new", "favorites"] as const;
export const WORK_GROUP = ["sources", "runs", "archive", "excluded"] as const;
/** Разделы, которые можно скрыть. «Все лиды» и другие всегда на месте. */
export const CONFIGURABLE = ["home", "new", "favorites", "sources", "runs", "archive", "excluded"] as const;

/** Элементы в заданном порядке; неизвестные из порядка отбрасываются, новые добавляются в конец. */
export function ordered(items: readonly string[], order: readonly string[]): string[] {
  const present = new Set(items);
  const result = order.filter((x) => present.has(x));
  const seen = new Set(result);
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

/** Переставить элемент `from` на позицию `to` (индекс места вставки в исходном списке). */
export function move(items: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= items.length || to < 0 || to > items.length) return [...items];
  const moving = items[from] as string;
  const rest = items.filter((_, i) => i !== from);
  const insertAt = to > from ? to - 1 : to;
  rest.splice(insertAt, 0, moving);
  return rest;
}

export function toggled(hidden: readonly string[], item: string, visible: boolean): string[] {
  const set = new Set(hidden);
  if (visible) set.delete(item);
  else set.add(item);
  return [...set].sort();
}
