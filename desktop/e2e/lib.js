// Общая часть приёмочных проверок: помощники и запуск сценариев. Файл вставляется в окно настоящего приложения
// вместе с файлами из scenarios/ (см. run.cjs); вне Tauri (демо в браузере) сценарии, которым нужно ядро, пропускаются.
// Каждый файл сценариев — отдельный блок { … }: имена внутри него не пересекаются с другими файлами.
// Начало: объявления ниже, конец: scenarios/zz-finish.js (там запускается E2E.run()).
const E2E = (() => {
  const C = window.__E2E__ || {};
  const started = Date.now();
  const scenarios = [];
  const pageErrors = [];
  const hasCore = !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const short = (v, n = 400) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + "…" : s; };

  // ---- перехват ошибок страницы: любая необработанная ошибка в сценарии — провал сценария
  window.addEventListener("error", (e) => pageErrors.push(`error: ${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push(`unhandledrejection: ${short(e.reason && (e.reason.message || e.reason))}`));
  const origError = console.error.bind(console);
  console.error = (...a) => { pageErrors.push(`console.error: ${short(a.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : short(x))).join(" "))}`); origError(...a); };

  // ---- связь с оболочкой
  const invokeRaw = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args ?? {});
  const emit = async (event, payload) => {
    if (hasCore) { try { await invokeRaw("plugin:event|emit", { event, payload }); } catch (e) { origError("e2e emit", e); } }
    else console.log(`[e2e:${event}]`, typeof payload === "string" ? payload : short(payload, 200));
  };
  const log = (text) => emit("e2e-log", `${((Date.now() - started) / 1000).toFixed(1)}s ${text}`);
  /** Вызов команды ядра. Ошибка команды приходит объектом { code, message }. */
  const core = async (cmd, args) => {
    if (!hasCore) throw new Error(`нет ядра Tauri (демо в браузере): ${cmd}`);
    try { return await invokeRaw(cmd, args ?? {}); }
    catch (e) { throw new Error(`команда ${cmd}: ${short(e && e.message ? e.message : e)}`); }
  };
  /** Команда должна завершиться ошибкой (проверка защиты). Возвращает текст ошибки. */
  const coreFails = async (cmd, args) => {
    try { await invokeRaw(cmd, args ?? {}); } catch (e) { return String(e && e.message ? e.message : e); }
    throw new Error(`команда ${cmd} должна была отклонить запрос`);
  };
  /** Переключает режим тестового сервера (запрос уходит из ядра приложения). */
  const mock = async (mode) => { await emit("e2e-mock", mode); await sleep(hasCore ? 600 : 10); };
  const shot = async (name) => { await emit("e2e-shot", name); await sleep(hasCore ? 1200 : 50); };

  // ---- DOM
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const shown = (el) => !!el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
  const matches = (el, text) => (text instanceof RegExp ? text.test(norm(el.textContent)) : norm(el.textContent).includes(text));
  /** Элементы по селектору, чей текст содержит строку (или подходит под регулярное выражение). */
  const withText = (sel, text, root = document) => $$(sel, root).filter((el) => matches(el, text) && shown(el));
  const dom = () => norm((($("#root") || document.body).innerText || "")).slice(0, 700);

  const waitFor = async (fn, what, { timeout = 20000, interval = 100 } = {}) => {
    const end = Date.now() + timeout;
    let last;
    for (;;) {
      try { last = await fn(); if (last) return last; } catch (e) { last = null; }
      if (Date.now() > end) throw new Error(`не дождались: ${what}. На экране: ${dom()}`);
      await sleep(interval);
    }
  };
  const click = (el, what = "элемент") => {
    if (!el) throw new Error(`нет элемента для нажатия: ${what}. На экране: ${dom()}`);
    if (el.disabled) throw new Error(`элемент недоступен: ${what}`);
    el.click();
  };
  const clickText = async (sel, text, what) => {
    const el = await waitFor(() => withText(sel, text)[0], what || `${sel} «${text}»`);
    click(el, what || text);
    return el;
  };
  /** Ввод в поле, управляемое React: через родной setter и событие input. */
  const type = (input, value) => {
    if (!input) throw new Error("нет поля ввода");
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const key = (target, k, opts = {}) => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
  };

  // ---- проверки
  const check = (cond, msg) => { if (!cond) throw new Error(`проверка не пройдена: ${msg}`); };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const eq = (actual, expected, what) => {
    if (!same(actual, expected)) throw new Error(`${what}: ожидали ${short(expected)}, получили ${short(actual)}`);
  };
  const golden = (name) => {
    const g = (C.golden || {})[name];
    if (g === undefined) throw new Error(`нет эталона ${name}`);
    return g;
  };
  /** Приложение цело: нет экрана ошибки отрисовки, нет красных уведомлений. */
  const healthy = (what = "") => {
    const text = dom();
    check(!text.includes("Интерфейс не смог открыться"), `экран ошибки отрисовки ${what}`);
    const errToasts = $$(".toasts .toast.error").map((t) => norm(t.textContent));
    check(errToasts.length === 0, `красное уведомление ${what}: ${errToasts.join("; ")}`);
  };
  const dismissToasts = () => $$(".toasts .toast button").forEach((b) => b.click());
  const utf8b64 = (text) => { const b = new TextEncoder().encode(text); let s = ""; b.forEach((x) => { s += String.fromCharCode(x); }); return btoa(s); };

  // ---- сценарии
  const scenario = (id, title, fn, opts = {}) => scenarios.push({ id, title, fn, opts });
  const skipIf = (cond, why) => { if (cond) { const e = new Error(why); e.skip = true; throw e; } };

  const run = async () => {
    const results = [];
    for (const s of scenarios) {
      if (s.opts.phase && s.opts.phase !== (C.phase || "main")) continue;
      if (!s.opts.phase && (C.phase || "main") !== "main") continue;
      if (s.opts.mockOnly && C.live) { results.push({ id: s.id, title: s.title, status: "skipped", ms: 0, note: "в ночном прогоне сеть настоящая, подмена сервера не работает" }); continue; }
      if (s.opts.live && !C.live) { results.push({ id: s.id, title: s.title, status: "skipped", ms: 0, note: "только ночной прогон с настоящей сетью" }); continue; }
      const t0 = Date.now();
      const errorsBefore = pageErrors.length;
      await log(`▶ ${s.id}: ${s.title}`);
      const r = { id: s.id, title: s.title, status: "passed", ms: 0 };
      try {
        await s.fn();
        const fresh = pageErrors.slice(errorsBefore).filter((m) => !(C.ignoreErrors || []).some((rx) => new RegExp(rx).test(m)));
        if (fresh.length) throw new Error(`ошибки страницы во время сценария: ${fresh.slice(0, 3).join(" | ")}`);
      } catch (e) {
        if (e && e.skip) { r.status = "skipped"; r.note = e.message; }
        else { r.status = "failed"; r.error = String(e && e.message ? e.message : e); r.screen = dom(); }
      }
      r.ms = Date.now() - t0;
      results.push(r);
      await log(`${r.status === "passed" ? "✓" : r.status === "skipped" ? "○" : "✗"} ${s.id} (${r.ms} мс)${r.error ? ": " + r.error : r.note ? ": " + r.note : ""}`);
      if (r.status === "failed" && s.opts.fatal) break;
    }
    const failed = results.filter((r) => r.status === "failed").length;
    const report = {
      phase: C.phase || "main",
      platform: C.platform,
      durationMs: Date.now() - started,
      total: results.length,
      passed: results.filter((r) => r.status === "passed").length,
      failed,
      skipped: results.filter((r) => r.status === "skipped").length,
      scenarios: results,
      pageErrors: pageErrors.slice(0, 30),
    };
    window.__E2E_REPORT__ = report;
    await emit("e2e-report", JSON.stringify(report));
    return report;
  };

  return { C, hasCore, sleep, short, core, coreFails, emit, log, mock, shot, $, $$, norm, shown, withText, dom, waitFor, click, clickText, type, key, check, eq, same, golden, healthy, dismissToasts, utf8b64, scenario, skipIf, run, pageErrors };
})();
