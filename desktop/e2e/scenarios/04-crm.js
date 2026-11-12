// CRM: клиенты, контакты, сделки, задачи, заметки, корзина, дубликаты, проверка данных; затем то же в интерфейсе.
{
  const { scenario, waitFor, $, $$, withText, click, clickText, type, check, eq, core, coreFails, healthy, sleep, norm, shot, golden, dom, skipIf, hasCore } = E2E;

  const ids = {};
  const list = (entity, query) => core("ws_list", { entity, query: query || null });
  const rail = (label) => click($$(".rail-btn").find((b) => (b.getAttribute("aria-label") || "").startsWith(label)), `модуль ${label}`);
  const side = async (label) => { const el = await waitFor(() => $$(".sidebar .nav-item").find((i) => norm(i.textContent).startsWith(label)), `раздел «${label}»`); click(el, label); await sleep(400); };
  const today = () => new Date().toISOString();

  scenario("crm-core", "CRM (ядро): компания, контакт, сделка, задача, заметка, звонок; поиск и дубликаты", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const g = golden("crm");
    // Воронка по умолчанию и её этапы создаются вместе с рабочим пространством.
    const pipes = (await list("pipelines", { limit: 50 })).items.filter((p) => !p.deleted_at);
    check(pipes.length >= 1, "нет воронки по умолчанию");
    const pipe = pipes.find((p) => p.is_default) || pipes[0];
    const stages = (await list("pipeline_stages", { limit: 500, sort: [{ field: "position", dir: "asc" }] })).items.filter((s) => s.pipeline_id === pipe.id && !s.deleted_at);
    check(stages.length >= 3, `в воронке слишком мало этапов: ${stages.length}`);
    check(stages.some((s) => s.kind === "won") && stages.some((s) => s.kind === "lost"), "в воронке нет этапов «выиграна» и «проиграна»");
    ids.pipeline = pipe.id;
    ids.open = stages.find((s) => s.kind === "open").id;
    ids.won = stages.find((s) => s.kind === "won").id;
    ids.lost = stages.find((s) => s.kind === "lost").id;

    const company = await core("ws_save", { entity: "companies", id: null, fields: g.company });
    eq(company.name, g.company.name, "название компании");
    check(/^[0-9a-f-]{36}$/.test(company.id), `id компании: ${company.id}`);
    check(Number.isInteger(company.version), `версия новой записи: ${company.version}`);
    ids.company = company.id;

    const contact = await core("ws_save", { entity: "contacts", id: null, fields: { ...g.contact, company_id: company.id } });
    eq(contact.full_name, g.contactFullName, "полное имя контакта");
    ids.contact = contact.id;

    const deal = await core("ws_save", { entity: "deals", id: null, fields: { ...g.deal, pipeline_id: ids.pipeline, stage_id: ids.open, company_id: company.id } });
    eq([deal.title, deal.amount, deal.currency, deal.status], [g.deal.title, g.deal.amount, g.deal.currency, "open"], "новая сделка");
    ids.deal = deal.id;

    const task = await core("ws_save", { entity: "tasks", id: null, fields: { ...g.task, due_at: today(), entity_type: "deal", entity_id: deal.id } });
    eq(task.status, "todo", "статус новой задачи");
    ids.task = task.id;

    const note = await core("ws_save", { entity: "notes", id: null, fields: { body: g.note, entity_type: "company", entity_id: company.id } });
    ids.note = note.id;
    await core("ws_save", { entity: "activities", id: null, fields: { type: "call", summary: g.activity, entity_type: "company", entity_id: company.id } });

    // Карточка собирает связанное.
    const card = await core("ws_card", { entity: "companies", id: company.id });
    eq([card.contacts.length, card.deals.length, card.notes.length, card.activities.length], [1, 1, 1, 1], "карточка компании: контакты, сделки, заметки, звонки");

    // Поиск по тексту и фильтры.
    eq((await list("companies", { search: g.searchWord })).total, 1, "поиск компании по слову");
    eq((await list("companies", { search: "несуществующееслово" })).total, 0, "поиск несуществующего");
    eq((await list("deals", { filters: [{ field: "stage_id", op: "eq", value: ids.open }] })).total, 1, "фильтр сделок по этапу");

    // Дубликаты находятся по названию и по телефону.
    const dup = await core("ws_duplicates", { entity: "companies", fields: { name: g.company.name }, except: null });
    check(dup.length >= 1, "дубликат компании по названию не найден");
    const dupPhone = await core("ws_duplicates", { entity: "contacts", fields: { phones: g.contact.phones }, except: null });
    check(dupPhone.length >= 1, "дубликат контакта по телефону не найден");

    // Сделка выигрывается: статус и дата закрытия считает ядро; история этапов пишется.
    const won = await core("ws_save", { entity: "deals", id: deal.id, fields: { stage_id: ids.won } });
    eq(won.status, "won", "статус после перевода на выигранный этап");
    check(won.closed_at, "нет даты закрытия у выигранной сделки");
    check(won.updated_at >= deal.updated_at, "updated_at не обновился после изменения");
    const history = await core("ws_stage_history");
    check(history.filter((h) => h.deal_id === deal.id).length >= 2, "история этапов сделки не записана");
    await core("ws_save", { entity: "deals", id: deal.id, fields: { stage_id: ids.open } });
  });

  scenario("crm-validation", "CRM (ядро): пустые и слишком длинные значения отклоняются понятной ошибкой", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    check((await coreFails("ws_save", { entity: "companies", id: null, fields: {} })).length > 0, "пустая компания принята");
    await coreFails("ws_save", { entity: "deals", id: null, fields: { title: "Без воронки" } });
    await coreFails("ws_save", { entity: "companies", id: null, fields: { name: "x".repeat(400) } });
    await coreFails("ws_save", { entity: "tasks", id: null, fields: { title: "Задача", priority: "срочно-срочно" } });
    await coreFails("ws_save", { entity: "нет_такой_таблицы", id: null, fields: { name: "x" } });
    await coreFails("ws_card", { entity: "companies", id: "00000000-0000-4000-8000-000000000000" });
  });

  scenario("crm-trash", "Корзина: удаление, восстановление, чужие записи не теряются", async () => {
    skipIf(!hasCore || !ids.task, "нет данных предыдущего сценария");
    const extra = await core("ws_save", { entity: "tasks", id: null, fields: { title: "Удаляемая задача" } });
    await core("ws_delete", { entity: "tasks", id: extra.id });
    const inTrash = await list("tasks", { deleted: true });
    check(inTrash.items.some((t) => t.id === extra.id), "удалённая задача не попала в корзину");
    check(!(await list("tasks", {})).items.some((t) => t.id === extra.id), "удалённая задача осталась в списке");
    check((await list("tasks", {})).items.some((t) => t.id === ids.task), "посторонняя задача пропала вместе с удалённой");
    await core("ws_restore", { entity: "tasks", id: extra.id });
    check((await list("tasks", {})).items.some((t) => t.id === extra.id), "задача не вернулась из корзины");
    await core("ws_delete", { entity: "tasks", id: extra.id });
  });

  scenario("crm-ui", "CRM (интерфейс): данные видны на страницах «Сегодня», «Сделки», «Все клиенты», «Корзина»", async () => {
    skipIf(!hasCore || !ids.company, "нет данных предыдущего сценария");
    const g = golden("crm");
    rail("CRM");
    await sleep(300);
    // Перечитываем: данные созданы мимо интерфейса (через ядро), как если бы их принесла синхронизация.
    await side("Сегодня");
    await waitFor(() => norm($("main.center").innerText).includes(g.task.title), `задача «${g.task.title}» на странице «Сегодня»`, { timeout: 15000 });
    await shot("crm-today");
    await side("Сделки");
    await waitFor(() => norm($("main.center").innerText).includes(g.deal.title), `сделка «${g.deal.title}» на доске`, { timeout: 15000 });
    check(norm($("main.center").innerText).includes("150 000"), "сумма сделки не показана на карточке");
    await shot("crm-deals");
    await side("Все клиенты");
    await waitFor(() => norm($("main.center").innerText).includes(g.company.name), `компания «${g.company.name}» в таблице`, { timeout: 15000 });
    await shot("crm-companies");
    // Карточка открывается по клику на строку и показывает связанное.
    const row = await waitFor(() => withText("[role=row], tr, .tr", g.company.name)[0], "строка компании");
    click(row);
    await waitFor(() => norm(document.body.innerText).includes(g.contactFullName), `контакт «${g.contactFullName}» в карточке компании`, { timeout: 15000 });
    await shot("crm-card");
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
    await side("Корзина");
    healthy("в корзине");
    await side("Календарь");
    healthy("в календаре");
    await side("Отчёты");
    await waitFor(() => norm($("main.center").innerText).length > 40, "отчёты показывают данные");
    healthy("в отчётах");
    await side("Журнал");
    await waitFor(() => norm($("main.center").innerText).includes(g.company.name) || norm($("main.center").innerText).includes("Создана") || norm($("main.center").innerText).length > 40, "журнал действий показывает записи");
    healthy("в журнале");
  });
}
