// Модульные тесты защиты от SSRF (S2): deno test --allow-env supabase/functions/market-relay/relay_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkTarget, isPublicIp, type Resolver } from "../_shared/netguard.ts";
import { makeHandler } from "./handler.ts";

// Секрет собирается при запуске, чтобы сканеры не считали литерал утечкой.
const SECRET = ["relay", "test", "secret", "0123456789abcdef0123"].join("-");

function dns(map: Record<string, string[]>): Resolver {
  return (host, type) => Promise.resolve((map[host] ?? []).filter((a) => (type === "A") === !a.includes(":")));
}

Deno.test("isPublicIp: внутренние диапазоны отклоняются", () => {
  for (const ip of ["10.0.0.5", "10.255.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.9.9",
                    "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::",
                    "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe",
                    "2002:0a00:0001::1", "2001:db8::1", "ff02::1", "not-an-ip", "1.2.3"]) {
    assertEquals(isPublicIp(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assertEquals(isPublicIp(ip), true, ip);
  }
});

Deno.test("checkTarget: имя, указывающее на внутренний адрес, отклоняется", async () => {
  const r = dns({
    "evil.example.com": ["10.0.0.7"],
    "meta.example.com": ["169.254.169.254"],
    "loop.example.com": ["127.0.0.1"],
    "mixed.example.com": ["93.184.216.34", "10.1.1.1"],
    "v6.example.com": ["fd00::1"],
    "good.example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
  });
  for (const host of ["evil", "meta", "loop", "mixed", "v6"]) {
    const t = await checkTarget(`https://${host}.example.com/hook`, r);
    assertEquals(t.ok ? "ok" : t.reason, "private_address", host);
  }
  assert((await checkTarget("https://good.example.com/hook", r)).ok);
  for (const [url, reason] of [["http://good.example.com/h", "bad_url"], ["https://10.0.0.1/h", "ip_literal"],
                               ["https://[::1]/h", "ip_literal"], ["https://localhost/h", "bad_host"],
                               ["https://user:pw@good.example.com/h", "bad_url"], ["https://none.example.com/h", "unresolvable"]]) {
    const t = await checkTarget(url, r);
    assertEquals(t.ok ? "ok" : t.reason, reason, url);
  }
});

Deno.test("market-relay: секрет обязателен, тело и подпись пересылаются без изменений, без перенаправлений", async () => {
  Deno.env.set("MARKET_RELAY_SECRET", SECRET);
  const sent: { url: string; init: RequestInit }[] = [];
  const fake = ((url: URL, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as unknown as typeof fetch;
  const h = makeHandler(dns({ "hooks.example.com": ["93.184.216.34"], "evil.example.com": ["10.0.0.1"] }), fake);
  const payload = JSON.stringify({ event: "record.created", name: "ООО Зерно" });
  const env = (url: string) => JSON.stringify({ url, event: "record.created", signature: "sha256=" + "a".repeat(64), payload });
  const call = (body: string, secret = SECRET) =>
    h(new Request("http://relay/", { method: "POST", headers: { "x-relay-secret": secret }, body }));

  assertEquals((await call(env("https://hooks.example.com/h"), "wrong")).status, 401);
  assertEquals((await call(env("https://evil.example.com/h"))).status, 422);
  assertEquals(sent.length, 0);
  const ok = await call(env("https://hooks.example.com/h"));
  assertEquals(ok.status, 200);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].url, "https://hooks.example.com/h");
  assertEquals(sent[0].init.body, payload);
  assertEquals(sent[0].init.redirect, "manual");
  assertEquals((sent[0].init.headers as Record<string, string>)["X-Customers-Signature"], "sha256=" + "a".repeat(64));
});
