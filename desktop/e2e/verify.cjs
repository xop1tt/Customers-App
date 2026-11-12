// Сверка с эталоном того, что приложение записало на диск и отправило в сеть (после основного прогона).
// Эталоны лежат в e2e/golden. Обновить их после осознанного изменения формата: node e2e/run.cjs … --update-golden.
const fs = require("node:fs");
const path = require("node:path");

const normText = (s) => s.replace(/^﻿/, "").replace(/\r\n/g, "\n").trimEnd();

// Файлы, которые сценарии записывают в <папка>/out, и их эталоны (расширение .txt: *.csv в репозиторий не добавляется).
const FILES = [
  ["companies.csv", "companies.golden.txt"],
  ["deals-en.csv", "deals-en.golden.txt"],
];

/** Excel-файл — это zip с листом и книгой. */
function checkXlsx(file) {
  if (!fs.existsSync(file)) return [`нет файла ${path.basename(file)}`];
  const raw = fs.readFileSync(file);
  const text = raw.toString("latin1");
  const problems = [];
  if (raw.subarray(0, 2).toString("latin1") !== "PK") problems.push(`${path.basename(file)}: это не zip-архив`);
  for (const part of ["xl/workbook.xml", "xl/worksheets/sheet1.xml"]) if (!text.includes(part)) problems.push(`${path.basename(file)}: в архиве нет ${part}`);
  return problems;
}

/** Что пришло на тестовый сервер: сверка с golden/received.json. */
function checkReceived(server, goldenDir) {
  const problems = [];
  const file = path.join(goldenDir, "received.json");
  if (!fs.existsSync(file)) return problems;
  const want = JSON.parse(fs.readFileSync(file, "utf8"));
  const r = server.received;
  const eq = (what, got, exp) => { if (JSON.stringify(got) !== JSON.stringify(exp)) problems.push(`${what}: ожидали ${JSON.stringify(exp)}, получили ${JSON.stringify(got)}`); };
  if (want.rssRequests) {
    eq("запросов к ленте RSS", r.rssRequests.length >= want.rssRequests.min, true);
    eq("повторный запрос ленты с ETag (ответ 304)", r.rssRequests.some((x) => x.ifNoneMatch), true);
    eq("User-Agent источника", r.rssRequests.every((x) => /^Customers\//.test(x.userAgent || "")), true);
  }
  if (want.webhook) {
    eq("запросов на вебхук", r.webhook.filter((x) => x.method === "POST").length, want.webhook.posts);
    eq("тип содержимого вебхука", r.webhook.every((x) => /application\/json/.test(x.contentType || "")), true);
    for (const key of want.webhook.jsonHas || []) eq(`в теле вебхука есть «${key}»`, r.webhook.some((x) => x.json && JSON.stringify(x.json).includes(key)), true);
  }
  if (want.dav) {
    eq("WebDAV: проверка подключения (PROPFIND)", r.dav.some((x) => x.method === "PROPFIND"), true);
    eq("WebDAV: загружен файл копии (PUT)", r.dav.filter((x) => x.method === "PUT" && x.size > 0).length >= want.dav.minPuts, true);
    eq("WebDAV: заголовок авторизации передан", r.dav.every((x) => x.authorization === "есть"), true);
  }
  if (want.b24) eq("Битрикс24: проверка вебхука", r.b24.length >= want.b24.min, true);
  if (want.github) eq("GitHub: запрос списка релизов", r.github.length >= want.github.min, true);
  eq("запросов на неизвестные адреса тестового сервера", r.other.map((x) => `${x.method} ${x.path}`), []);
  return problems;
}

/** Возвращает список расхождений; пустой список — всё совпало. */
function afterMain({ dir, server, goldenDir, update }) {
  const problems = [];
  for (const [name, goldenName] of FILES) {
    const file = path.join(dir, "out", name);
    const goldenFile = path.join(goldenDir, goldenName);
    if (!fs.existsSync(file)) { problems.push(`нет файла выгрузки ${name}`); continue; }
    const got = normText(fs.readFileSync(file, "utf8"));
    if (update) { fs.writeFileSync(goldenFile, got + "\n"); continue; }
    if (!fs.existsSync(goldenFile)) { problems.push(`нет эталона ${goldenName}`); continue; }
    const want = normText(fs.readFileSync(goldenFile, "utf8"));
    if (got !== want) problems.push(`${name} отличается от эталона ${goldenName}:\n--- ожидали\n${want}\n--- получили\n${got}`);
  }
  problems.push(...checkXlsx(path.join(dir, "out", "companies.xlsx")));
  problems.push(...checkReceived(server, goldenDir));
  return problems;
}

module.exports = { afterMain, normText };
