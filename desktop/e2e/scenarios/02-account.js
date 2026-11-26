// Первый запуск: входа нет, локальная учётная запись открывается сразу; мастер первого запуска; имя профиля.
{
  const { scenario, waitFor, $, $$, withText, click, type, check, eq, core, hasCore, norm, healthy, shot, skipIf } = E2E;
  const NAME = "e2e-owner";
  E2E.account = { name: NAME };

  scenario("local-start", "Первый запуск без входа: база зашифрована ключом из системного хранилища", async () => {
    await waitFor(() => $(".welcome, .shell"), "мастер первого запуска или рабочее окно", { timeout: 40000 });
    check(!$(".auth, .auth-card"), "показан экран входа");
    healthy("при первом запуске");
    await shot("01-first-start");
    if (hasCore) {
      const s = await core("boot_info");
      check(s.session && /^local-/.test(s.session.id), `локальная сессия: ${JSON.stringify(s.session)}`);
      check(!("cloudUser" in s.session), "в сессии остались сведения об облачной учётной записи");
    }
  }, { fatal: true });

  scenario("welcome", "Мастер первого запуска: пять шагов, название компании сохраняется", async () => {
    skipIf(!$(".welcome"), "мастер не показан");
    const seen = [];
    for (let i = 0; i < 8 && $(".welcome"); i++) {
      const h1 = norm($(".welcome-head h1")?.textContent);
      seen.push(h1.replace(/,.*$/, ""));
      const company = withText(".field-label", "Название")[0];
      if (company) type($("input", company.closest(".field")), "Студия E2E");
      if (i === 0) await shot("02-welcome");
      click($(".welcome-foot .btn-primary"), "Далее");
      await waitFor(() => !$(".welcome") || norm($(".welcome-head h1")?.textContent) !== h1, `переход со шага «${h1}»`, { timeout: 15000 });
    }
    await waitFor(() => $(".shell"), "рабочее окно после мастера", { timeout: 20000 });
    eq(seen, E2E.golden("wizard").steps, "шаги мастера");
    healthy("после мастера");
    if (hasCore) {
      const ws = await core("ws_state");
      const active = ws.workspaces.find((w) => w.id === ws.active);
      check(active && active.name === "Студия E2E", `рабочее пространство после мастера: ${JSON.stringify(active)}`);
      check(ws.workspaces.every((w) => !w.remote), "есть облачное рабочее пространство");
      check(!("isCloud" in ws), "в состоянии рабочего пространства остались сведения об облаке");
    }
    await shot("03-shell");
  }, { fatal: true });

  scenario("profile", "Профиль: имя сохраняется локально; в меню учётной записи нет «Выйти» и «Коннекторы»", async () => {
    click(await waitFor(() => $(".account-btn"), "кнопка учётной записи"), "учётная запись");
    const items = await waitFor(() => { const l = $$(".menu-item").map((b) => norm(b.textContent)); return l.length ? l : null; }, "меню учётной записи");
    check(!items.some((t) => /Выйти|Коннекторы/.test(t)), `в меню учётной записи остались облачные пункты: ${JSON.stringify(items)}`);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    skipIf(!hasCore, "нет ядра Tauri");
    const s = await core("set_profile", { name: NAME });
    eq(s.displayName, NAME, "имя профиля");
    eq((await core("boot_info")).session.displayName, NAME, "имя профиля после сохранения");
  });
}
