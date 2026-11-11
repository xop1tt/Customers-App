// «Начало работы» на «Сегодня» (пакет G7, ADR-063): пять шагов нового пользователя. Карточка исчезает, когда всё
// сделано или её скрыли («Скрыть» помнится на этом устройстве). Факты берутся из обычных списков CRM и копий.

import { useEffect, useState } from "react";
import { api } from "../../api";
import { showChecklist, startChecklist, type StartFacts, type StartItemId } from "../../lib/onboarding";
import { Button, ProgressBar } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { openRecord, openSettings, setState, useStore } from "../../state/store";

const KEY = "customers.start.hidden";
const readHidden = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
const writeHidden = () => { try { localStorage.setItem(KEY, "1"); } catch { /* без хранилища — до перезапуска */ } };

export function StartChecklist({ tick = 0 }: { tick?: number }) {
  const account = useStore((s) => s.account);
  const wsVersion = useStore((s) => s.wsVersion);
  const [hidden, setHidden] = useState(readHidden);
  const [facts, setFacts] = useState<StartFacts | null>(null);

  useEffect(() => {
    if (hidden) return;
    let live = true;
    void Promise.all([
      api.wsList("companies", { limit: 1 }),
      api.wsList("deals", { limit: 1 }),
      api.wsList("tasks", { limit: 1 }),
      api.listBackups().catch(() => []),
    ]).then(([c, d, t, b]) => {
      if (!live) return;
      const count = (r: { total: number; items: unknown[] }) => Math.max(r.total, r.items.length);
      setFacts({ wizardDone: !!account?.welcomeDone, companies: count(c), deals: count(d), tasks: count(t), backup: b.length > 0 || !!account?.autoBackup });
    }).catch(() => {});
    return () => { live = false; };
  }, [hidden, tick, wsVersion, account?.welcomeDone, account?.autoBackup]);

  if (hidden || !facts) return null;
  const items = startChecklist(facts);
  if (!showChecklist(items, hidden)) return null;
  const doneCount = items.filter((i) => i.done).length;

  const action: Record<StartItemId, { label: string; run: () => void } | null> = {
    workspace: { label: "Настроить", run: () => setState({ workspaceOpen: true }) },
    clients: { label: "Добавить", run: () => openRecord("companies", "new") },
    deal: { label: "Создать", run: () => openRecord("deals", "new") },
    task: { label: "Запланировать", run: () => openRecord("tasks", "new") },
    backup: { label: "Настроить", run: () => openSettings("data", "backups") },
  };

  return (
    <section className="start-card" aria-label="Начало работы">
      <div className="row">
        <strong>Начало работы</strong>
        <span className="faint">{doneCount} из {items.length}</span>
        <span className="grow" />
        <Button small variant="ghost" onClick={() => { writeHidden(); setHidden(true); }}>Скрыть</Button>
      </div>
      <ProgressBar value={doneCount / items.length} label="Сделано шагов" />
      <ul>
        {items.map((i) => (
          <li key={i.id} className={i.done ? "done" : ""}>
            <span className="start-mark" aria-hidden="true">{i.done && <Icon name="check" size={12} />}</span>
            <span className="grow">{i.title}<span className="sr-only">{i.done ? " — сделано" : ""}</span></span>
            {!i.done && action[i.id] && <Button small onClick={action[i.id]!.run}>{action[i.id]!.label}</Button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
