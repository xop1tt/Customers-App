// Системные диалоги и буфер обмена. В Tauri работают через плагины; в браузере (демо и тесты) подставляются безопасные замены.

import { isTauri } from "../api/backend";

export async function pickFolder(title: string, defaultPath?: string): Promise<string | null> {
  if (!isTauri) return "/Users/demo/Documents/Customers";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, multiple: false, title, defaultPath });
  return typeof r === "string" ? r : null;
}

export async function pickFile(title: string, extensions?: string[]): Promise<string | null> {
  if (!isTauri) return "/Users/demo/Documents/exclusions.csv";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ multiple: false, directory: false, title, filters: extensions ? [{ name: "Файлы", extensions }] : undefined });
  return typeof r === "string" ? r : null;
}

export async function pickSavePath(title: string, defaultName: string, extension: string): Promise<string | null> {
  if (!isTauri) return `/Users/demo/Documents/${defaultName}`;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const r = await save({ title, defaultPath: defaultName, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
  return r ?? null;
}

export async function copyText(text: string): Promise<void> {
  if (isTauri) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  await navigator.clipboard?.writeText(text).catch(() => {});
}

export async function readText(): Promise<string> {
  if (isTauri) {
    const { readText: read } = await import("@tauri-apps/plugin-clipboard-manager");
    return (await read()) ?? "";
  }
  return (await navigator.clipboard?.readText().catch(() => "")) ?? "";
}

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = () => (isMac() ? "⌘" : "Ctrl");
