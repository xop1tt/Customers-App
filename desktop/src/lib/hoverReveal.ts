// Выезжающая при наведении боковая панель (порт HoverReveal). Время передаётся извне, поэтому логика проверяется тестами.

export const SHOW_DELAY = 0.12;
export const HIDE_DELAY = 0.45;

export class HoverReveal {
  revealed = false;
  private overEdge = false;
  private overPanel = false;
  private busy = false;
  private overSince: number | null = null;
  private outSince: number | null = null;

  private get isOver() {
    return this.overEdge || this.overPanel;
  }

  setEdge(inside: boolean, now: number) {
    this.overEdge = inside;
    this.refresh(now);
  }
  setPanel(inside: boolean, now: number) {
    this.overPanel = inside;
    this.refresh(now);
  }
  setBusy(value: boolean, now: number) {
    this.busy = value;
    this.refresh(now);
  }
  reset() {
    this.revealed = false;
    this.overEdge = false;
    this.overPanel = false;
    this.overSince = null;
    this.outSince = null;
  }

  private refresh(now: number) {
    if (this.revealed) {
      if (this.isOver || this.busy) this.outSince = null;
      else if (this.outSince === null) this.outSince = now;
    } else if (this.isOver) {
      if (this.overSince === null) this.overSince = now;
    } else {
      this.overSince = null;
    }
  }

  /** Возвращает true, если состояние изменилось. */
  tick(now: number): boolean {
    if (!this.revealed && this.overSince !== null && this.isOver && now - this.overSince >= SHOW_DELAY) {
      this.revealed = true;
      this.overSince = null;
      this.outSince = null;
      return true;
    }
    if (this.revealed && !this.isOver && !this.busy && this.outSince !== null && now - this.outSince >= HIDE_DELAY) {
      this.revealed = false;
      this.outSince = null;
      return true;
    }
    return false;
  }

  /** Через сколько секунд нужно вызвать tick снова, или null. */
  nextDelay(now: number): number | null {
    if (!this.revealed && this.overSince !== null && this.isOver) return Math.max(0.01, SHOW_DELAY - (now - this.overSince));
    if (this.revealed && !this.isOver && !this.busy && this.outSince !== null) return Math.max(0.01, HIDE_DELAY - (now - this.outSince));
    return null;
  }
}
