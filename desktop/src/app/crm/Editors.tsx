// Редакторы воронок и ролей Workspace. Воронки — обычные записи CRM (синхронизируются как остальные), роли — серверные (облако).

import { useState } from "react";
import { api } from "../../api";
import type { CrmRecord, WsRole } from "../../api/types";
import { Button, Checkbox, Group, IconButton, Notice, NumberInput, Select, SettingRow, Tag, TextInput } from "../../ui/kit";
import { Dialog, confirmDialog } from "../../ui/overlay";
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
      footer={<><Button onClick={onClose}>Отмена</Button><Button variant="danger" disabled={!to} onClick={async () => { if (await attempt(() => api.wsDeleteStage(stage.id, to))) onDone(); }}>Удалить</Button></>}>
      <SettingRow title="Сделки перенести в этап" stack>
        <Select value={to} onChange={setTo} options={others.map((s) => ({ value: s.id, label: String(s.name) }))} />
      </SettingRow>
    </Dialog>
  );
}

/** Роли Workspace: системные неизменны, свои создаются из разрешений, которые есть у вас, с рангом ниже вашего. */
export function RolesEditor({ onClose }: { onClose: () => void }) {
  const ws = useStore((s) => s.ws)!;
  const myRank = ws.workspaces.find((w) => w.id === ws.active)?.rank ?? 0;
  const can = ws.permissions.includes("roles.manage");
  const { data, error } = useWsQuery(() => api.wsRoles(), []);
  const [edit, setEdit] = useState<(WsRole & { isNew?: boolean }) | null>(null);
  const [saved, setSaved] = useState(0);
  const roles = data?.roles ?? [];
  const catalog = data?.catalog ?? [];
  const reload = async () => { setSaved((n) => n + 1); await refreshWorkspace(); };

  return (
    <Dialog title="Роли" onClose={onClose} width={640}>
      {error && <Notice tone="error">{error}</Notice>}
      {!can && <Notice tone="warn">Менять роли может участник с правом «Создавать и менять свои роли».</Notice>}
      <Group title="Роли Workspace" key={saved} action={can ? <Button small icon="plus" onClick={() => setEdit({ key: "", name: "", rank: Math.max(0, myRank - 10), system: false, permissions: ["records.view"], isNew: true })}>Новая роль</Button> : undefined}>
        <ul className="ws-member-list">
          {roles.map((r) => (
            <li key={r.key} className="ws-member">
              <span className="col grow" style={{ gap: 0, minWidth: 0 }}>
                <span className="ellipsis">{r.name} {r.system && <Tag>системная</Tag>}</span>
                <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>ранг {r.rank} · разрешений: {r.permissions.length}</span>
              </span>
              {can && !r.system && r.rank < myRank && (
                <>
                  <IconButton icon="edit" tip="Изменить" onClick={() => setEdit(r)} />
                  <IconButton icon="trash" tip="Удалить" onClick={async () => {
                    if (await confirmDialog({ title: `Удалить роль «${r.name}»?`, message: "Удалить можно роль, которой не пользуются участники и приглашения.", confirm: "Удалить", danger: true })) {
                      await attempt(() => api.wsDeleteRole(r.key));
                      await reload();
                    }
                  }} />
                </>
              )}
            </li>
          ))}
        </ul>
      </Group>
      {edit && <RoleForm role={edit} catalog={catalog} mine={ws.permissions} maxRank={myRank - 1} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </Dialog>
  );
}

function RoleForm({ role, catalog, mine, maxRank, onClose, onSaved }: { role: WsRole & { isNew?: boolean }; catalog: { key: string; description: string }[]; mine: string[]; maxRank: number; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState(role.key);
  const [name, setName] = useState(role.name);
  const [rank, setRank] = useState(role.rank);
  const [perms, setPerms] = useState(new Set(role.permissions));
  const keyOk = /^[a-z][a-z0-9_]{0,40}$/.test(key) && !["owner", "admin", "manager", "employee", "viewer"].includes(key);
  return (
    <Dialog title={role.isNew ? "Новая роль" : `Роль «${role.name}»`} onClose={onClose} width={520}
      footer={<><Button onClick={onClose}>Отмена</Button>
        <Button variant="primary" disabled={!name.trim() || !keyOk} onClick={async () => { if (await attempt(() => api.wsSaveRole(key, name, rank, [...perms]))) onSaved(); }}>Сохранить</Button></>}>
      <SettingRow title="Название"><TextInput value={name} onChange={(v) => { setName(v); if (role.isNew && !role.key) setKey(slug(v)); }} maxLength={60} aria-label="Название роли" /></SettingRow>
      <SettingRow title="Ключ" hint="Латиница, цифры и «_»; после создания не меняется.">
        <TextInput value={key} onChange={setKey} maxLength={41} disabled={!role.isNew} aria-label="Ключ роли" />
      </SettingRow>
      <SettingRow title="Ранг" hint={`Выше ранг — больше власти над участниками. Не выше ${maxRank}.`}><NumberInput value={rank} min={0} max={Math.max(0, maxRank)} onChange={setRank} /></SettingRow>
      <Group title="Разрешения" note="Выдать можно только то, что есть у вас.">
        <div className="col" style={{ gap: 6 }}>
          {catalog.map((p) => (
            <Checkbox key={p.key} checked={perms.has(p.key)} disabled={!mine.includes(p.key)} label={p.description}
              onChange={(on) => setPerms((cur) => { const n = new Set(cur); if (on) n.add(p.key); else n.delete(p.key); return n; })} />
          ))}
        </div>
      </Group>
    </Dialog>
  );
}

const slug = (s: string) => {
  const map: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ы: "y", э: "e", ю: "yu", я: "ya" };
  const t = [...s.toLowerCase()].map((c) => map[c] ?? c).join("").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(t) ? t.slice(0, 40) : t ? `r_${t}`.slice(0, 40) : "";
};
