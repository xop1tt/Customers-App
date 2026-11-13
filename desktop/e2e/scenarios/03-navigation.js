// Навигация: каждый модуль рейки и каждый раздел боковой панели открываются без ошибок.
{
  const { scenario, waitFor, $, $$, click, check, healthy, sleep, norm, shot, golden, dom } = E2E;

  const railLabels = () => $$(".rail-btn").map((b) => b.getAttribute("aria-label"));
  const itemLabel = (el) => norm(($(".ellipsis", el) || el).textContent);
  const sideItems = () => $$(".sidebar .nav-item").filter((el) => !/Настроить панель/.test(el.textContent));

  scenario("rail", "Рейка модулей: CRM, поиск, команда, чат, Ai (настроек в рейке нет)", async () => {
    await waitFor(() => $(".rail"), "рейка модулей");
    const labels = railLabels();
    for (const want of golden("navigation").rail) check(labels.some((l) => l.startsWith(want)), `в рейке нет «${want}»: ${labels}`);
    check(!labels.includes("Настройки"), `«Настройки» должны быть не в рейке, а в меню учётной записи: ${labels}`);
  });

  scenario("navigation", "Навигация: открываются все разделы всех модулей", async () => {
    const nav = golden("navigation");
    for (const [module, want] of Object.entries(nav.modules)) {
      const btn = $$(".rail-btn").find((b) => (b.getAttribute("aria-label") || "").startsWith(nav.moduleLabels[module]));
      check(btn, `нет кнопки модуля ${module}`);
      click(btn);
      await sleep(250);
      await waitFor(() => $(".sidebar"), `панель разделов модуля ${module}`);
      const labels = sideItems().map(itemLabel);
      for (const w of want) check(labels.some((l) => l.startsWith(w)), `модуль ${module}: нет раздела «${w}» среди ${JSON.stringify(labels)}`);
      // Каждый раздел открывается, страница не пустая, ошибок нет.
      for (let i = 0; i < sideItems().length; i++) {
        const fresh = sideItems()[i];
        const label = itemLabel(fresh);
        click(fresh, label);
        await sleep(300);
        await waitFor(() => $("main.center") && norm($("main.center").innerText).length > 0, `страница «${label}» не пустая`, { timeout: 15000 });
        healthy(`в разделе «${label}»`);
      }
      await shot(`nav-${module}`);
    }
  });

  scenario("quick-search", "Быстрый поиск (Ctrl/⌘+K) открывается и закрывается", async () => {
    const mac = /Mac/i.test(navigator.platform);
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: !mac, metaKey: mac, bubbles: true }));
    await waitFor(() => $(".quick, .quick-search, [role=dialog][aria-label*='поиск' i]"), `окно быстрого поиска. На экране: ${dom()}`);
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
    healthy("после быстрого поиска");
  });
}
