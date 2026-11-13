// Второй запуск на тех же данных: облачная сессия, ключ базы, настройки и записи пережили перезапуск приложения.
// Это проверка настоящего хранилища ключей (Связка ключей macOS, DPAPI Windows): ключ базы читается после перезапуска процесса.
{
  const { scenario, waitFor, $, $$, click, type, check, eq, core, sleep, norm, shot, golden, skipIf, hasCore, healthy } = E2E;
  const opts = { phase: "relaunch" };

  scenario("relaunch-boot", "Перезапуск: окно открывается, облачная сессия на месте, тема и язык сохранились", async () => {
    await waitFor(() => $(".auth, .welcome, .shell"), "первый экран после перезапуска", { timeout: 45000 });
    healthy("после перезапуска");
    const b = await core("boot_info");
    eq(b.error, null, "ошибка запуска ядра");
    check(b.session && b.session.cloudUser, "сессия не восстановилась после перезапуска");
    eq(b.session.cloudUser.email, E2E.account ? E2E.account.email : "e2e-owner@e2e-test.com", "почта сохранённой сессии");
    eq([b.device.theme, b.device.language], ["light", "ru"], "тема и язык из настроек устройства");
    eq(document.documentElement.dataset.theme, "light", "тема применена в окне при запуске");
  }, { ...opts, fatal: true });

  scenario("relaunch-login", "Перезапуск: сессия открывает базу ключом из хранилища без повторного входа, мастер не показывается", async () => {
    await waitFor(() => $(".shell, .welcome"), "рабочее окно после перезапуска", { timeout: 40000 });
    check($(".shell"), "после перезапуска показан мастер первого запуска, хотя он уже пройден");
    healthy("после перезапуска");
    await shot("relaunch-shell");
  }, { ...opts, fatal: true });

  scenario("relaunch-data", "Перезапуск: клиенты, сделки, лиды, настройки поиска и пометки на месте", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const ws = await core("ws_state");
    check(ws.workspaces.some((w) => w.name === "Студия E2E"), "рабочее пространство пропало");
    const found = await core("ws_list", { entity: "companies", query: { search: golden("crm").searchWord } });
    eq(found.total, 1, "компания из основного прогона");
    check((await core("ws_list", { entity: "deals", query: { search: golden("crm").deal.title } })).total >= 1, "сделка пропала");
    const snap = await core("snapshot");
    eq(snap.leads.map((l) => l.data.title).sort(), golden("search").leads.map((l) => l.title).sort(), "лиды после перезапуска");
    const converted = snap.leads.find((l) => l.data.title === golden("search").leads[0].title);
    check(converted.data.crm && converted.data.crm.deal_id, "пометка «в CRM» пропала после перезапуска");
    eq(converted.note, golden("search").note, "заметка к лиду");
    eq((await core("search_overview")).settings.rss.feeds, ["https://rss.e2e.example/feed.xml"], "лента в настройках поиска");
    // Поиск после перезапуска: память источника сохранена, дубликатов нет.
    await core("run_search", { only: ["fl_ru"] });
    await sleep(300);
    await waitFor(async () => !(await core("search_status")).running, "поиск завершился", { timeout: 90000, interval: 400 });
    eq((await core("snapshot")).leads.length, snap.leads.length, "лидов после поиска на новом запуске");
  }, opts);

  scenario("relaunch-ui", "Перезапуск: разделы CRM и поиска открываются на сохранённых данных", async () => {
    for (const [module, section, text] of [["CRM", "Сделки", golden("crm").deal.title], ["CRM", "Все клиенты", golden("crm").company.name], ["Поиск клиентов", "Все лиды", golden("search").leads[0].title]]) {
      click($$(".rail-btn").find((b) => (b.getAttribute("aria-label") || "").startsWith(module)));
      await sleep(300);
      click(await waitFor(() => $$(".sidebar .nav-item").find((i) => norm(i.textContent).startsWith(section)), `раздел «${section}»`));
      await waitFor(() => norm($("main.center").innerText).includes(text), `«${text}» в разделе «${section}»`, { timeout: 15000 });
      healthy(`в разделе «${section}»`);
    }
  }, opts);
}
