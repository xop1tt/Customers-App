// Обновления: проверка релизов GitHub (подменена на тестовый сервер): «актуальная версия», «есть новая», ошибка сервера,
// защита контрольной суммой (установщик с чужой суммой не принимается).
{
  const { scenario, waitFor, $, $$, click, check, eq, core, coreFails, sleep, norm, shot, skipIf, hasCore, mock, healthy } = E2E;

  // Состояние приходит как { phase: "available" } (у ошибки ещё и message).
  const phase = (info) => (info.phase && typeof info.phase === "object" ? info.phase.phase : info.phase);
  const openUpdates = async () => {
    await E2E.openSettingsUi();
    click($$(".settings-nav .nav-item").find((i) => norm(i.textContent).startsWith("Обновления")));
    await waitFor(() => norm($(".settings-head h2")?.textContent).startsWith("Обновления"), "раздел «Обновления»");
    await sleep(400);
  };
  const close = async () => { if ($(".settings")) click($(".settings-head .icon-btn")); await waitFor(() => !$(".settings"), "настройки закрылись"); };

  scenario("updates-uptodate", "Обновления: сервер сообщает ту же версию — «актуальная версия»", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    // Фоновая загрузка выключена: проверяется только поиск обновления, сеть не используется кроме тестового сервера.
    await core("patch_device_prefs", { changes: { backgroundDownload: false } });
    const v = (await core("boot_info")).version;
    await mock(`uptodate:${v}`);
    const info = await core("check_updates", { manual: true });
    eq([phase(info), info.available], ["upToDate", null], "состояние после проверки (та же версия)");
    eq(info.current, v, "текущая версия");
    check(info.lastCheck, "время последней проверки не записано");
  }, { mockOnly: true });

  scenario("updates-available", "Обновления: найдена версия 99.0.0 — показана в настройках с описанием", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    await mock("available");
    const info = await core("check_updates", { manual: true });
    eq(phase(info), "available", "состояние после проверки (есть новая версия)");
    eq(info.available.version, "99.0.0", "найденная версия");
    check(String(info.available.notes).includes("Проверочный релиз 99.0.0"), `описание релиза: ${info.available.notes}`);
    await openUpdates();
    await waitFor(() => norm($(".settings-content").innerText).includes("99.0.0"), "версия 99.0.0 на странице «Обновления»", { timeout: 10000 });
    await shot("updates-available");
    healthy("на странице обновлений");
    await close();
  }, { mockOnly: true });

  scenario("updates-checksum", "Обновления: установщик с несовпавшей контрольной суммой отклоняется и не сохраняется", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const info = await core("update_info");
    skipIf(!info.canUpdate, "эта сборка не обновляется сама (не установленная копия)");
    eq(phase(info), "available", "перед загрузкой должно быть доступно обновление");
    const err = await coreFails("prepare_update", {});
    check(/контрольн|сумм/i.test(err), `ошибка загрузки должна называть контрольную сумму: ${err}`);
    const after = await core("update_info");
    check(after.stagedVersion === null || after.stagedVersion === undefined, `проваленная загрузка осталась сохранённой: ${after.stagedVersion}`);
  }, { mockOnly: true });

  scenario("updates-error", "Обновления: ошибка сервера — понятное сообщение, приложение работает", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    await mock("error");
    const err = await coreFails("check_updates", { manual: true });
    check(/GitHub|код 500|ответил/i.test(err), `сообщение об ошибке проверки: ${err}`);
    healthy("после ошибки проверки обновлений");
    await mock("uptodate:" + (await core("boot_info")).version);
    eq(phase(await core("check_updates", { manual: true })), "upToDate", "после восстановления сервера проверка проходит");
  }, { mockOnly: true });
}
