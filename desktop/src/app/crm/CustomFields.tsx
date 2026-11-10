// Свои поля: значения в карточке и редактор определений. Определения и значения — обычные записи CRM (синхронизируются).

import { useState } from "react";
import { api } from "../../api";
import type { CrmRecord, WsCard } from "../../api/types";
import type { EntityMeta } from "../../lib/crm";
import { Button, Checkbox, IconButton, NumberInput, Select, SettingRow, TextInput } from "../../ui/kit";
import { Dialog } from "../../ui/overlay";
import { attempt, refreshWorkspace, useStore } from "../../state/store";
import { useWsQuery } from "./useCrm";

export const FIELD_KINDS = [
  { value: "text", label: "Текст" },
  { value: "number", label: "Число" },
  { value: "date", label: "Дата" },
  { value: "select", label: "Список" },
  { value: "bool", label: "Да / нет" },
];
export const FIELD_TYPES = [
  { value: "company", label: "Компании" },
  { value: "contact", label: "Контакты" },
  { value: "crm_lead", label: "Лиды" },
  { value: "deal", label: "Сделки" },
];

const num = (v: unknown) => Number(v ?? 0);
const options = (f: CrmRecord): string[] => (Array.isArray(f.options) ? (f.options as unknown[]).map(String) : []);

function useDefinitions(type: string) {
  return useWsQuery(async () => (await api.wsList("custom_fields", { filters: [{ field: "entity_type", op: "eq", value: type }], sort: [{ field: "position", dir: "asc" }], limit: 200 })).items, [type]);
}

/** Раздел карточки со значениями своих полей; не показывается, если полей нет. */
export function CustomFieldsSection({ e, data, editable }: { e: EntityMeta; data: WsCard; editable: boolean }) {
  const { data: defs } = useDefinitions(e.type);
  if (!defs?.length || e.type === "task") return null;
  const values = new Map((data.custom_field_values ?? []).filter((v) => !v.deleted_at).map((v) => [String(v.field_id), v]));
  const set = async (f: CrmRecord, value: string | number | boolean | null) => {
    const cur = values.get(f.id);
    if (cur && cur.value === value) return;
    await attempt(() => cur
      ? api.wsSave("custom_field_values", cur.id, { value })
      : api.wsSave("custom_field_values", null, { field_id: f.id, entity_type: e.type, entity_id: data.record.id, value }));
  };
  return (
    <section className="insp-sec">
      <h4>Свои поля</h4>
      <dl className="kv">
        {defs.map((f) => {
          const v = values.get(f.id)?.value;
          return (
            <div key={f.id}>
              <dt>{String(f.label)}</dt>
              <dd><ValueInput def={f} value={v} disabled={!editable} onSave={(x) => void set(f, x)} /></dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function ValueInput({ def, value, disabled, onSave }: { def: CrmRecord; value: unknown; disabled: boolean; onSave: (v: string | number | boolean | null) => void }) {
  const [text, setText] = useState(value === null || value === undefined ? "" : String(value));
  const label = String(def.label);
  switch (def.kind) {
    case "bool": return <Checkbox checked={value === true} disabled={disabled} onChange={onSave} label={value === true ? "Да" : "Нет"} />;
    case "select": return <Select small value={String(value ?? "")} disabled={disabled} width={200} placeholder="Не выбрано" onChange={(x) => onSave(x || null)} options={[{ value: "", label: "Не выбрано" }, ...options(def).map((o) => ({ value: o, label: o }))]} />;
    case "number": return <NumberInput value={typeof value === "number" ? value : 0} min={-1e12} max={1e12} width={160} onChange={(n) => { if (!disabled) onSave(n); }} />;
    case "date": return <TextInput type="date" value={text} disabled={disabled} aria-label={label} onChange={setText} onBlur={() => onSave(text || null)} />;
    default: return <TextInput value={text} disabled={disabled} maxLength={2000} aria-label={label} onChange={setText} onBlur={() => onSave(text.trim() || null)} />;
  }
}

/** Редактор определений: тип записи, название, вид, варианты списка, порядок. */
export function CustomFieldsEditor({ onClose }: { onClose: () => void }) {
  const can = useStore((s) => s.ws?.permissions.includes("fields.manage") ?? false);
  const [type, setType] = useState("company");
  const { data: defs } = useDefinitions(type);
  const list = (defs ?? []).filter((d) => !d.deleted_at);
  const run = async (p: Promise<unknown>) => { await attempt(() => p); await refreshWorkspace(); };
  const move = async (i: number, d: -1 | 1) => {
    const a = list[i], b = list[i + d];
    if (a && b) await run(Promise.all([api.wsSave("custom_fields", a.id, { position: num(b.position) }), api.wsSave("custom_fields", b.id, { position: num(a.position) })]));
  };
  return (
    <Dialog title="Свои поля" onClose={onClose} width={640}>
      <SettingRow title="Для" hint={can ? "Поля появятся в карточке записи, значения синхронизируются." : "Менять поля может участник с правом «Пользовательские поля»."}>
        <Select value={type} onChange={setType} options={FIELD_TYPES} width={180} />
      </SettingRow>
      <ul className="ws-member-list">
        {list.map((f, i) => (
          <li key={`${f.id}:${f.version}`} className="ws-member" style={{ flexWrap: "wrap" }}>
            <span className="row" style={{ gap: 6 }}>
              <IconButton icon="arrowUp" tip="Выше" disabled={!can || i === 0} onClick={() => void move(i, -1)} />
              <IconButton icon="arrowDown" tip="Ниже" disabled={!can || i === list.length - 1} onClick={() => void move(i, 1)} />
            </span>
            <FieldRow def={f} disabled={!can} onSave={(patch) => void run(api.wsSave("custom_fields", f.id, patch))} />
            {can && <IconButton icon="trash" tip="Удалить поле" onClick={() => void run(api.wsDelete("custom_fields", f.id))} />}
          </li>
        ))}
        {!list.length && <li className="faint">Полей пока нет.</li>}
      </ul>
      {can && (
        <Button small icon="plus" onClick={() => void run(api.wsSave("custom_fields", null, { entity_type: type, label: "Новое поле", kind: "text", options: [], position: list.reduce((m, d) => Math.max(m, num(d.position)), 0) + 1 }))}>Добавить поле</Button>
      )}
    </Dialog>
  );
}

function FieldRow({ def, disabled, onSave }: { def: CrmRecord; disabled: boolean; onSave: (patch: Record<string, unknown>) => void }) {
  const [label, setLabel] = useState(String(def.label));
  const [opts, setOpts] = useState(options(def).join(", "));
  const parse = (s: string) => [...new Set(s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, 100);
  return (
    <>
      <TextInput value={label} onChange={setLabel} maxLength={80} disabled={disabled} aria-label="Название поля" wrapClass="grow"
        onBlur={() => { const v = label.trim(); if (v && v !== def.label) onSave({ label: v }); else setLabel(String(def.label)); }} />
      <Select small value={String(def.kind)} width={120} disabled={disabled} options={FIELD_KINDS} onChange={(kind) => onSave({ kind })} />
      {def.kind === "select" && (
        <TextInput value={opts} onChange={setOpts} disabled={disabled} placeholder="Варианты через запятую" aria-label="Варианты списка" wrapClass="grow"
          onBlur={() => onSave({ options: parse(opts) })} />
      )}
    </>
  );
}
