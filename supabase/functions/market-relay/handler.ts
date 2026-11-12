// market-relay: доставка webhooks маркетплейса (ADR-046). База (private.market_deliver) больше не обращается к
// адресу интеграции сама: она подписывает событие и передаёт его сюда, а функция проверяет адрес (https, все
// адреса имени публичные) и отправляет POST без перенаправлений. Так запрос не может уйти во внутреннюю сеть
// базы данных, даже если имя интеграции указывает на внутренний адрес.
//
// Защита: вызов только из базы с секретом MARKET_RELAY_SECRET в заголовке x-relay-secret (значение — в
// private.market_relay.secret, docs/MARKETPLACE.md). Тело и подпись пересылаются байт в байт.

import { json } from "../_shared/http.ts";
import { sameSecret } from "../_shared/keytoken.ts";
import { checkTarget, denoResolver, type Resolver } from "../_shared/netguard.ts";

type Envelope = { url?: unknown; event?: unknown; signature?: unknown; payload?: unknown };

export function makeHandler(resolve: Resolver, send: typeof fetch = fetch) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);
    const expected = Deno.env.get("MARKET_RELAY_SECRET") ?? "";
    if (expected.length < 32 || !sameSecret(req.headers.get("x-relay-secret") ?? "", expected)) {
      return json({ ok: false, reason: "unauthorized" }, 401);
    }
    let e: Envelope;
    try {
      e = await req.json();
    } catch {
      return json({ ok: false, reason: "bad_request" }, 400);
    }
    if (typeof e.url !== "string" || typeof e.event !== "string" || typeof e.signature !== "string" ||
        typeof e.payload !== "string" || !/^[a-z._]{1,40}$/.test(e.event) || !/^sha256=[0-9a-f]{64}$/.test(e.signature) ||
        e.payload.length > 256_000) {
      return json({ ok: false, reason: "bad_request" }, 400);
    }
    const target = await checkTarget(e.url, resolve);
    if (!target.ok) return json({ ok: false, reason: target.reason }, 422);
    try {
      const r = await send(target.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: { "Content-Type": "application/json", "X-Customers-Event": e.event, "X-Customers-Signature": e.signature },
        body: e.payload,
      });
      await r.body?.cancel();
      return json({ ok: r.status >= 200 && r.status < 300, status: r.status });
    } catch {
      return json({ ok: false, reason: "unreachable" }, 502);
    }
  };
}

export const handler = makeHandler(denoResolver);
