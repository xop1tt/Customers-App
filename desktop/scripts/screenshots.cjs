// Снимки экрана демо-версии интерфейса (вне Tauri) для проверки вёрстки на разных размерах окна и масштабах.
// Запуск: npm run build && npm run shots [-- папка]. Требуется Playwright (в окружении разработки он уже есть).

const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const out = path.resolve(process.argv[2] ?? "shots");
fs.mkdirSync(out, { recursive: true });

const SIZES = [
  { name: "1080p", w: 1920, h: 1080, scale: 1 },
  { name: "1440p", w: 2560, h: 1440, scale: 1 },
  { name: "4k", w: 3840, h: 2160, scale: 1 },
  { name: "4k-200", w: 1920, h: 1080, scale: 2 }, // 4K при масштабе Windows 200%
  { name: "laptop", w: 1280, h: 720, scale: 1 },
  { name: "small", w: 960, h: 600, scale: 1 },
  { name: "tiny", w: 760, h: 520, scale: 1 }, // боковая панель выезжает поверх, сведения о лиде плавают
];

async function main() {
  const server = spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 2500));
  const browser = await chromium.launch();
  try {
    for (const size of SIZES) {
      const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: size.scale });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, `${size.name}-${name}.png`) }); };
      const nav = async (selector) => {
        if (!(await page.locator(".sidebar").first().isVisible().catch(() => false))) await page.click(".topbar .icon-btn >> nth=0");
        await page.click(`.sidebar ${selector}`);
      };
      const open = async (query = "") => { await page.goto(`http://localhost:4173/${query}`); await page.waitForSelector(".shell, .auth, .welcome", { timeout: 8000 }); };

      await open();
      await shot("home");
      await nav(">> text=Все лиды");
      await page.waitForSelector(".tr");
      await shot("leads");
      await page.click(".tr >> nth=0", { position: { x: 80, y: 10 } });
      await shot("lead-selected");
      await page.click(".inspector >> text=Написать");
      await shot("lead-write");
      await nav(">> text=Журнал поиска");
      await shot("runs");
      await nav(".nav-item:has-text('Источники') >> nth=-1");
      await shot("sources");
      await page.click(".src-row >> nth=3");
      await shot("sources-osm");
      for (const [title, key] of [["Оформление", "appearance"], ["Аккаунт", "account"], ["Данные", "data"], ["Рассылка", "outreach"], ["Обновления", "updates"]]) {
        await nav(">> text=Настройки");
        await page.click(`.settings-nav >> text=${title}`);
        await shot(`settings-${key}`);
        await page.keyboard.press("Escape");
      }
      await nav(">> text=Все лиды");
      await page.click(".tr >> nth=0", { position: { x: 80, y: 10 } });
      await page.click(".tr >> nth=2", { modifiers: ["Shift"], position: { x: 80, y: 10 } });
      await page.click(".bulkbar >> text=Экспорт");
      await shot("export");
      await page.keyboard.press("Escape");

      await open("?auth");
      await shot("auth");
      await open("?welcome");
      await shot("welcome");
      if (errors.length) console.log(`${size.name}: ошибки консоли\n  ${errors.join("\n  ")}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(`Снимки сохранены в ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
