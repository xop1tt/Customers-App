// maintenance: раз в сутки (GitHub Actions, maintenance.yml) запускает очистку базы public.platform_maintenance:
// старые журналы синхронизации и доставок, надгробия CRM, старые уведомления и служебные журналы почты.
//
// Защита: вызов только с секретом CRON_SECRET в заголовке x-cron-secret. Сроки хранения заданы в миграции
// 20261111120000_maintenance.sql; функция их не меняет и ничего не принимает из запроса.

import { rpc } from "../_shared/db.ts";
import { json } from "../_shared/http.ts";
import { sameSecret } from "../_shared/keytoken.ts";

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);
  const expected = Deno.env.get("CRON_SECRET") ?? "";
  if (expected.length < 16 || !sameSecret(req.headers.get("x-cron-secret") ?? "", expected)) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }
  try {
    const removed = await rpc<Record<string, number>>("platform_maintenance", {});
    return json({ ok: true, removed });
  } catch (e) {
    console.error("maintenance: failed:", (e as Error).message);
    return json({ ok: false, reason: "unavailable" }, 503);
  }
}
