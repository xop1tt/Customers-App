// «Коллекции» в левой панели (docs/CRM_ARCHITECTURE.md §8.3) и диалог создания/изменения коллекции.

import { useState } from "react";
import { api } from "../../api";
import type { WsCollection, WsFilter } from "../../api/types";
import { COLLECTION_EMOJI, ENTITIES, ENTITY_TYPES, type EntityType } from "../../lib/crm";
import { integer } from "../../lib/format";
import { move } from "../../lib/sidebarPrefs";
import { Button, Field, IconButton, Segmented, Select, TextInput } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { Dialog, type MenuItem, confirmDialog, showMenu } from "../../ui/overlay";
import { attempt, setState, toast, useStore } from "../../state/store";
import { GroupTitle, useCollapsed } from "../SideGroup";

/** Может ли пользователь менять коллекцию: общие — с `collections.manage`, личные — автор. */
export function canManage(c: Pick<WsCollection, "visibility" | "created_by">, perms: string[], me: string | undefined): boolean {
  return c.visibility === "workspace" ? perms.includes("collections.manage") : c.created_by === me;
}

export function CollectionsGroup({ customize, onOpen }: { customize: boolean; onOpen: (id: string) => void }) {
  const ws = useStore((s) => s.ws);
  const list = useStore((s) => s.collections);
  const section = useStore((s) => s.section);
  const current = useStore((s) => s.collectionId);
  const counts = useStore((s) => s.device.sidebarCounts);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const shut = useCollapsed("collections");
  if (!ws?.active && !list.length) return null;
  const perms = ws?.permissions ?? [];
  const canCreate = perms.includes("records.view");

  const menu = (c: WsCollection): MenuItem[] => {
    const mine = canManage(c, perms, ws?.me);
    const share = perms.includes("collections.manage");
    return [
      { label: "Переименовать и иконка", icon: "edit", disabled: !mine, onSelect: () => setState({ collectionEdit: { id: c.id } }) },
      { label: c.visibility === "workspace" ? "Сделать личной" : "Сделать общей", icon: c.visibility === "workspace" ? "lock" : "users", disabled: !share || (!mine && c.visibility === "private"),
        onSelect: () => void attempt(() => api.wsSave("collections", c.id, { visibility: c.visibility === "workspace" ? "private" : "workspace" })) },
      { separator: true },
      { label: "Удалить", icon: "trash", danger: true, disabled: !mine, onSelect: () => void remove(c) },
    ];
  };

  const remove = async (c: WsCollection) => {
    if (!(await confirmDialog({ title: `Удалить коллекцию «${c.name}»?`, message: "Записи не удаляются — пропадёт только подборка. Её можно восстановить из корзины Workspace.", confirm: "Удалить", danger: true }))) return;
    await attempt(() => api.wsDelete("collections", c.id));
  };

  const drop = (from: number, to: number) => {
    const ids = move(list.map((c) => c.id), from, to);
    setState({ collections: ids.map((id) => list.find((c) => c.id === id)!).filter(Boolean) });
    void attempt(() => api.wsReorderCollections(ids));
  };

  return (
    <div className="nav-group">
      <GroupTitle id="collections" title="Коллекции"
        extra={canCreate && <IconButton icon="plus" size={14} className="nav-title-btn" tip="Новая коллекция" onClick={() => setState({ collectionEdit: { id: null } })} />} />
      {(shut ? list.filter((c) => section === "collection" && current === c.id) : list).map((c, i) =>
        customize ? (
          <div
            key={c.id}
            className={`nav-edit${drag?.over === i ? " drop" : ""}`}
            draggable
            onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDrag({ from: i, over: i }); }}
            onDragOver={(e) => { e.preventDefault(); if (drag && drag.over !== i) setDrag({ ...drag, over: i }); }}
            onDrop={(e) => { e.preventDefault(); if (drag) drop(drag.from, drag.over); setDrag(null); }}
            onDragEnd={() => setDrag(null)}
          >
            <span className="nav-grip" data-tip="Перетащить"><Icon name="grip" size={14} /></span>
            <span className="row grow nav-edit-label"><span className="nav-emoji" aria-hidden="true">{c.emoji || ENTITIES[c.entity_type as EntityType]?.emoji}</span><span className="ellipsis">{c.name}</span></span>
          </div>
        ) : (
          <button
            key={c.id}
            type="button"
            className={`nav-item${section === "collection" && current === c.id ? " active" : ""}`}
            aria-current={section === "collection" && current === c.id ? "page" : undefined}
            onClick={() => onOpen(c.id)}
            onContextMenu={(e) => { e.preventDefault(); showMenu(menu(c), { x: e.clientX, y: e.clientY }); }}
          >
            <span className="nav-emoji" aria-hidden="true">{c.emoji || ENTITIES[c.entity_type as EntityType]?.emoji}</span>
            <span className="ellipsis grow">{c.name}</span>
            {c.visibility === "private" && <Icon name="lock" size={12} className="faint" />}
            {counts && c.count > 0 && <span className="nav-count num">{integer(c.count)}</span>}
          </button>
        ),
      )}
    </div>
  );
}

