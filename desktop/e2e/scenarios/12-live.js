// Проверки с настоящей сетью: только ночной прогон и ручной запуск с галочкой «live» (в PR сеть не используется).
// Сбой чужого сервиса не считается ошибкой приложения: проверяется, что приложение отвечает понятно и не падает.
{
  const { scenario, check, core, sleep, waitFor, hasCore, skipIf, healthy } = E2E;
  const opts = { live: true };

  scenario("live-updates", "Сеть: проверка обновлений в настоящем GitHub и список последних релизов", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    let info = null;
    try { info = await core("check_updates", { manual: true }); } catch (e) { check(/GitHub|интернет|Соединение|код/i.test(String(e.message)), `непонятная ошибка проверки обновлений: ${e.message}`); }
    if (info) {
      const phase = info.phase && typeof info.phase === "object" ? info.phase.phase : info.phase;
      check(["upToDate", "available", "ready"].includes(phase), `состояние после проверки: ${JSON.stringify(info.phase)}`);
    }
    const releases = await core("recent_releases", {}).catch(() => []);
    check(Array.isArray(releases), "recent_releases вернул не список");
    healthy("после проверки обновлений в сети");
  }, opts);

  scenario("live-search", "Сеть: поиск по настоящей ленте заказов завершается, приложение не зависает", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const ov = await core("search_overview");
    const s = ov.settings;
    const before = JSON.stringify(s);
    s.rss = { ...s.rss, enabled: true, feeds: ["https://www.fl.ru/rss/all.xml"], keywords: [] };
    await core("set_search_settings", { settings: s });
    await core("run_search", { only: ["fl_ru"] });
    await sleep(300);
    await waitFor(async () => !(await core("search_status")).running, "поиск по настоящей ленте завершился", { timeout: 150000, interval: 1000 });
    const report = (await core("search_status")).lastReport;
    check(report && report.sources.length >= 1, "нет отчёта о поиске");
    await core("set_search_settings", { settings: JSON.parse(before) });
  }, opts);
}
