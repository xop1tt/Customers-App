// Импорт клиентов из CSV, отмена импорта, экспорт в CSV и Excel. Файлы выгрузки сверяются с эталоном после прогона (verify.cjs).
{
  const { C, scenario, waitFor, $, click, check, eq, core, coreFails, sleep, norm, shot, golden, skipIf, hasCore, utf8b64, withText, healthy } = E2E;

  const csv = () => golden("import").csv.join("\n");
  const count = async (entity) => (await core("ws_list", { entity, query: { limit: 1 } })).total;
  let batch = null;
  let before = null;

  scenario("import", "Импорт CSV: колонки сопоставляются, дубликаты связываются, считаются записи", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const g = golden("import");
    before = { companies: await count("companies"), contacts: await count("contacts"), deals: await count("deals") };
    const data = utf8b64(csv());
    const read = await core("ws_import_read", { name: "clients.csv", data });
    eq(read.rows, g.rows, "строк в файле");
    eq(read.mapping, g.mapping, "автосопоставление колонок");
    const options = { mapping: read.mapping, duplicates: "link", pipelineId: null, ownerId: null };
    const preview = await core("ws_import_preview", { name: "clients.csv", data, options });
    eq([preview.rows, preview.new, preview.existing, preview.errors], g.preview, "предпросмотр: строк, новых, существующих, ошибок");
    const result = await core("ws_import_run", { name: "clients.csv", data, options });
    eq([result.companies, result.contacts, result.deals, result.notes, result.errors], g.result, "итог импорта: компании, контакты, сделки, заметки, ошибки");
    check(result.batchId, "нет номера пакета импорта");
    batch = result.batchId;
    eq(await count("companies"), before.companies + g.addedCompanies, "компаний после импорта");
    // Повторный импорт того же файла в режиме «пропускать» ничего не создаёт.
    const again = await core("ws_import_run", { name: "clients.csv", data, options: { ...options, duplicates: "skip" } });
    eq([again.companies, again.deals], [0, 0], "повторный импорт в режиме «пропускать» создал записи");
    const history = await core("ws_import_history");
    check(history.some((h) => h.id === batch), "импорт не попал в историю");
    await core("ws_import_run", { name: "x.csv", data: utf8b64("а,б\n"), options: { mapping: [null, null], duplicates: "link" } }).catch(() => {});
    check((await coreFails("ws_import_read", { name: "broken.csv", data: "###не-base64###" })).length > 0, "битый файл принят");
  });

  scenario("export", "Экспорт: CSV и Excel записываются на диск, содержимое совпадает с эталоном", async () => {
    skipIf(!hasCore || !batch, "нет данных предыдущего сценария");
    const g = golden("import");
    const fields = await core("ws_export_fields", { entity: "companies", lang: "ru" });
    const keys = fields.map((f) => f.key).filter((k) => g.exportKeys.includes(k));
    eq(keys, g.exportKeys, "колонки экспорта компаний");
    const out = `${C.dir}/out`;
    const sep = C.platform === "windows" ? "\\" : "/";
    const dirPath = C.platform === "windows" ? out.replace(/\//g, "\\") : out;
    const file = (name) => `${dirPath}${sep}${name}`;
    const request = (format) => ({ entity: "companies", collection: null, query: { sort: [{ field: "name", dir: "asc" }] }, format, fields: keys, lang: "ru" });
    // Папку создаёт приложение само при выгрузке; если нет, сообщение об ошибке покажет, что именно.
    const resCsv = await core("ws_export", { request: request("csv"), path: file("companies.csv") });
    eq(resCsv.count, g.exportCount, "записей в CSV");
    const resX = await core("ws_export", { request: request("xlsx"), path: file("companies.xlsx") });
    eq(resX.count, g.exportCount, "записей в Excel");
    const deals = await core("ws_export_fields", { entity: "deals", lang: "en" });
    const dk = deals.map((f) => f.key).filter((k) => g.dealExportKeys.includes(k));
    await core("ws_export", { request: { entity: "deals", collection: null, query: { sort: [{ field: "title", dir: "asc" }] }, format: "csv", fields: dk, lang: "en" }, path: file("deals-en.csv") });
    await coreFails("ws_export", { request: { ...request("csv"), format: "pdf" }, path: file("bad.pdf") });
    await coreFails("ws_export", { request: { ...request("csv"), fields: [] }, path: file("empty.csv") });
  });

  scenario("import-undo", "Отмена импорта: созданные записи удаляются, остальные не трогаются", async () => {
    skipIf(!hasCore || !batch, "нет данных предыдущего сценария");
    const g = golden("import");
    const r = await core("ws_import_undo", { batch });
    check(r.removed > 0, `отмена ничего не удалила: ${JSON.stringify(r)}`);
    eq(await count("companies"), before.companies, "компаний после отмены импорта");
    eq(await count("deals"), before.deals, "сделок после отмены импорта");
    const twice = await core("ws_import_undo", { batch });
    check(twice.alreadyUndone, "повторная отмена должна сообщать, что импорт уже отменён");
    // Данные исходного прогона остались: компания из «CRM» цела.
    check((await core("ws_list", { entity: "companies", query: { search: golden("crm").searchWord } })).total === 1, "после отмены импорта пропала своя компания");
    void g;
  });

  scenario("import-ui", "Импорт (интерфейс): окно импорта открывается из таблицы клиентов", async () => {
    const rail = $(".rail-btn[aria-label^='CRM']");
    click(rail);
    await sleep(300);
    click(await waitFor(() => withText(".sidebar .nav-item", "Все клиенты")[0], "«Все клиенты»"));
    const btn = await waitFor(() => withText(".crm-bar .btn", "Импорт")[0], "кнопка «Импорт»");
    click(btn);
    await waitFor(() => $("[role=dialog]"), "окно импорта");
    await shot("import-dialog");
    healthy("в окне импорта");
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);
    if ($("[role=dialog]")) click(withText("[role=dialog] .btn", "Отмена")[0] || withText("[role=dialog] .btn", "Закрыть")[0] || $("[role=dialog] .icon-btn"));
    await waitFor(() => !$("[role=dialog]"), "окно импорта закрылось");
  });
}
