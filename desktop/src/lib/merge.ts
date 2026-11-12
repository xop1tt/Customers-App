// Объединение дубликатов (пакет G4, docs/MERGE.md): какие поля различаются у двух записей, что выбрать по
// умолчанию и какие значения отправить ядру (`ws_merge`). Связанные записи переносит ядро.

import type { CrmRecord } from "../api/types";
import type { EntityMeta, FieldMeta } from "./crm";

/** «Эта» — значение оставшейся записи, «вторая» — значение дубликата, «оба» — списки телефонов и почты вместе. */
export type MergeChoice = "keep" | "other" | "both";

export interface MergeField {
  field: FieldMeta;
  keep: unknown;
  other: unknown;
}

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);
const norm = (v: unknown) => String(v).toLowerCase().replace(/[\s()+\-.]/g, "");

/** Список без повторов (телефоны сравниваются по цифрам, почта — без учёта регистра); сначала значения оставшейся. */
export function union(a: unknown, b: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const k = norm(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(String(v));
  }
  return out.slice(0, 20);
}

const same = (f: FieldMeta, a: unknown, b: unknown) =>
  f.kind === "list" ? union(a, []).map(norm).sort().join("|") === union(b, []).map(norm).sort().join("|") : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Поля, по которым нужно решение: значения различаются и у дубликата значение есть. */
export function differences(e: EntityMeta, keep: CrmRecord, other: CrmRecord): MergeField[] {
  return e.fields.filter((f) => !isEmpty(other[f.name]) && !same(f, keep[f.name], other[f.name])).map((field) => ({ field, keep: keep[field.name], other: other[field.name] }));
}

/** По умолчанию: пустое поле берёт значение дубликата, списки объединяются, остальное остаётся как есть. */
export function defaultChoice(d: MergeField): MergeChoice {
  if (isEmpty(d.keep)) return "other";
  return d.field.kind === "list" ? "both" : "keep";
}

/** Значения для оставшейся записи по выбору пользователя (только то, что меняется). */
export function mergeValues(diffs: MergeField[], choices: Record<string, MergeChoice>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of diffs) {
    const c = choices[d.field.name] ?? defaultChoice(d);
    if (c === "other") out[d.field.name] = d.field.kind === "list" ? union(d.other, []) : d.other;
    else if (c === "both" && d.field.kind === "list") out[d.field.name] = union(d.keep, d.other);
  }
  return out;
}
