// Вложения карточки: список, добавление файла (до 5 МБ), сохранение на диск, удаление.

import { useRef, useState } from "react";
import { api } from "../../api";
import type { WsCard } from "../../api/types";
import type { EntityMeta } from "../../lib/crm";
import { can } from "../../lib/crm";
import { bytes } from "../../lib/format";
import { pickSavePath } from "../../lib/platform";
import { Button, IconButton } from "../../ui/kit";
import { confirmDialog } from "../../ui/overlay";
import { attempt, toast, useStore, NONE } from "../../state/store";

export const MAX_ATTACHMENT = 5 * 1024 * 1024;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("Файл не читается."));
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.readAsDataURL(file);
  });
}

export function AttachmentsSection({ e, data }: { e: EntityMeta; data: WsCard }) {
  const perms = useStore((s) => s.ws?.permissions ?? NONE);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (e.type === "task") return null;
  const rows = (data.attachments ?? []).filter((a) => !a.deleted_at);
  const creatable = can(perms, "create");

  const add = async (files: FileList | null) => {
    const file = files?.[0];
    if (input.current) input.current.value = "";
    if (!file) return;
    if (file.size > MAX_ATTACHMENT) { toast("Файл больше 5 МБ.", "error"); return; }
    setBusy(true);
    try {
      const body = await readBase64(file);
      await attempt(() => api.wsAttachAdd(e.type, data.record.id, file.name, file.type, body));
    } finally { setBusy(false); }
  };
  const removeFile = async (id: string, name: string) => {
    if (!(await confirmDialog({ title: `Удалить файл «${name}»?`, message: "Файл исчезнет из карточки.", confirm: "Удалить", danger: true }))) return;
    await attempt(() => api.wsDelete("attachments", id));
  };
  const save = async (id: string, name: string) => {
    const path = await pickSavePath("Сохранить файл", name, name.includes(".") ? name.split(".").pop()! : "*");
    if (path && (await attempt(() => api.wsAttachSave(id, path)))) toast("Файл сохранён", "success");
  };

  return (
    <section className="insp-sec">
      <h4 className="row"><span className="grow">Вложения{rows.length ? ` · ${rows.length}` : ""}</span>
        {creatable && <Button small icon="plus" busy={busy} onClick={() => input.current?.click()}>Добавить файл</Button>}
      </h4>
      <input ref={input} type="file" hidden aria-label="Выбор файла" onChange={(ev) => void add(ev.target.files)} />
      {!rows.length ? <p className="faint">Пока нет. Файлы до 5 МБ.</p> : (
        <ul className="crm-related">
          {rows.map((a) => (
            <li key={a.id} className="row" style={{ gap: 6 }}>
              <button type="button" className="crm-link grow" onClick={() => void save(a.id, String(a.name))}>
                <span className="ellipsis grow">{String(a.name)}</span>
                <span className="faint">{typeof a.size === "number" ? bytes(a.size) : ""}</span>
              </button>
              <IconButton icon="trash" tip="Удалить" onClick={() => void removeFile(a.id, String(a.name))} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
