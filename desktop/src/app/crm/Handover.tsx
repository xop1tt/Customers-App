// «Передать записи»: компании, контакты, открытые заявки и сделки и невыполненные задачи сотрудника — коллеге.
// Открывается из списка участников и профиля; при удалении участника предлагается перед удалением.

import { useEffect, useState } from "react";
import { countOwned, describeCounts, HANDOVER, totalOf, transferOwned, type HandoverCounts } from "../../lib/handover";
import { integer } from "../../lib/format";
import { Button, Checkbox, Notice, Select, Spinner } from "../../ui/kit";
import { Dialog } from "../../ui/overlay";
import { refreshWorkspace, toast, useStore } from "../../state/store";

export interface HandoverTarget { userId: string; displayName: string }

export function HandoverDialog({ from, leaving, onClose, onRemove }: {
  from: HandoverTarget;
  /** Участника сейчас удаляют: показываем «Передать и удалить» и «Удалить без передачи». */
  leaving?: boolean;
  onClose: () => void;
  onRemove?: () => Promise<void>;
}) {
  const members = useStore((s) => s.ws?.members ?? []);
  const me = useStore((s) => s.ws?.me);
  const [counts, setCounts] = useState<HandoverCounts | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const others = members.filter((m) => m.userId !== from.userId);

  useEffect(() => {
    let live = true;
    countOwned(from.userId).then((c) => { if (live) { setCounts(c); setChosen(HANDOVER.filter((k) => (c[k.table] ?? 0) > 0).map((k) => k.table)); } }, () => { if (live) setError("Не удалось посчитать записи."); });
    return () => { live = false; };
  }, [from.userId]);
  useEffect(() => { if (!to) setTo(others.find((m) => m.userId === me)?.userId ?? others[0]?.userId ?? ""); }, [others.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = counts ? chosen.reduce((n, t) => n + (counts[t] ?? 0), 0) : 0;
  const targetName = others.find((m) => m.userId === to)?.displayName ?? "";

  const run = async (thenRemove: boolean) => {
    setBusy(true); setError(null);
    try {
      if (selected > 0) {
        const r = await transferOwned(from.userId, to, chosen, (d, t) => setProgress([d, t]));
        toast(r.failed ? `Передано: ${r.moved}, не удалось: ${r.failed}` : `Передано записей: ${r.moved}`, r.failed ? "error" : "success");
        if (r.failed) { setBusy(false); setProgress(null); setError("Часть записей не передалась (нет прав или связи). Повторите: переданные уже не в списке."); setCounts(await countOwned(from.userId)); return; }
      }
      if (thenRemove && onRemove) await onRemove();
      await refreshWorkspace();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не получилось передать записи.");
    }
    setBusy(false); setProgress(null);
  };

  const removeOnly = async () => {
    setBusy(true); setError(null);
    try { await onRemove?.(); await refreshWorkspace(); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "Не удалось удалить участника."); }
    setBusy(false);
  };

  const none = counts !== null && totalOf(counts) === 0;
  return (
    <Dialog title={leaving ? `Удалить ${from.displayName}?` : `Передать записи: ${from.displayName}`} onClose={busy ? () => undefined : onClose} width={520} footer={
      <>
        {leaving && <Button variant="danger" disabled={busy} onClick={() => void removeOnly()}>Удалить без передачи</Button>}
        <span className="grow" />
        <Button variant="ghost" disabled={busy} onClick={onClose}>Отмена</Button>
        <Button variant="primary" busy={busy} disabled={!counts || (!none && (!to || (selected === 0 && !leaving)))} onClick={() => void run(!!leaving)}>
          {leaving ? (selected > 0 ? "Передать и удалить" : "Удалить") : `Передать${selected ? `: ${integer(selected)}` : ""}`}
        </Button>
      </>
    }>
      <div className="col" style={{ gap: 12, alignItems: "stretch" }}>
        {!counts && !error && <div className="center-fill"><Spinner /></div>}
        {error && <Notice tone="error">{error}</Notice>}
        {none && <Notice>За сотрудником нет компаний, контактов, открытых сделок и невыполненных задач.{leaving ? " Его можно удалить." : ""}</Notice>}
        {counts && !none && (
          <>
            <div className="faint">Числится за сотрудником: {describeCounts(counts)}. Выигранные и проигранные сделки, выполненные задачи и закрытые заявки остаются за ним: так не искажаются отчёты.</div>
            <div className="col" style={{ gap: 6 }}>
              {HANDOVER.filter((k) => (counts[k.table] ?? 0) > 0).map((k) => (
                <Checkbox key={k.table} checked={chosen.includes(k.table)} onChange={(v) => setChosen((c) => (v ? [...c, k.table] : c.filter((x) => x !== k.table)))} label={`${k.label}: ${integer(counts[k.table]!)}`} />
              ))}
            </div>
            <Select value={to} onChange={setTo} label="Кому передать" options={others.map((m) => ({ value: m.userId, label: m.displayName, hint: m.roleName }))} />
            {leaving && <div className="faint">Участник потеряет доступ к рабочему пространству. Записи без передачи останутся за ним и будут подписаны «Бывший участник».</div>}
            {selected > 0 && !leaving && <div className="faint">Новому ответственному, {targetName}, перейдут {integer(selected)} записей. Изменение попадёт в историю записей и синхронизируется с командой.</div>}
          </>
        )}
        {progress && <div role="status" className="faint">Передано {progress[0]} из {progress[1]}…</div>}
      </div>
    </Dialog>
  );
}
