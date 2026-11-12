// Настройки: все разделы открываются; тема и язык переключаются и сохраняются; смена пароля.
{
  const { scenario, waitFor, $, $$, withText, click, clickText, type, check, eq, core, sleep, norm, shot, golden, skipIf, hasCore, healthy } = E2E;

  const openSettings = async () => {
    if (!$(".settings")) click($$(".rail-btn").find((b) => /^(Настройки|Settings)$/.test(b.getAttribute("aria-label") || "")), "кнопка «Настройки»");
    return waitFor(() => $(".settings"), "окно настроек");
  };
  const closeSettings = async () => {
    if ($(".settings")) click($(".settings-head .icon-btn"), "закрыть настройки");
    await waitFor(() => !$(".settings"), "окно настроек закрылось");
  };
  const choose = async (selectLabel, optionText) => {
    const sel = await waitFor(() => $$("button.select").find((b) => b.getAttribute("aria-label") === selectLabel), `список «${selectLabel}»`);
    click(sel);
    const opt = await waitFor(() => withText("[role=option]", optionText)[0], `вариант «${optionText}»`);
    click(opt);
    await sleep(500);
  };

  scenario("settings-sections", "Настройки: открываются все разделы", async () => {
    await openSettings();
    const want = golden("settings").sections;
    const items = $$(".settings-nav .nav-item");
    const labels = items.map((i) => norm(i.textContent));
    for (const w of want) check(labels.some((l) => l.startsWith(w)), `в настройках нет раздела «${w}»: ${JSON.stringify(labels)}`);
    for (const w of want) {
      const item = $$(".settings-nav .nav-item").find((i) => norm(i.textContent).startsWith(w));
      click(item, w);
      await waitFor(() => norm($(".settings-head h2")?.textContent).startsWith(w), `заголовок раздела «${w}»`);
      await waitFor(() => norm($(".settings-content")?.innerText).length > 20, `содержимое раздела «${w}»`);
      await sleep(250);
      healthy(`в настройках «${w}»`);
    }
    await shot("settings-last");
    await closeSettings();
  });

  scenario("settings-theme", "Оформление: светлая тема применяется и сохраняется в настройках устройства", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    await openSettings();
    click($$(".settings-nav .nav-item").find((i) => norm(i.textContent).startsWith("Оформление")));
    await waitFor(() => $$("button.select").some((b) => b.getAttribute("aria-label") === "Тема оформления"), "список тем");
    await choose("Тема оформления", "Светлая");
    eq(document.documentElement.dataset.theme, "light", "тема документа");
    eq((await core("device_prefs")).theme, "light", "тема в настройках устройства");
    await shot("settings-light");
    await choose("Тема оформления", "Тёмная");
    eq(document.documentElement.dataset.theme, "dark", "тема документа после возврата");
    await choose("Тема оформления", "Светлая");
    await closeSettings();
  });

  scenario("settings-language", "Язык: английский применяется ко всему интерфейсу, русский возвращается", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    await openSettings();
    click($$(".settings-nav .nav-item").find((i) => norm(i.textContent).startsWith("Оформление")));
    await choose("Язык интерфейса", "English");
    eq((await core("device_prefs")).language, "en", "язык в настройках устройства");
    // Интерфейс собирается заново: рейка и разделы становятся английскими.
    const en = golden("settings").english;
    await waitFor(() => $$(".rail-btn").some((b) => (b.getAttribute("aria-label") || "") === en.settings), "рейка стала английской");
    const labels = $$(".rail-btn").map((b) => b.getAttribute("aria-label"));
    for (const w of en.rail) check(labels.some((l) => l.startsWith(w)), `в английской рейке нет «${w}»: ${labels}`);
    await sleep(300);
    // Все разделы настроек по-английски: нет ни одной русской подписи в навигации.
    if (!$(".settings")) click($$(".rail-btn").find((b) => b.getAttribute("aria-label") === en.settings));
    await waitFor(() => $(".settings"), "окно настроек (English)");
    const nav = $$(".settings-nav .nav-item").map((i) => norm(i.textContent));
    check(nav.every((l) => !/[А-Яа-я]/.test(l)), `в английских настройках остались русские подписи: ${JSON.stringify(nav)}`);
    await shot("settings-english");
    await choose("Interface language", "Русский");
    await waitFor(() => $$(".rail-btn").some((b) => (b.getAttribute("aria-label") || "") === "Настройки"), "рейка снова русская");
    eq((await core("device_prefs")).language, "ru", "язык после возврата");
    await closeSettings();
  });

  scenario("change-password", "Аккаунт: смена пароля, вход с новым паролем, старый отклоняется", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const a = E2E.account;
    const next = a.password + "-2";
    await core("change_password", { old: a.password, new: next, confirm: next });
    a.password = next;
    E2E.account.password = next;
    // Старый пароль больше не подходит.
    await core("logout");
    const bad = await E2E.coreFails("login", { username: a.name, password: a.password.slice(0, -2), remember: false });
    check(bad.length > 0, "старый пароль принят");
    await core("login", { username: a.name, password: next, remember: false });
    check((await core("boot_info")).session.displayName === a.name, "вход с новым паролем не открыл сессию");
    // Интерфейс узнаёт о смене сессии и возвращается в рабочее окно (то же делает приложение при перезапуске).
    await sleep(500);
  });
}
