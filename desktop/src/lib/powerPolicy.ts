// Облегчённый режим: когда отключать анимации (порт PowerPolicy).

import type { PowerState } from "../api/types";

export const THRESHOLD_RANGE = [5, 50] as const;

export type LightModeReason = { kind: "systemSaver" } | { kind: "lowBattery"; percent: number; threshold: number };

export function clampThreshold(t: number): number {
  return Math.min(Math.max(Math.round(t), THRESHOLD_RANGE[0]), THRESHOLD_RANGE[1]);
}

export function evaluate(state: PowerState, automatic: boolean, threshold: number): LightModeReason | null {
  if (!automatic) return null;
  if (state.systemSaver) return { kind: "systemSaver" };
  const limit = clampThreshold(threshold);
  if (state.batteryPercent !== null && state.charging !== true && state.batteryPercent < limit) {
    return { kind: "lowBattery", percent: state.batteryPercent, threshold: limit };
  }
  return null;
}

export function explanation(r: LightModeReason): string {
  return r.kind === "systemSaver"
    ? "Включён режим энергосбережения системы: тяжёлые анимации и эффекты отключены."
    : `Заряд батареи ${r.percent}% ниже порога ${r.threshold}%: тяжёлые анимации и эффекты отключены.`;
}
