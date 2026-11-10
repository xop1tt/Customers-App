// keep-account: ссылка «Сохранить аккаунт» из письма о неактивности. Открывается в браузере без входа,
// поэтому проверяет только ключ из письма (хеш хранится в базе). Ответ — обычный текст: страницы Supabase
// Edge Functions не отображают HTML.

import { rpc } from "../_shared/db.ts";
import { sha256Hex, validKeepToken } from "../_shared/keytoken.ts";

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "GET") return text("Method not allowed", 405);
  const token = new URL(req.url).searchParams.get("token");
  if (!validKeepToken(token)) return text("Ссылка недействительна.", 400);
  let ok: boolean;
  try {
    ok = await rpc<boolean>("inactive_keep", { p_token_hash: await sha256Hex(token) });
  } catch (e) {
    console.error("keep-account: failed:", (e as Error).message);
    return text("Сервис временно недоступен. Попробуйте позже или просто войдите в приложение Customers.", 503);
  }
  if (!ok) return text("Ссылка недействительна или аккаунт уже удалён.", 404);
  console.log("keep-account: kept");
  return text("Готово: аккаунт Customers сохранён. Спасибо, что остаётесь с нами!");
}
