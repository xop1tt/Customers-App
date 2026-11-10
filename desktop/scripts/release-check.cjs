// Проверка готовности сборки канала: версии, разделение Stable и Beta, отсутствие отладочных возможностей в Stable.
// Все проверки читают реальные файлы проекта; при любой ошибке код выхода 1 и список проблем.
//
//   node scripts/release-check.cjs                     — общие проверки (каждый PR)
//   node scripts/release-check.cjs --tag v1.3.0        — плюс тег Stable (сравнивается с версией в файлах)
//   node scripts/release-check.cjs --tag v1.3.0-beta.1 — плюс тег Beta
//
// Описание: docs/RELEASE_PROCESS.md, docs/DEBUG_BUILD.md.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8").replace(/^﻿/, "");
const problems = [];
const ok = [];
const check = (cond, okText, badText) => (cond ? ok.push(okText) : problems.push(badText));

const args = process.argv.slice(2);
const tagIdx = args.indexOf("--tag");
const tag = tagIdx >= 0 ? args[tagIdx + 1] : null;

// ---------------------------------------------------------------- версии
const pkg = JSON.parse(read("package.json"));
const stable = JSON.parse(read("src-tauri/tauri.conf.json"));
const beta = JSON.parse(read("src-tauri/tauri.beta.conf.json"));
const cargo = read("src-tauri/Cargo.toml");
const cargoVersion = (cargo.match(/\[package\][^[]*?\nversion\s*=\s*"([^"]+)"/) || [])[1];
const versions = { "package.json": pkg.version, "tauri.conf.json": stable.version, "Cargo.toml": cargoVersion };
check(new Set(Object.values(versions)).size === 1, `версия ${pkg.version} одинакова в package.json, tauri.conf.json, Cargo.toml`, `версии расходятся: ${JSON.stringify(versions)}`);
check(beta.version === undefined, "tauri.beta.conf.json не задаёт свою версию (берётся общая)", "tauri.beta.conf.json задаёт version: версия должна быть одна");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+)|-beta\.(\d+))?$/;
check(SEMVER.test(pkg.version), `версия ${pkg.version} допустимого вида`, `версия ${pkg.version} не вида X.Y.Z или X.Y.Z-beta.N`);

if (tag) {
  const m = /^v(.+)$/.exec(tag);
  const v = m ? m[1] : "";
  const isBeta = /-beta\.\d+$/.test(v);
  check(SEMVER.test(v), `тег ${tag} допустимого вида`, `тег ${tag}: нужен vX.Y.Z (Stable) или vX.Y.Z-beta.N (Beta)`);
  check(v === pkg.version, `тег ${tag} совпадает с версией в файлах`, `тег ${tag} не совпадает с версией ${pkg.version} (сначала node scripts/set-version.cjs ${v})`);
  if (!isBeta) check(!/-/.test(v), "Stable-тег без суффикса предварительной версии", `Stable-тег ${tag} содержит суффикс`);
}

// ---------------------------------------------------------------- идентичность каналов
// Значения Stable записаны у пользователей: их изменение потеряло бы данные, ключи или обновления.
const channelRs = read("src-tauri/src/channel.rs");
const ident = (name) => {
  const block = channelRs.split(`const ${name}: Identity = Identity {`)[1]?.split("};")[0] ?? "";
  const field = (f) => (block.match(new RegExp(`${f}:\\s*b?"([^"]*)"`)) || [])[1];
  return { identifier: field("identifier"), product: field("product_name"), scheme: field("url_scheme"), binary: field("binary") };
};
const S = ident("STABLE");
const B = ident("BETA");
check(S.identifier === "local.leadgenerator.app" && stable.identifier === S.identifier, "Stable: идентификатор local.leadgenerator.app (как у установленных версий)", `Stable: идентификатор изменён (${stable.identifier} / ${S.identifier})`);
check(stable.productName === "Customers" && S.product === "Customers", "Stable: имя Customers", `Stable: имя изменено (${stable.productName})`);
const schemes = (c) => c.plugins?.["deep-link"]?.desktop?.schemes ?? [];
check(JSON.stringify(schemes(stable)) === JSON.stringify(["leadgenerator"]) && S.scheme === "leadgenerator", "Stable: ссылки leadgenerator://", `Stable: схема ссылок изменена (${schemes(stable)})`);
check(stable.mainBinaryName === undefined || stable.mainBinaryName === S.binary, "Stable: исполняемый файл customers", `Stable: mainBinaryName = ${stable.mainBinaryName}`);

check(beta.identifier === B.identifier && B.identifier !== S.identifier, `Beta: свой идентификатор ${beta.identifier}`, `Beta: идентификатор ${beta.identifier} не совпадает с channel.rs (${B.identifier}) или равен Stable`);
check(beta.productName === B.product && B.product !== S.product, `Beta: своё имя «${beta.productName}»`, `Beta: имя ${beta.productName} не совпадает с channel.rs (${B.product})`);
check(beta.mainBinaryName === B.binary && B.binary !== S.binary, `Beta: исполняемый файл ${beta.mainBinaryName}`, `Beta: mainBinaryName ${beta.mainBinaryName} не совпадает с channel.rs (${B.binary})`);
check(JSON.stringify(schemes(beta)) === JSON.stringify([B.scheme]) && B.scheme !== S.scheme, `Beta: свои ссылки ${B.scheme}://`, `Beta: схема ссылок ${schemes(beta)} не совпадает с channel.rs (${B.scheme})`);
const betaWin = (beta.app?.windows ?? [])[0] ?? {};
const stableWin = (stable.app?.windows ?? [])[0] ?? {};
check(betaWin.label === stableWin.label && betaWin.title === B.product, "Beta: окно main с заголовком Beta", `Beta: окно ${JSON.stringify(betaWin)} не соответствует`);
const sameWindow = Object.keys(stableWin).every((k) => k === "title" || JSON.stringify(stableWin[k]) === JSON.stringify(betaWin[k]));
check(sameWindow, "Beta: параметры окна совпадают со Stable (кроме заголовка)", "Beta: параметры окна отличаются от Stable — обновите tauri.beta.conf.json");

