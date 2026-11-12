// Акцентный цвет: из одного значения получаются нажатое, наведённое и мягкое состояния.

export const DEFAULT_ACCENT = "#4c8dff";
export const ACCENTS = ["#4c8dff", "#7b6cf0", "#2fb5a0", "#4cae6e", "#e08a3c", "#e5645c", "#d65fa8"];

export const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
const toHex = (c: [number, number, number]) => `#${c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export type ThemeChoice = "system" | "dark" | "light";
export type Theme = "dark" | "light";

/** Тема, которая применяется на самом деле: выбор пользователя или тема системы. */
export function resolveTheme(choice: string | null | undefined, systemDark: boolean): Theme {
  if (choice === "dark" || choice === "light") return choice;
  return systemDark ? "dark" : "light";
}

const channel = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const luminance = (c: [number, number, number]) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
/** Контраст двух цветов по WCAG 2.x (1…21). */
export function contrast(a: [number, number, number], b: [number, number, number]): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const LIGHT_SIDE = rgb("#ebedf1"); // самая тёмная поверхность светлой темы, на которой бывают ссылки и фокус
const DARK_TEXT = "#14151a";

export function accentVars(accent: string | null | undefined, theme: Theme = "dark"): Record<string, string> {
  const dark = theme === "dark";
  let c = rgb(accent && isHex(accent) ? accent : DEFAULT_ACCENT);
  // Светлая тема: акцент служит цветом ссылок и кольца фокуса, поэтому темнеет до 4.5 : 1 к поверхности.
  if (!dark) for (let i = 0; i < 40 && contrast(c, LIGHT_SIDE) < 4.5; i++) c = mix(c, [0, 0, 0], 0.06);
  const base = toHex(c);
  // Текст на акценте: белый или тёмный, что контрастнее (не менее 4.5 : 1 для штатных цветов).
  const onAccent = contrast(c, [255, 255, 255]) >= contrast(c, rgb(DARK_TEXT)) ? "#ffffff" : DARK_TEXT;
  return {
    "--accent": base,
    // В тёмной теме наведение светлее, в светлой темнее.
    "--accent-hover": toHex(dark ? mix(c, [255, 255, 255], 0.18) : mix(c, [0, 0, 0], 0.14)),
    "--accent-soft": toHex(mix(rgb(dark ? "#1b1c20" : "#f5f6f8"), c, dark ? 0.24 : 0.18)),
    "--text-on-accent": onAccent,
  };
}

export function applyAccent(accent: string | null | undefined, theme: Theme = "dark") {
  const vars = accentVars(accent, theme);
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
}

/** Ставит тему на <html>: атрибут для стилей и `color-scheme` для встроенных элементов (полосы прокрутки, поля). */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/** Тема системы сейчас: тёмная ли. */
export const systemIsDark = (): boolean => typeof window === "undefined" || !window.matchMedia || window.matchMedia("(prefers-color-scheme: dark)").matches;
