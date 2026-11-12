// «Обсудить»: из карточки CRM создать обсуждение с коллегами и сразу прикрепить к нему эту карточку (A6, ADR-077).

import { useState } from "react";
import { api } from "../../api";
import type { ChatCardType, ChatConversation } from "../../api/types";
import { Button, Checkbox, Field, TextInput } from "../../ui/kit";
import { Dialog } from "../../ui/overlay";
import { attempt, useStore } from "../../state/store";
import { openChat } from "../../state/team";

export const DISCUSSABLE = ["company", "contact", "crm_lead", "deal"];

export function DiscussDialog({ type, id, title, onClose }: { type: ChatCardType; id: string; title: string; onClose: () => void }) {
  const team = useStore((s) => s.team);
  const me = useStore((s) => s.ws?.me);
  const others = team.filter((m) => m.user_id !== me && !m.offline);
  const [name, setName] = useState(title.slice(0, 120));
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const c = await attempt(() => api.wsChat<ChatConversation>("chat_create_group", { title: name.trim(), members: chosen }));
    if (c) {
      const sent = await attempt(() => api.wsChat("chat_post", { conversation: c.id, body: text.trim(), mentions: chosen, attachments: [{ type, id }] }));
      setBusy(false);
      if (sent !== undefined) { onClose(); openChat(c.id); }
      return;
    }
    setBusy(false);
  };
  return (
    <Dialog title="Обсудить с коллегами" onClose={onClose} width={460} footer={
      <>
        <span className="grow faint">Выбрано: {chosen.length}</span>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" busy={busy} disabled={!name.trim() || !chosen.length} onClick={() => void go()}>Начать обсуждение</Button>
      </>
    }>
      <div className="col" style={{ gap: 12, alignItems: "stretch" }}>
        <Field label="Название обсуждения"><TextInput value={name} onChange={setName} maxLength={120} aria-label="Название обсуждения" /></Field>
        <Field label="Сообщение" hint="Карточка будет прикреплена к сообщению; коллеги увидят её, если у них есть доступ к записям.">
          <TextInput value={text} onChange={setText} maxLength={4000} placeholder="Что нужно обсудить" aria-label="Сообщение" />
        </Field>
        <Field label="Кого позвать">
          <ul className="pick-list">
            {others.map((m) => (
              <li key={m.user_id} className="pick-row">
                <Checkbox checked={chosen.includes(m.user_id)} onChange={(v) => setChosen((c) => (v ? [...c, m.user_id] : c.filter((x) => x !== m.user_id)))} label={m.display_name} />
                <span className="faint ellipsis grow" style={{ textAlign: "right" }}>{m.title || m.role_name}</span>
              </li>
            ))}
            {!others.length && <li className="faint">Коллег в рабочем пространстве пока нет.</li>}
          </ul>
        </Field>
      </div>
    </Dialog>
  );
}
