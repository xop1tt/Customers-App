// Запуск настоящего приложения: окно не пустое, ядро отвечает, интерфейс не упал.
{
  const { C, scenario, waitFor, $, check, eq, core, hasCore, dom, norm, skipIf } = E2E;

  scenario("boot", "Запуск: окно не пустое, ядро отвечает, версия и платформа верны", async () => {
    await waitFor(() => $(".auth, .welcome, .shell"), "первый экран (вход, мастер или рабочее окно)", { timeout: 45000 });
    check(($("#root") || {}).children && $("#root").children.length > 0, "корневой элемент пуст (белое окно)");
    check(!norm(dom()).includes("Не удалось запустить приложение"), `экран ошибки запуска: ${dom()}`);
    check(!norm(dom()).includes("Интерфейс не смог открыться"), `экран ошибки отрисовки: ${dom()}`);
    check(window.innerWidth >= 400 && window.innerHeight >= 300, `окно слишком маленькое: ${window.innerWidth}×${window.innerHeight}`);
    check(document.documentElement.scrollWidth <= window.innerWidth + 1, "страница шире окна (горизонтальная прокрутка)");
    skipIf(!hasCore, "нет ядра Tauri");
    const b = await core("boot_info");
    eq(b.error, null, "ошибка запуска ядра");
    check(/^\d+\.\d+\.\d+/.test(b.version), `версия ${b.version}`);
    if (C.platform) eq(b.platform, C.platform, "платформа");
    eq(b.session, null, "до входа сессии быть не должно");
    check(!b.hasUsers, "в чистой папке данных уже есть аккаунты");
  }, { fatal: true });

  scenario("paths", "Папки данных: приложение пишет только в отведённую папку", async () => {
    skipIf(!hasCore, "нет ядра Tauri");
    const p = await core("paths_info");
    check(p.root && p.logs, `paths_info: ${JSON.stringify(p)}`);
    if (C.dir) {
      const flat = (s) => s.replace(/\\/g, "/").toLowerCase();
      check(flat(p.root).startsWith(flat(C.dir)), `данные вне папки проверки: ${p.root}`);
    }
  });
}
