// CRM (интерфейс): массовые действия в таблице «Все клиенты» — выбор строк, «В корзину» с подтверждением, восстановление.
{
  const { scenario, waitFor, $, $$, click, check, eq, core, healthy, sleep, norm, shot, skipIf, hasCore } = E2E;

  const rail = (label) => click($$(".rail-btn").find((b) => (b.getAttribute("aria-label") || "").startsWith(label)), `модуль ${label}`);
  const side = async (label) => { const el = await waitFor(() => $$(".sidebar .nav-item").find((i) => norm(i.textContent).startsWith(label)), `раздел «${label}»`); click(el, label); await sleep(400); };
  const NAMES = ["Массовая А E2E", "Массовая Б E2E"];

  scenario("crm-bulk", "CRM (интерфейс): массовое удаление выбранных клиентов в корзину и восстановление", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const made = [];
    for (const name of NAMES) made.push(await core("ws_save", { entity: "companies", id: null, fields: { name } }));
    rail("CRM");
    await sleep(300);
    await side("Все клиенты");
    await waitFor(() => NAMES.every((n) => norm($("main.center").innerText).includes(n)), "новые клиенты в таблице", { timeout: 15000 });

    const box = (label) => $$("input[type=checkbox]").find((i) => norm(i.closest("label")?.textContent) === label);
    for (const n of NAMES) click(await waitFor(() => box(`Выбрать: ${n}`), `флажок «${n}»`));
    const bar = await waitFor(() => $("[role=toolbar][aria-label='Массовые действия']"), "панель массовых действий");
    check(/2/.test(norm(bar.textContent)), `панель должна показывать 2 выбранные записи: ${norm(bar.textContent)}`);
    await shot("crm-bulk-selected");

    // «Снять выбор» убирает панель.
    click($$("button", bar).find((b) => norm(b.textContent) === "Снять выбор"));
    await waitFor(() => !$("[role=toolbar][aria-label='Массовые действия']"), "панель закрылась после «Снять выбор»");
    for (const n of NAMES) click(await waitFor(() => box(`Выбрать: ${n}`), `флажок «${n}»`));
    const bar2 = await waitFor(() => $("[role=toolbar][aria-label='Массовые действия']"), "панель снова показана");
    click($$("button", bar2).find((b) => norm(b.textContent) === "В корзину"));
    const dlg = await waitFor(() => $("[role=dialog], [role=alertdialog]"), "окно подтверждения");
    click($$("button", dlg).find((b) => norm(b.textContent) === "В корзину"));
    await waitFor(async () => {
      const r = await core("ws_list", { entity: "companies", query: { search: "Массовая" } });
      return r.total === 0;
    }, "клиенты ушли из списка", { timeout: 15000 });
    healthy("после массового удаления");

    // Они лежат в корзине и восстанавливаются.
    for (const m of made) await core("ws_restore", { entity: "companies", id: m.id });
    const back = await core("ws_list", { entity: "companies", query: { search: "Массовая" } });
    eq(back.total, 2, "восстановленные клиенты");
    // Убираем за собой, чтобы не менять эталонные итоги других сценариев.
    for (const m of made) await core("ws_delete", { entity: "companies", id: m.id });
    healthy("после восстановления");
  });
}
