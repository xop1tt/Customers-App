// Проверка готовности сборки: версии, идентичность приложения, отсутствие отладочных возможностей.
// Все проверки читают реальные файлы проекта; при любой ошибке код выхода 1 и список проблем.
//
//   node scripts/release-check.cjs                — общие проверки (каждый PR)
//   node scripts/release-check.cjs --tag v1.3.0   — плюс тег релиза (сравнивается с версией в файлах)
//
// Канал один (ADR-034): предварительных версий, Beta-сборок и Debug Menu нет. Описание: docs/RELEASE_PROCESS.md.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8").replace(/^\uFEFF/, "");
const problems = [];
const ok = [];
const check = (cond, okText, badText) => (cond ? ok.push(okText) : problems.push(badText));

const args = process.argv.slice(2);
const tagIdx = args.indexOf("--tag");
const tag = tagIdx >= 0 ? args[tagIdx + 1] : null;

// ---------------------------------------------------------------- версии
const pkg = JSON.parse(read("package.json"));
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargo = read("src-tauri/Cargo.toml");
const cargoVersion = (cargo.match(/\[package\][^[]*?\nversion\s*=\s*"([^"]+)"/) || [])[1];
const versions = { "package.json": pkg.version, "tauri.conf.json": conf.version, "Cargo.toml": cargoVersion };
check(new Set(Object.values(versions)).size === 1, `версия ${pkg.version} одинакова в package.json, tauri.conf.json, Cargo.toml`, `версии расходятся: ${JSON.stringify(versions)}`);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/;
check(SEMVER.test(pkg.version), `версия ${pkg.version} вида X.Y.Z`, `версия ${pkg.version} не вида X.Y.Z (предварительных версий нет)`);

if (tag) {
  const m = /^v(.+)$/.exec(tag);
  const v = m ? m[1] : "";
  check(SEMVER.test(v), `тег ${tag} вида vX.Y.Z`, `тег ${tag}: нужен vX.Y.Z без суффикса (Beta и Preview не выпускаются)`);
  check(v === pkg.version, `тег ${tag} совпадает с версией в файлах`, `тег ${tag} не совпадает с версией ${pkg.version} (сначала node scripts/set-version.cjs ${v})`);
}

// ---------------------------------------------------------------- идентичность приложения
// Значения записаны у пользователей: их изменение потеряло бы данные, ключи или обновления.
const identityRs = read("src-tauri/src/identity.rs");
const block = identityRs.split("pub const APP: Identity = Identity {")[1]?.split("};")[0] ?? "";
const field = (f) => (block.match(new RegExp(`${f}:\\s*b?"([^"]*)"`)) || [])[1];
const A = { identifier: field("identifier"), product: field("product_name"), scheme: field("url_scheme"), binary: field("binary") };
check(A.identifier === "local.leadgenerator.app" && conf.identifier === A.identifier, "идентификатор local.leadgenerator.app (как у установленных версий)", `идентификатор изменён (${conf.identifier} / ${A.identifier})`);
check(conf.productName === "Customers" && A.product === "Customers", "имя Customers", `имя изменено (${conf.productName} / ${A.product})`);
const schemes = (conf.plugins?.["deep-link"]?.desktop?.schemes ?? []);
check(JSON.stringify(schemes) === JSON.stringify(["leadgenerator"]) && A.scheme === "leadgenerator", "ссылки leadgenerator://", `схема ссылок изменена (${schemes} / ${A.scheme})`);
check(A.binary === "customers" && (conf.mainBinaryName === undefined || conf.mainBinaryName === A.binary), "исполняемый файл customers", `исполняемый файл изменён (${conf.mainBinaryName} / ${A.binary})`);
const otherConfs = fs.readdirSync(path.join(root, "src-tauri")).filter((f) => /^tauri\..+\.conf\.json$/.test(f));
check(otherConfs.length === 0, "одна конфигурация Tauri (без конфигураций других каналов)", `лишние конфигурации Tauri: ${otherConfs.join(", ")}`);

// ---------------------------------------------------------------- без отладочных возможностей
check(!/^\[features\]/m.test(cargo) || !/^beta\s*=/m.test(cargo.split("[features]")[1] ?? ""), "Cargo: признака beta нет", "Cargo: объявлен признак beta — Beta-сборки удалены (ADR-034)");
const tauriDep = (cargo.match(/^tauri\s*=\s*\{[^}]*\}/m) || [""])[0];
check(!/devtools/.test(tauriDep), "инструменты разработчика WebView не включены", "tauri собран с devtools — их не должно быть в релизе");
const lib = read("src-tauri/src/lib.rs");
check(!fs.existsSync(path.join(root, "src-tauri/src/debug")) && !/pub mod debug;/.test(lib), "отладочного модуля debug нет", "src-tauri/src/debug или pub mod debug вернулись");
check(!fs.existsSync(path.join(root, "src/debug")), "Debug Menu в интерфейсе нет", "desktop/src/debug вернулся");
const handlerSection = (lib.split("generate_handler![")[1] ?? "").split("]")[0];
const commands = [...handlerSection.matchAll(/(\w+),/g)].map((m) => m[1]);
check(commands.length > 50 && commands.every((c) => !c.startsWith("debug_")), `${commands.length} команд, среди них нет debug_*`, "среди команд есть debug_* или обработчик не найден");
check((lib.match(/generate_handler!\[/g) ?? []).length === 1, "один обработчик команд", "обработчиков команд больше одного");

// ---------------------------------------------------------------- установщик Windows
const iss = read("installer/Customers.iss");
const guids = [...iss.matchAll(/#define AppGuid "\{\{([0-9A-F-]+)\}"/g)].map((m) => m[1]);
check(guids.length === 1 && guids[0] === "6B0F7C1E-3A52-4C58-9E41-5B7D2A9C1F30", "Inno: AppId прежний", `Inno: AppId изменён или их несколько (${guids})`);
check(/#define UrlScheme "leadgenerator"/.test(iss) && !/#ifdef Beta/.test(iss), "Inno: ссылки leadgenerator:, без варианта Beta", "Inno: схема ссылок изменена или остался вариант Beta");
check(/#define AppExe "Customers\.exe"/.test(iss), "Inno: ставится как Customers.exe", "Inno: имя exe изменено");

// ---------------------------------------------------------------- облако
const cloudCfg = read("src-tauri/src/cloud/config.rs");
check(!/SUPABASE_BETA_/.test(cloudCfg), "облако одно (SUPABASE_URL / SUPABASE_ANON_KEY)", "в cloud/config.rs остались SUPABASE_BETA_*");

// ---------------------------------------------------------------- секреты в клиенте
// В приложение попадает только публичный ключ. Серверный ключ Supabase, секретный ключ или его переменная в коде
// клиента — ошибка (исключение: проверка в cloud/config.rs, которая такие ключи отклоняет). Имя роли собирается
// из частей: этот файл сам проверяется тестом стенда (supabase/tests/test_sync_rls.py), где имени быть не должно.
const ROLE = ["service", "role"].join("_");
const roleName = new RegExp(`${ROLE.toUpperCase()}|${ROLE}_key`);
const roleJwt = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*cm9sZSI6InNlcnZpY2Vfcm9sZS/;
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(rs|ts|tsx|js|cjs|json)$/.test(e.name)) out.push(p);
  }
  return out;
};
const leaks = [];
for (const dir of ["src", "src-tauri/src"]) {
  if (!fs.existsSync(path.join(root, dir))) continue;
  for (const f of walk(path.join(root, dir))) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    const text = fs.readFileSync(f, "utf8");
    if (roleName.test(text) || roleJwt.test(text)) leaks.push(rel);
    if (/sb_secret_[A-Za-z0-9]{8,}/.test(text)) leaks.push(rel);
    if (/sb_secret_/.test(text) && rel !== "src-tauri/src/cloud/config.rs") leaks.push(rel);
  }
}
check(leaks.length === 0, "в коде клиента нет серверного и секретных ключей Supabase", `серверный или секретный ключ Supabase в клиенте: ${[...new Set(leaks)].join(", ")}`);

for (const t of ok) console.log(`  ✓ ${t}`);
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(`\nПроверка не пройдена: ${problems.length} проблем.`);
  process.exit(1);
}
console.log(`\nПроверка пройдена: ${ok.length} пунктов.`);
