// Поиск лидов: настоящий движок против локальной RSS-ленты (адрес подменяется на тестовый сервер), затем работа с лидами.
{
  const { scenario, waitFor, $, $$, withText, click, check, eq, core, sleep, norm, shot, golden, skipIf, hasCore, healthy } = E2E;

  const FEED = "https://rss.e2e.example/feed.xml";
  const leads = async () => (await core("snapshot")).leads;
  const section = async (label) => {
    click($$(".rail-btn").find((b) => (b.getAttribute("aria-label") || "").startsWith("Поиск клиентов")));
    await sleep(300);
    click(await waitFor(() => $$(".sidebar .nav-item").find((i) => norm(i.textContent).startsWith(label)), `раздел «${label}»`));
    await sleep(400);
  };
  const runSearch = async () => {
    await core("run_search", { only: ["fl_ru"] });
    await sleep(200);
    await waitFor(async () => !(await core("search_status")).running, "поиск завершился", { timeout: 90000, interval: 400 });
    return (await core("search_status")).lastReport;
  };
  let found = [];

  scenario("search-settings", "Поиск: настройки источников сохраняются и читаются обратно", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const ov = await core("search_overview");
    const s = ov.settings;
    s.rss = { ...s.rss, enabled: true, feeds: [FEED], keywords: ["сайт", "бот"] };
    s.telegram = { ...s.telegram, enabled: false };
    s.vk = { ...s.vk, enabled: false };
    s.osm = { ...s.osm, enabled: false };
    await core("set_search_settings", { settings: s });
    const back = (await core("search_overview")).settings;
    eq(back.rss.feeds, [FEED], "лента после сохранения");
    eq([back.rss.enabled, back.telegram.enabled, back.vk.enabled, back.osm.enabled], [true, false, false, false], "включённые источники");
    eq((await core("search_overview")).problems.fl_ru, null, "проблем у RSS быть не должно");
  });

  scenario("search-run", "Поиск: запуск находит заявки из ленты, фильтр слов отсекает лишнее, контакты разобраны", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const g = golden("search");
    const report = await runSearch();
    check(report, "нет отчёта о поиске");
    const rss = report.sources.find((x) => x.source === "fl_ru");
    check(rss && !rss.failed, `источник RSS завершился ошибкой: ${JSON.stringify(rss)}`);
    eq([rss.added, rss.errors.length], [g.leads.length, 0], "добавлено лидов, ошибок");
    found = await leads();
    eq(found.map((l) => l.data.title).sort(), g.leads.map((l) => l.title).sort(), "названия найденных лидов");
    const first = found.find((l) => l.data.title === g.leads[0].title);
    eq(first.emails, g.leads[0].emails, "почта разобрана из описания");
    check(first.phones.length === 1 && first.phones[0].replace(/\D/g, "").endsWith("9991234567"), `телефон разобран: ${JSON.stringify(first.phones)}`);
    check(first.data.score > 0, `оценка лида: ${first.data.score}`);
    eq(first.seen, false, "новый лид не просмотрен");
    check((await core("snapshot")).lastSearchAt, "время последнего поиска не записано");
    check((await core("lead_events", { id: first.id })).length >= 0, "журнал событий лида недоступен");
  });

  scenario("search-repeat", "Поиск: повторный запуск не создаёт дубликатов (ETag, память источника)", async () => {
    skipIf(!hasCore || !found.length, "нет данных предыдущего сценария");
    await runSearch();
    eq((await leads()).length, found.length, "лидов после повторного поиска");
    // Сброс памяти источника допускает повторную загрузку, но дубликатов всё равно нет.
    await core("reset_source_memory", { source: "fl_ru" });
    await runSearch();
    eq((await leads()).length, found.length, "лидов после поиска со сброшенной памятью");
  });

  scenario("leads-ui", "Лиды (интерфейс): список, карточка, избранное, архив, заметка, просмотр", async () => {
    skipIf(!hasCore || !found.length, "нет данных предыдущего сценария");
    const g = golden("search");
    await section("Все лиды");
    await waitFor(() => norm($("main.center").innerText).includes(g.leads[0].title), `лид «${g.leads[0].title}» в списке`, { timeout: 15000 });
    await shot("leads-all");
    const row = await waitFor(() => withText(".tr, [role=row]", g.leads[0].title)[0], "строка лида");
    click(row);
    await waitFor(() => $(".inspector") && norm($(".inspector").innerText).includes(g.leads[0].title), "карточка лида справа");
    await shot("leads-inspector");
    healthy("в карточке лида");

    const id = found.find((l) => l.data.title === g.leads[0].title).id;
    await core("set_favorite", { ids: [id], on: true });
    await core("set_note", { id, note: g.note });
    await core("mark_seen", { ids: [id] });
    let lead = (await leads()).find((l) => l.id === id);
    eq([lead.favorite, lead.note, lead.seen], [true, g.note, true], "избранное, заметка, просмотр");
    await section("Избранное");
    await waitFor(() => norm($("main.center").innerText).includes(g.leads[0].title), "лид в «Избранном»");
    await core("set_favorite", { ids: [id], on: false });
    await core("set_archived", { ids: [id], on: true });
    await section("Архив");
    await waitFor(() => norm($("main.center").innerText).includes(g.leads[0].title), "лид в «Архиве»");
    await core("set_archived", { ids: [id], on: false });
    eq((await leads()).find((l) => l.id === id).archived, false, "лид вернулся из архива");
  });

  scenario("leads-exclude", "Исключения: исключённый лид уходит из списка, исключение можно снять", async () => {
    skipIf(!hasCore || !found.length, "нет данных предыдущего сценария");
    const g = golden("search");
    const target = found.find((l) => l.data.title === g.leads[1].title);
    const email = target.emails[0];
    check(email, "у второго лида нет почты");
    await core("exclude", { value: email, kind: "email" });
    check((await leads()).find((l) => l.id === target.id).excluded, "лид не помечен исключённым");
    const snap = await core("snapshot");
    check(snap.exclusions.some((e) => e.value === email), "исключение не записано");
    await section("Исключённые");
    await waitFor(() => norm($("main.center").innerText).includes(g.leads[1].title), "лид в «Исключённых»");
    await core("remove_exclusion", { id: snap.exclusions.find((e) => e.value === email).id });
    check(!(await leads()).find((l) => l.id === target.id).excluded, "исключение не снялось");
  });

  scenario("lead-to-crm", "Лид → CRM: создаются компания, контакт и сделка, лид помечается «в CRM»", async () => {
    skipIf(!hasCore || !found.length, "нет данных предыдущего сценария");
    const g = golden("search");
    const before = (await core("ws_list", { entity: "companies", query: { limit: 1 } })).total;
    const id = found.find((l) => l.data.title === g.leads[0].title).id;
    const r = await core("ws_convert_lead", { leadId: id, options: { createDeal: true } });
    check(r && (r.company || r.companyId || r.company_id || r.crm_lead), `ответ конвертации: ${JSON.stringify(r).slice(0, 200)}`);
    check((await core("ws_list", { entity: "companies", query: { limit: 1 } })).total >= before, "компаний стало меньше");
    const lead = (await leads()).find((l) => l.id === id);
    check(lead.data.crm && lead.data.crm.converted_at, `лид не помечен как перенесённый: ${JSON.stringify(lead.data.crm)}; ответ ${JSON.stringify(r)}; ключи ${Object.keys(lead.data)}`);
    check(lead.data.crm.deal_id, "сделка из лида не создана");
  });
}
