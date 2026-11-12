// Ai: подключение локальной модели (тестовый сервер с OpenAI-совместимым API): список моделей, ответ, отказ по ключу, настройки.
{
  const { scenario, waitFor, sleep, $, $$, click, check, eq, core, coreFails, healthy, norm, shot, skipIf, hasCore } = E2E;

  scenario("ai-model", "Ai: список моделей, ответ модели, отказ по неверному ключу, сохранение настроек", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const base = `${window.__E2E__.mock}/ai/v1`;
    eq(await core("ai_models", { baseUrl: base, apiKey: "e2e-model-key" }), ["e2e-model-a", "e2e-model-b"], "список моделей (по алфавиту)");
    const reply = await core("ai_chat", { baseUrl: base + "/", apiKey: "e2e-model-key", body: { model: "e2e-model-a", messages: [{ role: "user", content: "привет" }], stream: true } });
    eq(reply.choices[0].message.content, "Ответ E2E на: привет", "ответ модели");
    eq(reply.stream, true, "приложение просит ответ без потока (stream: false)");
    const err = await coreFails("ai_models", { baseUrl: base, apiKey: "чужой" });
    check(/ключ доступа/.test(err) && /401/.test(err), `отказ по ключу: ${err}`);
    const bad = await coreFails("ai_models", { baseUrl: "ftp://127.0.0.1/v1", apiKey: null });
    check(/Адрес сервера модели/.test(bad), `чужая схема адреса: ${bad}`);
    // Настройки интеграций и Ai сохраняются и читаются обратно.
    const cfg = await core("hub_load");
    const next = { ...cfg, ai: { ...(cfg.ai || {}), enabled: false, baseUrl: base, model: "e2e-model-a", provider: "lmstudio" } };
    await core("hub_save", { value: next });
    eq((await core("hub_load")).ai.model, "e2e-model-a", "модель в сохранённых настройках");
  });

  scenario("ai-ui", "Ai (интерфейс): выдвижной чат без подключённой модели предлагает настроить, остаётся при смене вкладки, настройки Ai открываются", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    click(await waitFor(() => $$(".rail-btn").find((b) => (b.getAttribute("aria-label") || "").startsWith("Ai")), "модуль Ai"));
    const drawer = await waitFor(() => $("#ai-drawer"), "выдвижной чат Ai");
    await waitFor(() => /Подключите локальную модель|Разговор с помощником/.test(norm(drawer.innerText)), "содержимое чата Ai");
    healthy("в чате Ai");
    await shot("ai-chat");
    // Чат остаётся открытым при смене вкладки.
    click($$(".rail-btn").find((b) => (b.getAttribute("aria-label") || "").startsWith("Сообщения")));
    await sleep(300);
    check($("#ai-drawer"), "чат Ai закрылся при смене вкладки");
    const btn = $$("button").find((b) => norm(b.textContent) === "Открыть настройки Ai");
    if (btn) {
      click(btn);
      await waitFor(() => $(".settings"), "настройки Ai");
      await waitFor(() => /^Локальная модель/.test(norm($(".settings-head h2")?.textContent)), "раздел «Локальная модель»");
      healthy("в настройках Ai");
      click($(".settings-head .icon-btn"));
      await waitFor(() => !$(".settings"), "настройки закрылись");
    }
  });
}
