// Собственный заголовок окна (окно без системной рамки): название не выводится, по центру — глобальный поиск,
// по краям кнопки окна: на macOS «светофор» слева, на Windows — справа. Пустое место перетаскивает окно.

import { useEffect, useState } from "react";
import { isTauri } from "../api/backend";
import { isMac } from "../lib/platform";
import { useStore } from "../state/store";
import { GlobalSearch } from "./GlobalSearch";

type Win = { minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void>; isMaximized(): Promise<boolean>; onResized(f: () => void): Promise<() => void> };
let cached: Promise<Win | null> | null = null;
/** Окно Tauri; вне Tauri (браузер, тесты) его нет, кнопки ничего не делают. */
const appWindow = (): Promise<Win | null> => {
  if (!isTauri) return Promise.resolve(null);
  cached ??= import("@tauri-apps/api/window").then((m) => m.getCurrentWindow() as unknown as Win).catch(() => null);
  return cached;
};
const run = (f: (w: Win) => Promise<unknown>) => () => { void appWindow().then((w) => (w ? f(w) : undefined)); };

export function TitleBar() {
  const ready = useStore((s) => s.phase === "ready");
  const platform = useStore((s) => s.boot?.platform);
  const mac = platform ? platform === "macos" : isMac();
  return (
    <div className={`titlebar ${mac ? "mac" : "win"}`} data-tauri-drag-region role="banner">
      <div className="titlebar-side" data-tauri-drag-region>{mac && <Dots />}</div>
      <div className="titlebar-center">{ready && <GlobalSearch />}</div>
      <div className="titlebar-side end" data-tauri-drag-region>{!mac && <WinControls />}</div>
    </div>
  );
}

function Dots() {
  return (
    <div className="titlebar-dots" role="group" aria-label="Окно">
      <button type="button" className="titlebar-dot close" aria-label="Закрыть окно" onClick={run((w) => w.close())} />
      <button type="button" className="titlebar-dot min" aria-label="Свернуть окно" onClick={run((w) => w.minimize())} />
      <button type="button" className="titlebar-dot max" aria-label="Развернуть окно" onClick={run((w) => w.toggleMaximize())} />
    </div>
  );
}

function WinControls() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    let off: (() => void) | undefined;
    const sync = () => { void appWindow().then((w) => w?.isMaximized().then(setMax)); };
    sync();
    void appWindow().then((w) => w?.onResized(sync).then((f) => { off = f; }));
    return () => off?.();
  }, []);
  const ico = (d: string) => <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true"><path d={d} /></svg>;
  return (
    <div className="titlebar-win" role="group" aria-label="Окно">
      <button type="button" aria-label="Свернуть окно" onClick={run((w) => w.minimize())}>{ico("M0 5h10")}</button>
      <button type="button" aria-label={max ? "Восстановить окно" : "Развернуть окно"} onClick={run((w) => w.toggleMaximize())}>{max ? ico("M2 0h8v8M0 2h8v8H0z") : ico("M.5.5h9v9h-9z")}</button>
      <button type="button" className="close" aria-label="Закрыть окно" onClick={run((w) => w.close())}>{ico("M0 0l10 10M10 0L0 10")}</button>
    </div>
  );
}