const FILTER_PRESETS: Record<EntityType, { id: string; label: string; filters: WsFilter[] }[]> = {
  company: [{ id: "all", label: "Все", filters: [] }, { id: "mine", label: "Мои", filters: [{ field: "owner_id", op: "eq", value: "$me" }] }, { id: "nophone", label: "Без телефона", filters: [{ field: "phones", op: "empty" }] }],
  contact: [{ id: "all", label: "Все", filters: [] }, { id: "mine", label: "Мои", filters: [{ field: "owner_id", op: "eq", value: "$me" }] }, { id: "nocompany", label: "Без компании", filters: [{ field: "company_id", op: "empty" }] }],
  crm_lead: [{ id: "all", label: "Все", filters: [] }, { id: "new", label: "Новые", filters: [{ field: "status", op: "eq", value: "new" }] }, { id: "work", label: "В работе", filters: [{ field: "status", op: "eq", value: "in_progress" }] }],
  deal: [{ id: "all", label: "Все", filters: [] }, { id: "open", label: "Открытые", filters: [{ field: "status", op: "eq", value: "open" }] }, { id: "mine", label: "Мои открытые", filters: [{ field: "status", op: "eq", value: "open" }, { field: "owner_id", op: "eq", value: "$me" }] }],
  task: [{ id: "all", label: "Все", filters: [] }, { id: "mine", label: "Мои", filters: [{ field: "assignee_id", op: "eq", value: "$me" }] }, { id: "today", label: "На сегодня", filters: [{ field: "due_at", op: "today" }] }, { id: "overdue", label: "Просроченные", filters: [{ field: "due_at", op: "overdue" }] }],
};

/** Создание и изменение коллекции: название, эмодзи (48 вариантов), что показывает, кому видна. */
export function CollectionDialog() {
  const edit = useStore((s) => s.collectionEdit);
  const list = useStore((s) => s.collections);
  const ws = useStore((s) => s.ws);
  const current = edit?.id ? list.find((c) => c.id === edit.id) : undefined;
  const [name, setName] = useState(current?.name ?? "");
  const [emoji, setEmoji] = useState(current?.emoji ?? "📌");
  const [type, setType] = useState<EntityType>((current?.entity_type as EntityType) ?? "company");
  const [preset, setPreset] = useState("all");
  const share = ws?.permissions.includes("collections.manage") ?? false;
  const [visibility, setVisibility] = useState<"private" | "workspace">(current?.visibility ?? (share ? "workspace" : "private"));
  const [busy, setBusy] = useState(false);
  if (!edit) return null;
  const close = () => setState({ collectionEdit: null });

  const submit = async () => {
    if (!name.trim()) return toast("Введите название коллекции.", "error");
    setBusy(true);
    const fields: Record<string, unknown> = { name: name.trim(), emoji, visibility };
    if (!current) {
      const p = FILTER_PRESETS[type].find((x) => x.id === preset) ?? FILTER_PRESETS[type][0]!;
      fields.entity_type = type;
      fields.config = { filters: p.filters, sort: [{ field: "updated_at", dir: "desc" }] };
      fields.position = (list.reduce((m, c) => Math.max(m, c.position), 0) || 0) + 1;
    }
    const saved = await attempt(() => api.wsSave("collections", current?.id ?? null, fields));
    setBusy(false);
    if (saved) {
      close();
      if (!current) setState({ section: "collection", collectionId: saved.id, record: null });
    }
  };

  return (
    <Dialog title={current ? "Коллекция" : "Новая коллекция"} onClose={close} width={460} footer={
      <>
        <span className="grow" />
        <Button variant="ghost" onClick={close}>Отмена</Button>
        <Button variant="primary" busy={busy} onClick={() => void submit()}>{current ? "Сохранить" : "Создать"}</Button>
      </>
    }>
      <div className="col" style={{ gap: 14, alignItems: "stretch" }}>
        <Field label="Название">
          <TextInput value={name} onChange={setName} maxLength={80} autoFocus placeholder="Например, Клиенты из Казани" />
        </Field>
        <Field label="Иконка">
          <div className="emoji-grid" role="listbox" aria-label="Иконка коллекции">
            {COLLECTION_EMOJI.map((e) => (
              <button key={e} type="button" role="option" aria-selected={e === emoji} className={`emoji-cell${e === emoji ? " on" : ""}`} onClick={() => setEmoji(e)}>{e}</button>
            ))}
          </div>
        </Field>
        {!current && (
          <>
            <Field label="Что показывает">
              <Select value={type} onChange={(v) => { setType(v); setPreset("all"); }} options={ENTITY_TYPES.map((t) => ({ value: t, label: ENTITIES[t].many }))} />
            </Field>
            <Field label="Отбор">
              <Segmented value={preset} onChange={setPreset} options={FILTER_PRESETS[type].map((p) => ({ value: p.id, label: p.label }))} small />
            </Field>
          </>
        )}
        <Field label="Кому видна" hint={share ? undefined : "Общие коллекции создают владелец, администраторы и менеджеры."}>
          <Segmented value={visibility} onChange={(v) => share && setVisibility(v)} options={[{ value: "private", label: "Только мне" }, { value: "workspace", label: "Всем в Workspace" }]} small />
        </Field>
      </div>
    </Dialog>
  );
}
