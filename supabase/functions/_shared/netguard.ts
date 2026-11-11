// Защита webhooks маркетплейса от SSRF (находка S2 аудита, ADR-046): адрес интеграции принимается, только если
// это https на стандартном или явном порту, а ВСЕ адреса, в которые разрешается имя, публичные. Перенаправления
// не выполняются (redirect: "manual"), поэтому ответ 30x не уводит запрос во внутреннюю сеть.

export type Resolver = (host: string, type: "A" | "AAAA") => Promise<string[]>;

export const denoResolver: Resolver = async (host, type) => {
  try {
    return await Deno.resolveDns(host, type);
  } catch {
    return [];
  }
};

function v4(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((x) => x <= 255) ? p : null;
}

function publicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-network, частные, loopback, multicast/резерв
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local и метаданные облака
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // 192.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // бенчмарки
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function v6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (s.includes("%")) return null;
  const tail = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (tail) {
    const p = v4(tail[1]);
    if (!p) return null;
    s = s.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function publicV6(g: number[]): boolean {
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    // ::, ::1, ::a.b.c.d и ::ffff:a.b.c.d — решает вложенный IPv4
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return false;
    return publicV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return publicV4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return false; // link-local, site-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // документация
  if (g[0] === 0x2002) return publicV4([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255]); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  return (g[0] & 0xe000) === 0x2000; // только глобальный unicast 2000::/3
}

/** true — адрес можно вызывать из интернета; всё, что не разобрано, считается внутренним. */
export function isPublicIp(ip: string): boolean {
  const a = v4(ip);
  if (a) return publicV4(a);
  const b = v6(ip);
  return b ? publicV6(b) : false;
}

export type Target = { ok: true; url: URL } | { ok: false; reason: string };

/** Проверка адреса доставки перед каждым запросом. */
export async function checkTarget(raw: string, resolve: Resolver = denoResolver): Promise<Target> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (url.protocol !== "https:" || url.username || url.password || raw.length > 500) return { ok: false, reason: "bad_url" };
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (v4(host) || v6(host)) return { ok: false, reason: "ip_literal" };
  if (!host.includes(".") || /\.(local|internal|localhost)$/i.test(host)) return { ok: false, reason: "bad_host" };
  const addrs = [...await resolve(host, "A"), ...await resolve(host, "AAAA")];
  if (addrs.length === 0) return { ok: false, reason: "unresolvable" };
  if (!addrs.every(isPublicIp)) return { ok: false, reason: "private_address" };
  return { ok: true, url };
}
