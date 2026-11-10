// Онлайн-присутствие участников облачного Workspace: опрос раз в 25 с, пока открыта карточка или диалог.

import { useEffect, useState } from "react";
import { api } from "../../api";
import type { WsPresence } from "../../api/types";
import { useStore } from "../../state/store";

const EVERY = 25_000;

/** Список «кто онлайн» (без вас); при указанной карточке в ответе видно, кто смотрит ту же запись. */
export function usePresence(entity?: { type: string; id: string }): WsPresence[] {
  const cloud = useStore((s) => s.ws?.isCloud ?? false);
  const me = useStore((s) => s.ws?.me);
  const active = useStore((s) => s.ws?.active);
  const [list, setList] = useState<WsPresence[]>([]);
  const type = entity?.type, id = entity?.id;
  useEffect(() => {
    if (!cloud) { setList([]); return; }
    let live = true;
    const tick = () => { api.wsPresence(type, id).then((l) => { if (live) setList(l.filter((p) => p.user_id !== me)); }, () => { if (live) setList([]); }); };
    tick();
    const t = setInterval(tick, EVERY);
    return () => { live = false; clearInterval(t); };
  }, [cloud, me, active, type, id]);
  return list;
}

export function WatchingNow({ type, id }: { type: string; id: string }) {
  const members = useStore((s) => s.ws?.members ?? []);
  const names = usePresence({ type, id }).filter((p) => p.entity_type === type && p.entity_id === id)
    .map((p) => members.find((m) => m.userId === p.user_id)?.displayName ?? "Участник");
  if (!names.length) return null;
  return <div className="faint presence-note" role="status"><span className="presence-dot" aria-hidden="true" /> Сейчас смотрят: {names.join(", ")}</div>;
}
