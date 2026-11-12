// Локальный сервер, вместо внешних сервисов: RSS-лента, GitHub (обновления), вебхук, WebDAV, Битрикс24.
// Ядро приложения в сборке e2e подменяет адреса вида https://rss.e2e.example на этот сервер (CUSTOMERS_E2E_REWRITE),
// поэтому проверяется настоящий сетевой код: разбор ответов, повторы, 304, заголовки, тело запросов.
// Всё, что получил сервер, запоминается в `received` и сверяется с эталоном после прогона (run.cjs).
const http = require("node:http");
const crypto = require("node:crypto");

const HOSTS = {
  rss: "https://rss.e2e.example",
  github: "https://api.github.com",
  hooks: "https://hooks.e2e.example",
  dav: "https://dav.e2e.example",
  b24: "https://b24.e2e.example",
  dl: "https://dl.e2e.example",
};

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>E2E заказы</title>
<item><title>Нужен сайт для кофейни с онлайн-меню</title><link>https://rss.e2e.example/orders/101</link><guid>https://rss.e2e.example/orders/101</guid>
<description><![CDATA[<p>Ищем разработчика сайта. Бюджет 40 000 ₽. Звонить +7 999 123-45-67, почта order101@e2e.example</p>]]></description><pubDate>__DATE__</pubDate><category>Сайты</category></item>
<item><title>Telegram-бот для записи клиентов</title><link>https://rss.e2e.example/orders/102</link><guid>https://rss.e2e.example/orders/102</guid>
<description><![CDATA[<p>Нужен бот в Telegram для записи на услуги. Контакт: order102@e2e.example</p>]]></description><pubDate>__DATE__</pubDate><category>Боты</category></item>
<item><title>Дизайн логотипа</title><link>https://rss.e2e.example/orders/103</link><guid>https://rss.e2e.example/orders/103</guid>
<description>Нужен логотип для пекарни</description><pubDate>__DATE__</pubDate></item>
</channel></rss>`;

/** Ответ GitHub о релизе: тег, описание, установщики для macOS и Windows с контрольной суммой, которая не совпадёт с файлом. */
function release(tag) {
  const v = tag.replace(/^v/, "");
  const zero = "0".repeat(64);
  const asset = (name) => ({ name, browser_download_url: `https://dl.e2e.example/${name}`, size: 1024, digest: `sha256:${zero}` });
  return {
    tag_name: tag, name: `Customers ${v}`, draft: false, prerelease: false,
    body: `## Что нового\n- Проверочный релиз ${v}\n- Исправления`, html_url: `https://github.com/xop1tt/Customers-App/releases/tag/${tag}`,
    published_at: "2026-11-12T00:00:00Z",
    assets: [asset(`Customers-${tag}-macOS.dmg`), asset(`Customers-${tag}-windows-x64-setup.exe`)],
  };
}

function start({ live = false } = {}) {
  const received = { rssRequests: [], webhook: [], dav: [], b24: [], github: [], other: [] };
  const state = { mode: "none" }; // none | uptodate:<версия> | available | error — переключается сценарием через событие e2e-mock

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname;
      const json = (code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
      const entry = { method: req.method, path, query: url.search, size: body.length, headers: req.headers };

      if (path === "/rss/feed.xml") {
        const etag = '"e2e-feed-1"';
        received.rssRequests.push({ ifNoneMatch: req.headers["if-none-match"] || null, userAgent: req.headers["user-agent"] || null });
        if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag }); return res.end(); }
        const date = new Date().toUTCString().replace("GMT", "+0000");
        res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8", etag });
        return res.end(RSS.replaceAll("__DATE__", date));
      }
      // Локальная модель (OpenAI-совместимый API): сценарий передаёт приложению адрес http://127.0.0.1:<порт>/ai/v1.
      if (path.startsWith("/ai/v1")) {
        received.ai = (received.ai || []).concat(`${req.method} ${path}`);
        if (req.headers.authorization !== "Bearer e2e-model-key") return json(401, { error: { message: "неверный ключ E2E" } });
        if (path === "/ai/v1/models") return json(200, { data: [{ id: "e2e-model-b" }, { id: "e2e-model-a" }] });
        if (path === "/ai/v1/chat/completions" && req.method === "POST") {
          let b = {};
          try { b = JSON.parse(body.toString("utf8")); } catch { /* не JSON */ }
          const last = (b.messages || []).filter((m) => m.role === "user").pop();
          return json(200, { choices: [{ message: { role: "assistant", content: `Ответ E2E на: ${last ? last.content : ""}` } }], stream: b.stream === false });
        }
        return json(404, { error: { message: "нет такого пути" } });
      }
      if (path.startsWith("/hooks/")) {
        let parsed = null;
        try { parsed = JSON.parse(body.toString("utf8")); } catch { /* не JSON */ }
        received.webhook.push({ ...entry, json: parsed, contentType: req.headers["content-type"] || null });
        return json(200, { ok: true });
      }
      if (path.startsWith("/dav")) {
        received.dav.push({ ...entry, sha256: body.length ? crypto.createHash("sha256").update(body).digest("hex") : null, authorization: req.headers.authorization ? "есть" : null });
        if (req.method === "PROPFIND") { res.writeHead(207, { "content-type": "application/xml" }); return res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href></d:response></d:multistatus>'); }
        if (req.method === "MKCOL") { res.writeHead(201); return res.end(); }
        if (req.method === "PUT") { res.writeHead(201); return res.end(); }
        res.writeHead(200); return res.end();
      }
      if (path.startsWith("/b24")) {
        received.b24.push({ ...entry, body: body.toString("utf8").slice(0, 2000) });
        if (/crm\.lead\.add\.json$/.test(path)) return json(200, { result: 1000 + received.b24.length, time: {} });
        return json(200, { result: { ID: "1", NAME: "E2E", ADMIN: true, id: 1 }, time: {} });
      }
      if (path === "/__control") { state.mode = body.toString("utf8"); received.control = (received.control || []).concat(state.mode); return json(200, { mode: state.mode }); }
      if (path.startsWith("/dl/")) { received.dl = (received.dl || []).concat(path); res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(Buffer.alloc(1024, 7)); }
      if (path.startsWith("/github")) {
        received.github.push(entry);
        const tag = state.mode === "available" ? "v99.0.0" : state.mode.startsWith("uptodate:") ? `v${state.mode.split(":")[1]}` : null;
        if (state.mode === "error") return json(500, { message: "Server Error" });
        if (/\/releases(\/latest|\?|$)/.test(path + url.search) && tag) {
          const list = /\/releases$/.test(path);
          return json(200, list ? [release(tag)] : release(tag));
        }
        return json(404, { message: "Not Found" });
      }
      received.other.push(entry);
      json(404, { message: "нет такого адреса в тестовом сервере" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const base = `http://127.0.0.1:${port}`;
      // В ночном прогоне GitHub и скачивание обновлений идут в настоящую сеть, остальное по-прежнему на тестовый сервер.
      const rewrite = Object.entries(HOSTS).filter(([k]) => !(live && (k === "github" || k === "dl"))).map(([k, host]) => `${host}=${base}/${k}`).join(";");
      resolve({ port, base, rewrite, received, state, hosts: HOSTS, control: `${base}/__control`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { start, HOSTS };
