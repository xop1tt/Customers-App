// inactive-accounts: раз в неделю (GitHub Actions) предупреждает неактивные аккаунты и удаляет тех, кого
// предупредили не менее срока `inactive_warn_before` назад и кто с тех пор не заходил и не нажал «Сохранить».
//
// Защита: вызов только с секретом CRON_SECRET в заголовке x-cron-secret. Удаление идёт в базе (inactive_purge) и
// возможно только после записанной отправки письма: если почта не работает, аккаунты не удаляются.

import { rpc, supabaseUrl } from "../_shared/db.ts";
import { env, json } from "../_shared/http.ts";
import { newKeepToken, sameSecret, sha256Hex } from "../_shared/keytoken.ts";
import { BANNER_CID, BANNER_PNG_BASE64 } from "../_shared/banner.ts";
import { sendMail, smtpConfigFromEnv } from "../_shared/smtp.ts";
import { render } from "../_shared/templates.ts";

type Due = { user_id: string; email: string; last_activity: string; delete_on: string };

const MAX_WARNINGS_PER_RUN = 20;

function ruDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow" });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);
  const expected = Deno.env.get("CRON_SECRET") ?? "";
  if (expected.length < 16 || !sameSecret(req.headers.get("x-cron-secret") ?? "", expected)) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }

  let warned = 0;
  let failed = 0;
  let due: Due[] = [];
  try {
    due = await rpc<Due[]>("inactive_accounts_due", { p_limit: MAX_WARNINGS_PER_RUN });
  } catch (e) {
    console.error("inactive-accounts: list failed:", (e as Error).message);
    return json({ ok: false, reason: "unavailable" }, 503);
  }

  const base = (Deno.env.get("LEADGEN_PUBLIC_URL") || supabaseUrl()).replace(/\/$/, "");
  const cfg = { ...smtpConfigFromEnv(), timeoutMs: 15000 };
  for (const u of due) {
    const token = newKeepToken();
    const link = `${base}/functions/v1/keep-account?token=${token}`;
    const r = render({
      kind: "inactive_warning", code: "", link, email: u.email, minutesValid: 0,
      lastActive: ruDate(u.last_activity), deleteOn: ruDate(u.delete_on),
    });
    const sent: string[] = [];
    try {
      await sendMail(cfg, [{ to: u.email, ...r, inline: [{ cid: BANNER_CID, type: "image/png", base64: BANNER_PNG_BASE64 }] }], sent);
      // Время отправки пишется только после того, как почтовый сервер принял письмо.
      await rpc("inactive_mark_warned", { p_user: u.user_id, p_token_hash: await sha256Hex(token) });
      warned++;
    } catch (e) {
      failed++;
      console.error("inactive-accounts: warning failed:", (e as Error).message);
    }
  }

  let deleted = 0;
  try {
    deleted = await rpc<number>("inactive_purge", { p_limit: 50 });
  } catch (e) {
    console.error("inactive-accounts: purge failed:", (e as Error).message);
  }
  console.log(`inactive-accounts: warned=${warned} failed=${failed} deleted=${deleted}`);
  return json({ ok: true, warned, failed, deleted });
}