// ---------------------------------------------------------------- Stable без отладочных возможностей
const features = cargo.split("[features]")[1]?.split("\n[")[0] ?? "";
// Признак beta включает только необязательные зависимости Debug Menu (`dep:…`), а они не попадают в Stable.
const betaLine = features.match(/^beta\s*=\s*\[([^\]]*)\]/m);
const betaItems = betaLine ? [...betaLine[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
check(betaItems !== null && betaItems.every((i) => i.startsWith("dep:")), "Cargo: признак beta включает только зависимости Debug Menu", `Cargo: признак beta не объявлен или включает другие признаки (${betaItems})`);
const depsSection = cargo.split("[dependencies]")[1]?.split("\n[")[0] ?? "";
const notOptional = (betaItems ?? []).map((i) => i.slice(4)).filter((name) => {
  const line = (depsSection.match(new RegExp(`^${name}\\s*=.*$`, "m")) || [""])[0];
  return !/optional\s*=\s*true/.test(line);
});
check(notOptional.length === 0, "Cargo: зависимости Debug Menu необязательные (в Stable их нет)", `Cargo: зависимости Debug Menu попадут в Stable: ${notOptional.join(", ")}`);
check(!/^default\s*=.*beta/m.test(features), "Cargo: beta не входит в default (обычная сборка — Stable)", "Cargo: beta включён по умолчанию — Stable собралась бы как Beta");
const tauriDep = (cargo.match(/^tauri\s*=\s*\{[^}]*\}/m) || [""])[0];
check(!/devtools/.test(tauriDep), "Stable: инструменты разработчика WebView не включены", "tauri собран с devtools — их не должно быть в Stable");
// Отладочный код (Debug Menu, сценарии, тестовые данные) живёт только под cfg(feature = "beta").
const debugDir = path.join(root, "src-tauri/src/debug");
const lib = read("src-tauri/src/lib.rs");
const debugMods = lib.match(/^[ \t]*pub mod debug;/gm) ?? [];
if (fs.existsSync(debugDir) || debugMods.length) {
  const guarded = lib.match(/#\[cfg\(feature = "beta"\)\]\s*pub mod debug;/g) ?? [];
  check(debugMods.length === 1 && guarded.length === 1, "Debug-модуль подключается только в Beta", "src/debug подключён без #[cfg(feature = \"beta\")]");
  // Команды Debug Menu: все с префиксом debug_ (по нему вызов уходит в обработчик Beta), все зарегистрированы
  // в debug_handler, а среди команд Stable таких нет.
  const cmdFile = path.join(debugDir, "commands.rs");
  const declared = fs.existsSync(cmdFile) ? [...fs.readFileSync(cmdFile, "utf8").matchAll(/#\[tauri::command\]\s*pub (?:async )?fn (\w+)/g)].map((m) => m[1]) : [];
  const section = (name) => (lib.split(`fn ${name}(`)[1] ?? "").split("generate_handler![")[1]?.split("]")[0] ?? "";
  const listed = (name) => [...section(name).matchAll(/(\w+),/g)].map((m) => m[1]);
  const debugListed = listed("debug_handler");
  const appListed = listed("app_handler");
  check(
    declared.every((c) => c.startsWith("debug_") && debugListed.includes(c)) && debugListed.every((c) => declared.includes(c)),
    `Debug Menu: ${declared.length} команд, все debug_* и зарегистрированы только в Beta`,
    `Debug Menu: команды ${declared.join(", ")} не совпадают с debug_handler (${debugListed.join(", ")}) или без префикса debug_`,
  );
  check(appListed.length > 50 && appListed.every((c) => !c.startsWith("debug_")), "Stable: среди команд нет debug_*", "Stable: команда debug_* в обычном обработчике");
}

// ---------------------------------------------------------------- установщик Windows
const iss = read("installer/Customers.iss");
const guids = [...iss.matchAll(/#define AppGuid "\{\{([0-9A-F-]+)\}"/g)].map((m) => m[1]);
check(guids.length === 2 && guids[1] === "6B0F7C1E-3A52-4C58-9E41-5B7D2A9C1F30", "Inno: AppId Stable прежний", `Inno: AppId Stable изменён или не найден (${guids})`);
check(guids.length === 2 && guids[0] !== guids[1], "Inno: у Beta свой AppId", "Inno: AppId Beta совпадает со Stable");
check(/#define UrlScheme "customers-beta"/.test(iss) && /#define UrlScheme "leadgenerator"/.test(iss), "Inno: схемы ссылок каналов разные", "Inno: схемы ссылок не соответствуют каналам");
check(/#define AppExe "Customers Beta\.exe"/.test(iss), "Inno: Beta ставится как «Customers Beta.exe»", "Inno: имя exe Beta не задано");

// ---------------------------------------------------------------- облако
const cloudCfg = read("src-tauri/src/cloud/config.rs");
check(/SUPABASE_BETA_URL/.test(cloudCfg) && /SUPABASE_BETA_ANON_KEY/.test(cloudCfg), "Beta: своё облако (SUPABASE_BETA_*), рабочий проект не встраивается", "Beta: облако не отделено от Stable");

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
