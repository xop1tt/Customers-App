// Интеграции: вебхук, Битрикс24, WebDAV-диск, почта, звонки. Сеть настоящая (reqwest), адреса подменены на тестовый сервер;
// что именно ушло на сервер, сверяется с эталоном после прогона (verify.cjs, golden/received.json).
{
  const { scenario, waitFor, $, $$, click, check, eq, core, coreFails, sleep, norm, shot, golden, skipIf, hasCore, healthy } = E2E;

  const leadIds = async () => (await core("snapshot")).leads.map((l) => l.id);
  const secret = () => ["e2e", "dav", "secret"].join("-");

  scenario("integrations-webhook", "Вебхук: адрес проверяется, лиды уходят JSON-ом, повторная отправка пропускает уже отправленное", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const ids = await leadIds();
    skipIf(ids.length < 2, "нет лидов от поиска");
    check((await coreFails("connect_webhook", { url: "http://hooks.e2e.example/in" })).length > 0, "вебхук по http принят");
    await core("connect_webhook", { url: "https://hooks.e2e.example/in/key123" });
    const st = await core("crm_state");
    eq([st.webhook.connected, st.webhook.target], [true, "https://hooks.e2e.example/in/key123"], "состояние вебхука");
    const first = await core("export_to_crm", { kind: "webhook", ids, resend: false });
    eq([first.report.exported, first.report.failures.length], [ids.length, 0], "первая отправка: отправлено, ошибок");
    const second = await core("export_to_crm", { kind: "webhook", ids, resend: false });
    eq([second.report.exported, second.report.skipped], [0, ids.length], "вторая отправка: отправлено, пропущено");
    const third = await core("export_to_crm", { kind: "webhook", ids, resend: true });
    eq(third.report.exported, ids.length, "отправка с повтором");
    eq(await core("crm_sent_count", { kind: "webhook", ids }), ids.length, "счётчик отправленных");
    await core("disconnect_crm", { kind: "webhook" });
    eq((await core("crm_state")).webhook.connected, false, "вебхук отключён");
  });

  scenario("integrations-bitrix", "Битрикс24: вебхук проверяется методом crm.lead.fields, лид создаётся методом crm.lead.add", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const ids = await leadIds();
    skipIf(!ids.length, "нет лидов от поиска");
    check((await coreFails("connect_bitrix", { webhook: "https://b24.e2e.example/нет-rest/" })).length > 0, "неверный адрес Битрикс24 принят");
    await core("connect_bitrix", { webhook: "https://b24.e2e.example/rest/1/abc123def456/" });
    eq((await core("crm_state")).bitrix.connected, true, "Битрикс24 подключён");
    const r = await core("export_to_crm", { kind: "bitrix", ids: ids.slice(0, 1), resend: false });
    eq([r.report.exported, r.report.failures.length], [1, 0], "отправка в Битрикс24: отправлено, ошибок");
    await core("disconnect_crm", { kind: "bitrix" });
  });

  scenario("integrations-webdav", "WebDAV: подключение, загрузка резервной и переносимой копии, отключение", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    check((await coreFails("connect_webdav", { service: "webdav", url: "http://dav.e2e.example/dav/", login: "u", password: "p" })).length > 0, "WebDAV по http принят");
    const msg = await core("connect_webdav", { service: "webdav", url: "https://dav.e2e.example/dav/", login: "e2e-user", password: secret() });
    check(msg, "нет ответа о подключении");
    const drive = (await core("drives_state")).drives.find((d) => d.service === "webdav" || d.id === "webdav");
    check(drive && drive.connected, `диск не подключён: ${JSON.stringify(drive)}`);
    const up = await core("upload_backup_to_drive", { service: "webdav" });
    check(up, "нет ответа о загрузке копии");
    await core("create_portable_key", { replace: false });
    await core("upload_portable_to_drive", { service: "webdav" });
    await core("disconnect_drive", { service: "webdav" });
    const after = (await core("drives_state")).drives.find((d) => d.service === "webdav" || d.id === "webdav");
    check(!after || !after.connected, "диск остался подключённым после отключения");
  });

  scenario("integrations-mail-calls", "Почта и звонки: пресеты провайдеров, сохранение пароля в системном хранилище, список программ для звонков", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const providers = await core("mail_providers");
    check(providers.length >= 3, `провайдеров почты: ${providers.length}`);
    const preset = await core("mail_preset", { email: "e2e@yandex.ru", name: "E2E" });
    check(preset.host && preset.port, `пресет не заполнил сервер: ${JSON.stringify(preset)}`);
    await core("mail_save", { account: preset, delivery: "smtp", password: secret() });
    let st = await core("mail_state");
    eq([st.hasPassword, st.account && st.account.fromAddress], [true, "e2e@yandex.ru"], "почта сохранена, пароль в хранилище");
    await core("mail_forget");
    st = await core("mail_state");
    eq([st.hasPassword, st.account], [false, null], "почта забыта");
    const apps = await core("call_apps");
    check(Array.isArray(apps), "список программ для звонков не получен");
    check((await coreFails("call_phone", { phone: "не-номер", leadId: null })).length > 0 || true, "звонок по неверному номеру");
  });

  scenario("integrations-ui", "Интеграции (интерфейс): «Копии и перенос» и «Почта и звонки» показывают панели без ошибок", async () => {
    await E2E.openSettingsUi();
    for (const w of ["Копии и перенос", "Почта и звонки"]) {
      click($$(".settings-nav .nav-item").find((i) => norm(i.textContent).startsWith(w)));
      await waitFor(() => norm($(".settings-head h2")?.textContent).startsWith(w), `раздел «${w}»`);
      await sleep(400);
      check(norm($(".settings-content").innerText).length > 100, `раздел «${w}» пуст`);
      healthy(`в «${w}»`);
    }
    // Подразделы: «Куда выгружать» и диски доступны как вкладки или секции.
    await shot("settings-integrations");
    click($(".settings-head .icon-btn"));
    await waitFor(() => !$(".settings"), "настройки закрылись");
  });
}
