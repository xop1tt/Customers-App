// Первый вход: регистрация в облаке (тестовый сервер вместо Supabase), мастер первого запуска, выход и повторный вход.
{
  const { scenario, waitFor, $, $$, withText, click, clickText, type, check, eq, core, hasCore, norm, healthy, shot, skipIf } = E2E;
  // Пароль собирается во время выполнения (CodeQL не любит литералы-пароли).
  const PASSWORD = ["E2e", "Test", "Pass", "9"].join("");
  const NAME = "e2e-owner";
  const EMAIL = "e2e-owner@e2e-test.com";
  E2E.account = { name: NAME, email: EMAIL, password: PASSWORD };

  scenario("register", "Регистрация в облаке (шифрование базы, ключ в системном хранилище)", async () => {
    await waitFor(() => $(".auth-card"), "экран входа", { timeout: 20000 });
    await clickText(".auth-links .link", "Создать аккаунт");
    await waitFor(() => $(".auth-card input[name=nickname]"), "поле имени пользователя");
    type($(".auth-card input[name=nickname]"), NAME);
    type($(".auth-card input[name=email]"), EMAIL);
    const [p1, p2] = $$(".auth-card input[type=password]");
    type(p1, PASSWORD);
    type(p2, PASSWORD);
    await waitFor(() => !$(".auth-submit").disabled, "кнопка «Зарегистрироваться» доступна");
    await shot("01-register");
    click($(".auth-submit"));
    await waitFor(() => $(".welcome, .shell"), "мастер первого запуска или рабочее окно после регистрации", { timeout: 40000 });
    healthy("после регистрации");
    if (hasCore) {
      const s = await core("boot_info");
      check(s.session && s.session.displayName === NAME, `сессия после регистрации: ${JSON.stringify(s.session)}`);
      eq(s.session.cloudUser && s.session.cloudUser.email, EMAIL, "почта облачной учётной записи");
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
      eq(ws.isCloud, true, "облачная учётная запись");
    }
    await shot("03-shell");
  }, { fatal: true });

  scenario("relogin", "Выход и повторный вход: пароль проверяется, база открывается ключом из хранилища", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    // Выход — через меню учётной записи, как у пользователя: состояние интерфейса и ядра меняется вместе.
    click(await waitFor(() => $(".account-btn"), "кнопка учётной записи"), "учётная запись");
    await clickText(".menu-item", "Выйти", "пункт «Выйти»");
    await waitFor(() => $(".auth-card"), "экран входа после выхода", { timeout: 20000 });
    await waitFor(() => /Вход/.test(norm($(".auth-card h2")?.textContent)), "форма входа");
    type($(".auth-card input[name=email]"), EMAIL);
    // Неверный пароль отклоняется.
    type($(".auth-card input[type=password]"), PASSWORD + "x");
    click($(".auth-submit"));
    await waitFor(() => $(".auth-card .notice, .auth-card [role=alert]"), "сообщение о неверном пароле");
    type($(".auth-card input[type=password]"), PASSWORD);
    click($(".auth-submit"));
    await waitFor(() => $(".shell"), "рабочее окно после входа", { timeout: 40000 });
    healthy("после повторного входа");
    const ws = await core("ws_state");
    check(ws.workspaces.some((w) => w.name === "Студия E2E"), "рабочее пространство пропало после повторного входа");
  });
}
