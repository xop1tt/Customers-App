// Акцентный цвет: из одного значения получаются нажатое, наведённое и мягкое состояния.

export const DEFAULT_ACCENT = "#4c8dff";
export const ACCENTS = ["#4c8dff", "#7b6cf0", "#2fb5a0", "#4cae6e", "#e08a3c", "#e5645c", "#d65fa8"];

export const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
const toHex = (c: [number, number, number]) => `#${c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function accentVars(accent: string | null | undefined): Record<string, string> {
  const base = accent && isHex(accent) ? accent : DEFAULT_ACCENT;
  const c = rgb(base);
  const lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  return {
    "--accent": base,
    "--accent-hover": toHex(mix(c, [255, 255, 255], 0.18)),
    "--accent-soft": toHex(mix(rgb("#1b1c20"), c, 0.24)),
    "--text-on-accent": lum > 0.72 ? "#14151a" : "#ffffff",
  };
}

export function applyAccent(accent: string | null | undefined) {
  const vars = accentVars(accent);
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
}
