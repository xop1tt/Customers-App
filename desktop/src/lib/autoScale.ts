// На больших экранах при масштабе системы 100% интерфейс слишком мелкий: добавляем множитель к выбранному пользователем масштабу.

export function autoScale(width: number, dpr: number): number {
  if (dpr > 1.2) return 1; // система уже увеличила интерфейс
  if (width >= 3200) return 1.5;
  if (width >= 2400) return 1.25;
  return 1;
}

/** Ширина окна при запуске, пока масштаб ещё не применён. */
export const BASE_AUTO = typeof window === "undefined" ? 1 : autoScale(window.innerWidth, window.devicePixelRatio || 1);
