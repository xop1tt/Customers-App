// Разбор того, что пользователь вводит в списки источников (порт SourceInput).

const CHANNEL = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const VK = /^[A-Za-z0-9_.]{2,64}$/;

function stripPrefixes(raw: string, prefixes: string[]): string {
  let s = raw.trim();
  for (const p of prefixes) if (s.toLowerCase().startsWith(p)) s = s.slice(p.length);
  return s;
}

function cut(s: string): string {
  const i = s.search(/[/?]/);
  return i >= 0 ? s.slice(0, i) : s;
}

/** «@name», «t.me/name», «https://t.me/s/name» → «name». */
export function telegramChannel(raw: string): string | null {
  let s = stripPrefixes(raw, ["https://", "http://"]);
  s = stripPrefixes(s, ["www.", "t.me/s/", "t.me/", "telegram.me/"]);
  if (s.startsWith("@")) s = s.slice(1);
  s = cut(s);
  return CHANNEL.test(s) ? s : null;
}

/** «https://vk.com/name» → «name». */
export function vkCommunity(raw: string): string | null {
  let s = stripPrefixes(raw, ["https://", "http://"]);
  s = stripPrefixes(s, ["www.", "m.vk.com/", "vk.com/", "vk.ru/"]);
  if (s.startsWith("@")) s = s.slice(1);
  s = cut(s);
  return VK.test(s) ? s : null;
}

/** Публичный http(s)-адрес: не localhost, не адрес из частной сети. */
export function isPublicHttpUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    return true;
  }
  if (host.includes(":")) return false; // IPv6-адреса не принимаются
  return host.includes(".");
}

export function feedUrl(raw: string): string | null {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return isPublicHttpUrl(s) ? s : null;
}

export function keyword(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  return s ? s : null;
}

export function region(raw: string): string | null {
  const s = raw.trim().replaceAll('"', "");
  return s ? s : null;
}

/** Разбивает ввод на элементы: по запятым, точкам с запятой и строкам. */
export function split(text: string): string[] {
  return text
    .split(/[,;\n\r\t]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Добавляет значения к списку: повторы и неверные пропускаются, неверные возвращаются для подсказки. */
export function addAll(existing: string[], raw: string, normalize: (s: string) => string | null): { items: string[]; rejected: string[] } {
  const items = [...existing];
  const rejected: string[] = [];
  const seen = new Set(items.map((x) => x.toLowerCase()));
  for (const part of split(raw)) {
    const n = normalize(part);
    if (n === null) rejected.push(part);
    else if (!seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      items.push(n);
    }
  }
  return { items, rejected };
}
