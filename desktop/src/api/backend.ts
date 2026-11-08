// Связь с Rust-ядром: команды и события. Вне Tauri (браузер, тесты, скриншоты) подставляется демо-реализация.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CmdError } from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Mock = typeof import("./mock");
let mock: Mock | null = null;

export async function initBackend(): Promise<void> {
  if (!isTauri) mock = await import("./mock");
}

export function toCmdError(e: unknown): CmdError {
  if (e && typeof e === "object" && "message" in e) {
    const o = e as { code?: unknown; message: unknown };
    return { code: typeof o.code === "string" ? o.code : "", message: String(o.message) };
  }
  return { code: "", message: typeof e === "string" ? e : "Что-то пошло не так." };
}

export async function call<T = void>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    if (isTauri) return await invoke<T>(cmd, args);
    if (!mock) await initBackend();
    return (await mock!.call(cmd, args)) as T;
  } catch (e) {
    throw toCmdError(e);
  }
}

export async function on<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (isTauri) {
    return listen<T>(event, (e) => handler(e.payload));
  }
  if (!mock) await initBackend();
  return mock!.listen(event, handler as (p: unknown) => void);
}
