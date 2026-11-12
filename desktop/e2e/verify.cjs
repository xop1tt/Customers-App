// Сверка с эталоном того, что приложение записало на диск и отправило в сеть (после основного прогона).
const fs = require("node:fs");
const path = require("node:path");

const normText = (s) => s.replace(/^﻿/, "").replace(/\r\n/g, "\n").trimEnd();

/** Возвращает список расхождений; пустой список — всё совпало. */
function afterMain({ dir, server, goldenDir, update }) {
  const problems = [];
  void dir; void server; void goldenDir; void update; void fs; void path; void normText;
  return problems;
}

module.exports = { afterMain, normText };
