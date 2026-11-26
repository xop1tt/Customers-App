// Редактор воронок рабочего пространства: воронки и этапы — обычные записи CRM в локальной базе.

import { useState } from "react";
import { api } from "../../api";
import type { CrmRecord } from "../../api/types";
import { Button, Group, IconButton, Notice, NumberInput, Select, SettingRow, TextInput } from "../../ui/kit";
import { Dialog } from "../../ui/overlay";
import { attempt, refreshWorkspace, useStore } from "../../state/store";
import { useWsQuery } from "./useCrm";

const KINDS = [
  { value: "open", label: "В работе" },
  { value: "won", label: "Выиграна" },
  { value: "lost", label: "Проиграна" },
];

const num = (v: unknown) => Number(v ?? 0);

/** Воронки и этапы: добавление, переименование, порядок, вероятность, тип, удаление этапа с переносом сделок. */
export function PipelineEditor({ onClose }: { onClose: () => void }) {
  const can = useStore((s) => s.ws?.permissions.includes("pipelines.manage") ?? false);
  const { data } = useWsQuery(async () => {
    const [pipelines, stages] = await Promise.all([api.wsList("pipelines", { limit: 5000 }), api.wsList("pipeline_stages", { limit: 5000 })]);
    return { pipelines: pipelines.items, stages: stages.items };
  }, []);
  const [pipeId, setPipeId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CrmRecord | null>(null);
  const pipelines = data?.pipelines ?? [];
  const current = pipelines.find((p) => p.id === pipeId) ?? pipelines.find((p) => p.is_default) ?? pipelines[0];
  const stages = (data?.stages ?? []).filter((s) => s.pipeline_id === current?.id).sort((a, b) => num(a.position) - num(b.position));
  const run = async (p: Promise<unknown>) => { await attempt(() => p); await refreshWorkspace(); };

  const move = async (i: number, d: -1 | 1) => {
    const a = stages[i], b = stages[i + d];
    if (!a || !b) return;
    await run(Promise.all([api.wsSave("pipeline_stages", a.id, { position: num(b.position) }), api.wsSave("pipeline_stages", b.id, { position: num(a.position) })]));
  };

  return (
    <Dialog title="Воронки и этапы" onClose={onClose} width={680}>
      {!can && <Notice tone="warn">Менять воронки может только участник с правом «Воронки и этапы». Вы видите их в режиме чтения.</Notice>}
      <Group title="Воронка">
        <SettingRow title="Выбрана">
          <div className="row" style={{ gap: 6 }}>
            <Select value={current?.id ?? ""} width={220} onChange={setPipeId} options={pipelines.map((p) => ({ value: p.id, label: String(p.name) }))} />
            {can && <Button small icon="plus" onClick={() => void NewPipeline(run, pipelines.length)}>Новая</Button>}
          </div>
        </SettingRow>
        {current && can && (
          <SettingRow title="Название">
            <NameInput key={`${current.id}:${current.version}`} value={String(current.name)} label="Название воронки" onCommit={(v) => void run(api.wsSave("pipelines", current.id, { name: v }))} />
          </SettingRow>
        )}
        {current && can && !current.is_default && (
          <SettingRow title="По умолчанию" hint="В эту воронку попадают новые сделки, если воронка не выбрана.">
            <Button small onClick={() => void run(Promise.all(pipelines.filter((p) => p.is_default).map((p) => api.wsSave("pipelines", p.id, { is_default: false }))).then(() => api.wsSave("pipelines", current.id, { is_default: true })))}>Сделать основной</Button>
          </SettingRow>
        )}
      </Group>
      <Group title={`Этапы · ${stages.length}`} note="Сделка в этапе «Выиграна» или «Проиграна» закрывается. Вероятность — для прогноза выручки.">
        <ul className="ws-member-list">
          {stages.map((st, i) => (
            <li key={st.id} className="ws-member" style={{ flexWrap: "wrap" }}>
              <span className="row" style={{ gap: 6 }}>
                <IconButton icon="arrowUp" tip="Выше" disabled={!can || i === 0} onClick={() => void move(i, -1)} />
                <IconButton icon="arrowDown" tip="Ниже" disabled={!can || i === stages.length - 1} onClick={() => void move(i, 1)} />
              </span>
              <NameInput key={`${st.id}:${st.version}`} value={String(st.name)} disabled={!can} label="Название этапа" grow onCommit={(v) => void run(api.wsSave("pipeline_stages", st.id, { name: v }))} />
              <Select small value={String(st.kind ?? "open")} width={130} disabled={!can} options={KINDS}
                onChange={(kind) => void run(api.wsSave("pipeline_stages", st.id, { kind, probability: kind === "won" ? 100 : kind === "lost" ? 0 : num(st.probability) }))} />
              <NumberInput value={num(st.probability)} min={0} max={100} suffix="%" width={90} onChange={(v) => { if (can) void run(api.wsSave("pipeline_stages", st.id, { probability: v })); }} />
              {can && stages.length > 1 && <IconButton icon="trash" tip="Удалить этап" onClick={() => setRemoving(st)} />}
            </li>
          ))}
        </ul>
        {can && current && (
          <Button small icon="plus" onClick={() => void run(api.wsSave("pipeline_stages", null, { pipeline_id: current.id, name: "Новый этап", kind: "open", probability: 10, position: stages.reduce((m, s) => Math.max(m, num(s.position)), 0) + 1 }))}>Добавить этап</Button>
        )}
      </Group>
      {removing && <RemoveStage stage={removing} others={stages.filter((s) => s.id !== removing.id)} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); void refreshWorkspace(); }} />}
    </Dialog>
  );
}

function NameInput({ value, label, disabled, grow, onCommit }: { value: string; label: string; disabled?: boolean; grow?: boolean; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <TextInput value={text} onChange={setText} maxLength={120} disabled={disabled} aria-label={label} wrapClass={grow ? "grow" : undefined}
      onBlur={() => { const v = text.trim(); if (v && v !== value) onCommit(v); else setText(value); }} />
  );
}

async function NewPipeline(run: (p: Promise<unknown>) => Promise<void>, count: number) {
  await run((async () => {
    const p = await api.wsSave("pipelines", null, { name: `Воронка ${count + 1}`, position: count + 1, is_default: false });
    await Promise.all([["Новый", "open", 10], ["В работе", "open", 50], ["Выиграна", "won", 100], ["Проиграна", "lost", 0]].map(([name, kind, probability], i) =>
      api.wsSave("pipeline_stages", null, { pipeline_id: p.id, name, kind, probability, position: i + 1 })));
  })());
}

function RemoveStage({ stage, others, onClose, onDone }: { stage: CrmRecord; others: CrmRecord[]; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState(others[0]?.id ?? "");
  return (
    <Dialog title={`Удалить этап «${String(stage.name)}»`} onClose={onClose} width={440}
      footer={<><Button variant="ghost" onClick={onClose}>Отмена</Button><Button variant="danger" disabled={!to} onClick={async () => { if (await attempt(() => api.wsDeleteStage(stage.id, to))) onDone(); }}>Удалить</Button></>}>
      <SettingRow title="Сделки перенести в этап" stack>
        <Select value={to} onChange={setTo} options={others.map((s) => ({ value: s.id, label: String(s.name) }))} />
      </SettingRow>
    </Dialog>
  );
}
