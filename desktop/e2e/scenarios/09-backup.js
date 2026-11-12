// Резервные копии и перенос: создание, список, восстановление; переносимая копия с ключом; проверка, что данные не теряются.
{
  const { C, scenario, check, eq, core, coreFails, sleep, skipIf, hasCore, golden } = E2E;

  const sep = () => (C.platform === "windows" ? "\\" : "/");
  const outDir = () => (C.platform === "windows" ? `${C.dir}/out`.replace(/\//g, "\\") : `${C.dir}/out`);
  const count = async (entity) => (await core("ws_list", { entity, query: { limit: 1 } })).total;
  let backupPath = null;
  let marker = null;

  scenario("backup", "Резервная копия: создаётся, видна в списке, восстановление возвращает данные", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    marker = await core("ws_save", { entity: "companies", id: null, fields: { name: "Компания для копии" } });
    backupPath = await core("backup_now");
    check(backupPath, "backup_now не вернул путь");
    const list = await core("list_backups");
    check(list.length >= 1 && list.some((b) => b.path === backupPath || String(backupPath).endsWith(b.name)), `копия не в списке: ${JSON.stringify(list).slice(0, 300)}`);
    check(list[0].size > 0, "файл копии пуст");
    // Данные меняются после копии, восстановление возвращает состояние на момент копии.
    await core("ws_delete", { entity: "companies", id: marker.id });
    const wsBefore = await count("companies");
    const msg = await core("restore_backup", { path: backupPath });
    check(msg, "нет ответа о восстановлении");
    await sleep(500);
    const back = await core("ws_list", { entity: "companies", query: { search: "Компания для копии" } });
    check(back.total === 1, `после восстановления компания из копии не вернулась (всего компаний было ${wsBefore})`);
    const leads = (await core("snapshot")).leads;
    check(leads.length >= 2, "после восстановления пропали лиды");
  });

  scenario("portable", "Переносимая копия: ключ создаётся один раз, файл шифруется, неверный ключ отклоняется", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    let st = await core("portable_state");
    const key = st.hasKey ? await core("create_portable_key", { replace: true }) : await core("create_portable_key", { replace: false });
    check(typeof key === "string" && key.length >= 16, `ключ восстановления: ${String(key).length} символов`);
    const file = `${outDir()}${sep()}portable${String(st.extension).startsWith(".") ? "" : "."}${st.extension}`;
    const r = await core("export_portable", { path: file });
    check(r, "export_portable не ответил");
    st = await core("portable_state");
    check(st.hasKey, "ключ не отмечен как созданный");
    const bad = await coreFails("import_portable", { path: file, key: "неверный-ключ-0000" });
    check(bad.length > 0, "импорт с неверным ключом принят");
    const before = await count("companies");
    await core("import_portable", { path: file, key });
    check((await count("companies")) >= before - 0, "после импорта переносимой копии компаний стало меньше");
    void golden;
  });
}
