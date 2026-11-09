// Язык интерфейса. Тексты в коде написаны по-русски; английский берётся из словаря `i18n.en.ts` по русской строке.
// Перевод делается на лету: `translate` для строки и `startDomTranslation` для всего окна (текст, подсказки, поля).
// Так новый русский текст без перевода просто остаётся русским, а не ломает экран.

import { EN, INLINE, PATTERNS } from "./i18n.en";

export type Language = "ru" | "en";
export type LanguageChoice = "system" | Language;

let current: Language = "ru";
const listeners = new Set<() => void>();

export const getLanguage = (): Language => current;
export const subscribeLanguage = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** Язык по выбору пользователя; «как в системе» — по языку системы: русский для русской, иначе английский. */
export function resolveLanguage(choice: string | null | undefined, systemLanguage: string | null | undefined): Language {
  if (choice === "ru" || choice === "en") return choice;
  return (systemLanguage ?? "").toLowerCase().startsWith("ru") ? "ru" : "en";
}

export const systemLanguage = (): string => (typeof navigator === "undefined" ? "ru" : navigator.language || "ru");

// ------------------------------------------------------------------ словарь

interface Rule { re: RegExp; out: string }
let rules: Rule[] | null = null;

/** Шаблоны вида «Выбрано: ${n}» превращаются в регулярные выражения: каждое ${…} — любой текст. */
function compiledRules(): Rule[] {
  if (rules) return rules;
  const escape = (s: string) => s.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
  const out: Rule[] = [];
  for (const [ru, en] of Object.entries(EN)) {
    if (!ru.includes("${")) continue;
    const parts = ru.split(/\$\{[^}]*\}/);
    out.push({ re: new RegExp(`^${parts.map(escape).join("(.+?)")}$`, "s"), out: en });
  }
  // Чем длиннее неизменяемая часть шаблона, тем он точнее: «Каждые ${n} ч» раньше, чем «${n} ч».
  const literal = (r: Rule) => r.re.source.replace(/\(\.\+\?\)/g, "").length;
  out.sort((a, b) => literal(b) - literal(a));
  for (const [re, en] of PATTERNS) out.push({ re, out: en });
  rules = out;
  return out;
}

const hasCyrillic = (s: string) => /[А-Яа-яЁё]/.test(s);

/** Английский текст для русской строки или null, если перевода нет. Пробелы по краям сохраняются. */
export function translate(ru: string): string | null {
  if (!hasCyrillic(ru)) return null;
  const core = ru.trim();
  if (!core) return null;
  const lead = ru.slice(0, ru.indexOf(core));
  const tail = ru.slice(ru.indexOf(core) + core.length);
  const en = translateCore(core);
  return en === null ? null : lead + en + tail;
}

function translateCore(core: string, depth = 0): string | null {
  const exact = EN[core];
  if (exact !== undefined && !core.includes("${")) return exact;
  if (depth > 2) return null;
  for (const r of compiledRules()) {
    const m = r.re.exec(core);
    if (!m) continue;
    // Вставки тоже могут быть русскими словами («лидов», «мин»): их переводим отдельно.
    return r.out.replace(/\$(\d)/g, (_, i: string) => {
      const part = m[Number(i)] ?? "";
      return translateCore(part.trim(), depth + 1) ?? part;
    });
  }
  // Смешанные строки: переводим известные куски, если после этого русского не осталось.
  let mixed = core;
  for (const [re, en] of INLINE) mixed = mixed.replace(re, en);
  return mixed !== core && !hasCyrillic(mixed) ? mixed : null;
}

/** Для кода: русская строка → строка на текущем языке. */
export function t(ru: string): string {
  return current === "en" ? translate(ru) ?? ru : ru;
}

// ------------------------------------------------------------------ перевод страницы

const ATTRS = ["aria-label", "placeholder", "title", "data-tip", "alt"] as const;
/** Исходные (русские) значения, чтобы вернуть русский язык и не переводить дважды. */
const textOriginal = new WeakMap<Text, { ru: string; shown: string }>();
const attrOriginal = new WeakMap<Element, Map<string, { ru: string; shown: string }>>();
let observer: MutationObserver | null = null;

function translateText(node: Text) {
  const known = textOriginal.get(node);
  if (known && node.data === known.shown) return; // это уже наш перевод
  const ru = node.data;
  const en = translate(ru);
  if (en === null || en === ru) { textOriginal.delete(node); return; }
  textOriginal.set(node, { ru, shown: en });
  node.data = en;
}

function translateAttrs(el: Element) {
  for (const name of ATTRS) {
    const value = el.getAttribute(name);
    if (value === null) continue;
    const known = attrOriginal.get(el)?.get(name);
    if (known && value === known.shown) continue;
    const en = translate(value);
    if (en === null || en === value) { attrOriginal.get(el)?.delete(name); continue; }
    if (!attrOriginal.has(el)) attrOriginal.set(el, new Map());
    attrOriginal.get(el)?.set(name, { ru: value, shown: en });
    el.setAttribute(name, en);
  }
}

function walk(root: Node, visit: (n: Node) => void) {
  visit(root);
  if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE || root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let n = w.nextNode();
    while (n) { visit(n); n = w.nextNode(); }
  }
}

const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT"]);

function visitForward(n: Node) {
  if (n.nodeType === Node.TEXT_NODE) {
    const p = n.parentElement;
    if (p && !SKIP.has(p.tagName) && !p.closest("[data-no-translate]")) translateText(n as Text);
  } else if (n.nodeType === Node.ELEMENT_NODE) {
    const el = n as Element;
    if (!el.closest("[data-no-translate]")) translateAttrs(el);
  }
}

function visitBack(n: Node) {
  if (n.nodeType === Node.TEXT_NODE) {
    const k = textOriginal.get(n as Text);
    if (k && (n as Text).data === k.shown) (n as Text).data = k.ru;
    textOriginal.delete(n as Text);
  } else if (n.nodeType === Node.ELEMENT_NODE) {
    const el = n as Element;
    const m = attrOriginal.get(el);
    if (m) {
      for (const [name, k] of m) if (el.getAttribute(name) === k.shown) el.setAttribute(name, k.ru);
      attrOriginal.delete(el);
    }
  }
}

function startDomTranslation() {
  if (observer || typeof document === "undefined") return;
  walk(document.body, visitForward);
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") visitForward(r.target);
      else if (r.type === "attributes") visitForward(r.target);
      else r.addedNodes.forEach((n) => walk(n, visitForward));
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
}

function stopDomTranslation() {
  if (!observer || typeof document === "undefined") return;
  observer.disconnect();
  observer = null;
  walk(document.body, visitBack);
}

/** Переключает язык: страница переводится или возвращается к русскому, подписчики перерисовываются. */
export function setLanguage(lang: Language) {
  if (lang === current && (lang === "ru") === (observer === null)) return;
  current = lang;
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  if (lang === "en") startDomTranslation();
  else stopDomTranslation();
  listeners.forEach((f) => f());
}
