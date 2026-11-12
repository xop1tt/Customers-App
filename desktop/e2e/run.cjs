// Запуск приёмочных проверок настоящего приложения (описание: docs/E2E.md).
//
//   node e2e/run.cjs --bin <путь к собранному приложению> [--phase main|relaunch|all] [--dir <папка>] [--live] [--timeout 420]
//
// Приложение собирается с признаком e2e (npx tauri build --features e2e). Скрипт готовит чистую папку данных,
// поднимает локальный тестовый сервер (mock-server.cjs), запускает приложение, ждёт отчёт сценариев и сверяет файлы,
// которые приложение записало на диск, и запросы, которые пришли на тестовый сервер, с эталонами из e2e/golden.
// Код выхода 0 — всё пройдено; 1 — есть непройденные проверки; 2 — приложение не запустилось или не завершило сценарии.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const mock = require("./mock-server.cjs");
const verify = require("./verify.cjs");

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);

const platform = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform];
const root = __dirname;
const bin = path.resolve(opt("bin", ""));
const dir = path.resolve(opt("dir", path.join(os.tmpdir(), `customers-e2e-${process.pid}`)));
const phases = opt("phase", "all") === "all" ? ["main", "relaunch"] : [opt("phase", "main")];
const timeoutSec = Number(opt("timeout", "420"));
const live = flag("live");

if (!opt("bin") || !fs.existsSync(bin)) { console.error(`Не найдено приложение: ${bin}. Укажите --bin.`); process.exit(2); }

const read = (f) => fs.readFileSync(path.join(root, f), "utf8").replace(/^﻿/, "");
function buildScript() {
  const files = fs.readdirSync(path.join(root, "scenarios")).filter((f) => f.endsWith(".js")).sort();
  return [read("lib.js"), ...files.map((f) => `\n// ---- scenarios/${f}\n${read(`scenarios/${f}`)}`)].join("\n");
}
function goldens() {
  const out = {};
  for (const f of fs.readdirSync(path.join(root, "golden"))) if (f.endsWith(".json")) out[f.replace(/\.json$/, "")] = JSON.parse(read(`golden/${f}`));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summary = [];
const out = (line = "") => { console.log(line); summary.push(line); };

async function launch({ phase, server }) {
  const report = path.join(dir, `report-${phase}.json`);
  const logFile = path.join(dir, `report-${phase}.log`);
  fs.rmSync(report, { force: true });
  fs.rmSync(logFile, { force: true });
  fs.writeFileSync(path.join(dir, "driver.js"), buildScript());
  const config = { phase, platform, dir, live, golden: goldens(), mock: server.base, hosts: server.hosts, ignoreErrors: [] };
  const env = {
    ...process.env,
    CUSTOMERS_E2E_DIR: dir,
    CUSTOMERS_E2E_SCRIPT: path.join(dir, "driver.js"),
    CUSTOMERS_E2E_CONFIG: JSON.stringify(config),
    CUSTOMERS_E2E_OUT: report,
    CUSTOMERS_E2E_REWRITE: server.rewrite,
    CUSTOMERS_E2E_CONTROL: server.control,
    CUSTOMERS_E2E_TIMEOUT: String(timeoutSec),
    WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
  };
  const cmd = platform === "linux" && !process.env.DISPLAY ? "xvfb-run" : bin;
  const argv = platform === "linux" && !process.env.DISPLAY ? ["-a", "-s", "-screen 0 1440x900x24", bin] : [];
  out(`▶ запуск (${phase}): ${bin}`);
  const child = spawn(cmd, argv, { env, stdio: "ignore", detached: platform !== "win32" });
  let exitCode = null;
  child.on("exit", (c) => { exitCode = c ?? -1; });
  child.on("error", (e) => { out(`✗ не удалось запустить: ${e.message}`); exitCode = -2; });

  let printed = 0;
  const flush = () => {
    if (!fs.existsSync(logFile)) return;
    const lines = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    for (; printed < lines.length; printed++) console.log(`   ${lines[printed]}`);
  };
  const end = Date.now() + (timeoutSec + 30) * 1000;
  while (exitCode === null && Date.now() < end) { await sleep(1000); flush(); }
  flush();
  if (exitCode === null) {
    out("✗ приложение не завершилось вовремя, снимаю экран и закрываю");
    try { screenshot(path.join(dir, "shots", `timeout-${phase}.png`)); } catch { /* не критично */ }
    try { process.kill(platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* уже закрыто */ }
    exitCode = -3;
  }
  const data = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, "utf8")) : null;
  return { exitCode, data };
}

function screenshot(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (platform === "macos") spawnSync("screencapture", ["-x", file]);
  else if (platform === "windows") {
    const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${file}')`;
    spawnSync("powershell", ["-NoProfile", "-Command", ps]);
  }
}

function show(data) {
  out(`   сценариев: ${data.total}, пройдено: ${data.passed}, не пройдено: ${data.failed}, пропущено: ${data.skipped}, ${(data.durationMs / 1000).toFixed(1)} с`);
  for (const s of data.scenarios) {
    const mark = s.status === "passed" ? "✓" : s.status === "skipped" ? "○" : "✗";
    out(`   ${mark} ${s.id} — ${s.title} (${s.ms} мс)${s.status === "failed" ? `\n       ${s.error}\n       экран: ${s.screen}` : s.note ? ` — ${s.note}` : ""}`);
  }
  if (data.pageErrors && data.pageErrors.length) out(`   ошибки страницы (${data.pageErrors.length}): ${data.pageErrors.slice(0, 5).join(" | ")}`);
}

(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.mkdirSync(path.join(dir, "out"), { recursive: true }); // сюда сценарии пишут файлы выгрузки и копий
  // Язык интерфейса задан заранее: сценарии ищут русские подписи (английский проверяется отдельным сценарием).
  fs.writeFileSync(path.join(dir, "data", "device.json"), JSON.stringify({ language: "ru" }));
  const server = await mock.start({ live });
  out(`Приёмочные проверки приложения · ${platform} · ${new Date().toISOString()}`);
  out(`Папка данных: ${dir}; тестовый сервер: ${server.base}`);
  let failed = false;
  let broken = false;
  for (const phase of phases) {
    const { exitCode, data } = await launch({ phase, server });
    if (!data) { out(`✗ ${phase}: отчёта нет (код выхода ${exitCode}); смотрите журнал выше`); broken = true; break; }
    show(data);
    if (data.failed > 0) failed = true;
    if (exitCode !== 0 && exitCode !== 1) { out(`✗ ${phase}: неожиданный код выхода ${exitCode}`); broken = true; }
    if (phase === "main") {
      const problems = verify.afterMain({ dir, server, goldenDir: path.join(root, "golden"), update: flag("update-golden"), live });
      out(problems.length ? `✗ сверка файлов и запросов с эталоном: ${problems.length} расхождений` : "✓ файлы и запросы совпали с эталоном");
      for (const p of problems) out(`     - ${p}`);
      if (problems.length) failed = true;
    }
  }
  await server.close();
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + summary.join("\n") + "\n```\n");
  fs.writeFileSync(path.join(dir, "summary.txt"), summary.join("\n"));
  process.exit(broken ? 2 : failed ? 1 : 0);
})();
