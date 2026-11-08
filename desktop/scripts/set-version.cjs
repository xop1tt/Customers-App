// Подставляет версию релиза во все места, где она хранится: package.json, tauri.conf.json и Cargo.toml.
// Использование: node scripts/set-version.cjs 1.2.3
const fs = require("node:fs");
const path = require("node:path");

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(version ?? "")) {
  console.error("Нужна версия вида 1.2.3, получено:", version);
  process.exit(1);
}
const root = path.resolve(__dirname, "..");
const edit = (file, f) => {
  const p = path.join(root, file);
  fs.writeFileSync(p, f(fs.readFileSync(p, "utf8")));
};
edit("package.json", (t) => t.replace(/("version":\s*")[^"]+/, `$1${version}`));
edit("src-tauri/tauri.conf.json", (t) => t.replace(/("version":\s*")[^"]+/, `$1${version}`));
// Только строка version внутри [package].
edit("src-tauri/Cargo.toml", (t) => t.replace(/(\[package\][^[]*?\nversion\s*=\s*")[^"]+/, `$1${version}`));
console.log("Версия:", version);
