// Мастер первого запуска: шаги, пропуск, завершение (порт WelcomeFlow) и подсказка региона (порт RegionSuggestion).

export const WELCOME_STEPS = [
  { id: "intro", title: "Добро пожаловать", optional: false },
  { id: "sources", title: "Источники лидов", optional: true },
  { id: "integrations", title: "Интеграции", optional: true },
  { id: "drives", title: "Облачные диски", optional: true },
  { id: "appearance", title: "Оформление", optional: true },
] as const;

export type WelcomeStepId = (typeof WELCOME_STEPS)[number]["id"];

export interface WelcomeFlow {
  index: number;
  skipped: WelcomeStepId[];
  finished: boolean;
}

export const newFlow = (): WelcomeFlow => ({ index: 0, skipped: [], finished: false });

export const stepOf = (f: WelcomeFlow) => WELCOME_STEPS[f.index] as (typeof WELCOME_STEPS)[number];
export const position = (f: WelcomeFlow) => `Шаг ${f.index + 1} из ${WELCOME_STEPS.length}`;
export const progress = (f: WelcomeFlow) => (f.index + 1) / WELCOME_STEPS.length;
export const canGoBack = (f: WelcomeFlow) => f.index > 0 && !f.finished;
export const isLast = (f: WelcomeFlow) => f.index === WELCOME_STEPS.length - 1;
export const canSkip = (f: WelcomeFlow) => stepOf(f).optional && !isLast(f);

const advance = (f: WelcomeFlow): WelcomeFlow => (isLast(f) ? { ...f, finished: true } : { ...f, index: f.index + 1 });

export function back(f: WelcomeFlow): WelcomeFlow {
  return canGoBack(f) ? { ...f, index: f.index - 1 } : f;
}
export function next(f: WelcomeFlow): WelcomeFlow {
  return advance({ ...f, skipped: f.skipped.filter((s) => s !== stepOf(f).id) });
}
export function skip(f: WelcomeFlow): WelcomeFlow {
  const step = stepOf(f);
  if (!step.optional) return next(f);
  return advance({ ...f, skipped: [...new Set([...f.skipped, step.id])] });
}
export function finish(f: WelcomeFlow): WelcomeFlow {
  return { ...f, finished: true };
}

export type StepState = "pending" | "configured" | "skipped";
export function stateOf(f: WelcomeFlow, id: WelcomeStepId, configured: boolean): StepState {
  return configured ? "configured" : f.skipped.includes(id) ? "skipped" : "pending";
}

/** Название региона из данных геокодера или введённого вручную: без «город», «г.» и «городской округ». */
export function regionName(locality?: string | null, subAdministrativeArea?: string | null, administrativeArea?: string | null): string | null {
  for (const raw of [locality, subAdministrativeArea, administrativeArea]) {
    let s = (raw ?? "").trim().replaceAll('"', "");
    if (!s) continue;
    for (const prefix of ["городской округ ", "город ", "г. ", "муниципальный округ "]) {
      if (s.toLowerCase().startsWith(prefix)) s = s.slice(prefix.length);
    }
    for (const suffix of [" городской округ", " (город)"]) {
      if (s.toLowerCase().endsWith(suffix)) s = s.slice(0, s.length - suffix.length);
    }
    s = s.trim();
    if (s) return s;
  }
  return null;
}

/** Подсказка добавляется, только пока регионов нет. */
export function applyRegion(suggestion: string | null, regions: string[]): string[] {
  return regions.length === 0 && suggestion ? [suggestion] : regions;
}
