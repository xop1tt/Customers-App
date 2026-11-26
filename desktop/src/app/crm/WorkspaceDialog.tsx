// Рабочее пространство: выбор и создание Workspace, переименование, настройка CRM и участники.
// Всё хранится в локальной зашифрованной базе на этом компьютере (ADR-100): сервера, приглашений и синхронизации нет.

import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { integer } from "../../lib/format";
import { Avatar, Button, Group, IconButton, Notice, Select, SettingRow, Tag, TextInput } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { attempt, openSettings, refreshWorkspace, setState, useStore } from "../../state/store";
import { PipelineEditor } from "./Editors";
import { CustomFieldsEditor } from "./CustomFields";

export function WorkspaceDialog() {
  const open = useStore((s) => s.workspaceOpen);
  if (!open) return null;
  return <WorkspacePanel />;
}

type Page = "overview" | "people";
type Tile = { id: string; title: string; hint: string; icon: string; tone: "blue" | "green" | "orange"; tag?: string; show: boolean; go: () => void };

/** Окно на весь экран: управление рабочим пространством. Главная — плитки по задачам; плитка открывает свой раздел, «Назад» возвращает к плиткам. */
function WorkspacePanel() {
  const ws = useStore((s) => s.ws);
  const ref = useRef<HTMLElement>(null);
  const [editor, setEditor] = useState<"pipelines" | "fields" | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const close = () => setState({ workspaceOpen: false });
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { prev?.focus?.(); };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".popover, .scrim")) { e.stopPropagation(); if (page) setPage(null); else close(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [page]);
  const current = ws?.workspaces.find((w) => w.id === ws.active);
  const done = async (p: Promise<unknown>) => { const r = await attempt(() => p); await refreshWorkspace(); return r; };

  const groups: { title: string; tiles: Tile[] }[] = ws && current ? [
    { title: "Настройка CRM", tiles: [
      { id: "pipelines", title: "Воронки и этапы", hint: "Названия, порядок, вероятность, тип этапа.", icon: "tree", tone: "green", show: true, go: () => setEditor("pipelines") },
      { id: "fields", title: "Свои поля", hint: "Дополнительные поля в карточках.", icon: "edit", tone: "green", show: true, go: () => setEditor("fields") },
    ] },
    { title: "Данные", tiles: [
      { id: "people", title: "Ответственные", hint: "Кого можно назначать ответственным за записи.", icon: "users", tone: "blue", tag: `${integer(ws.members.length)} чел.`, show: ws.members.length > 1, go: () => setPage("people") },
      { id: "export", title: "Экспорт и копии", hint: "Выгрузка CRM, резервные копии.", icon: "download", tone: "orange", show: true, go: () => { close(); openSettings("data"); } },
    ] },
  ] : [];
  const TITLES: Record<Page, string> = { overview: "Пространства", people: "Ответственные" };

  return (
    <aside ref={ref} tabIndex={-1} className="ws-panel" role="dialog" aria-label="Рабочее пространство">
      <header className="ws-panel-head">
        {page && <IconButton icon="chevronLeft" tip="Назад к плиткам" onClick={() => setPage(null)} />}
        <Avatar name={current?.name ?? "?"} size={30} />
        <span className="col grow" style={{ gap: 0, minWidth: 0 }}>
          <strong className="ellipsis">{page ? TITLES[page] : current?.name ?? "Рабочее пространство"}</strong>
          <span className="faint ellipsis" style={{ fontSize: "var(--fs-sm)" }}>{page ? current?.name : "Рабочее пространство"}</span>
        </span>
        <IconButton icon="x" tip="Закрыть" onClick={close} />
      </header>
      <div className="ws-panel-body">
        {!ws ? (
          <Notice tone="error">База рабочего пространства не открылась. Проверьте журнал ошибок в настройках «Отчёты».</Notice>
        ) : !page ? (
          <>
            {groups.map((g) => (
              <section key={g.title} className="ws-tiles-group" aria-label={g.title}>
                <h4 className="ws-tiles-title">{g.title}</h4>
                <div className="ws-tiles">
                  {g.tiles.filter((t) => t.show).map((t) => (
                    <button key={t.id} type="button" className={`ws-tile ${t.tone}`} onClick={t.go}>
                      <span className="ws-tile-icon"><Icon name={t.icon as never} size={16} /></span>
                      <strong>{t.title}</strong>
                      <span className="faint ws-tile-hint">{t.hint}</span>
                      {t.tag && <span className="faint ws-tile-tag">{t.tag}</span>}
                    </button>
                  ))}
                </div>
              </section>
            ))}
            <p className="ws-tiles-more"><button type="button" className="link" onClick={() => setPage("overview")}>Другие рабочие пространства и новое пространство</button></p>
          </>
        ) : (
          <>
            {page === "overview" && <Overview done={done} />}
            {page === "people" && <Members />}
          </>
        )}
      </div>
      {editor === "pipelines" && <PipelineEditor onClose={() => setEditor(null)} />}
      {editor === "fields" && <CustomFieldsEditor onClose={() => setEditor(null)} />}
    </aside>
  );
}

/** Обзор: выбор и создание пространства, переименование. */
function Overview({ done }: { done: (p: Promise<unknown>) => Promise<unknown> }) {
  const ws = useStore((s) => s.ws)!;
  const [name, setName] = useState("");
  const [rename, setRename] = useState<string | null>(null);
  const current = ws.workspaces.find((w) => w.id === ws.active);
  return (
    <Group title="Рабочее пространство" note="Рабочие пространства хранятся только на этом компьютере, в зашифрованной базе.">
      <SettingRow title="Текущий">
        <Select value={ws.active ?? ""} width={240} onChange={(id) => void done(api.wsSwitch(id))} options={ws.workspaces.map((w) => ({ value: w.id, label: w.name }))} />
      </SettingRow>
      {current && (
        <SettingRow title="Название">
          {rename === null ? <Button small icon="edit" onClick={() => setRename(current.name)}>Переименовать</Button> : (
            <div className="row" style={{ gap: 6 }}>
              <TextInput value={rename} onChange={setRename} maxLength={120} aria-label="Новое название" />
              <Button small variant="primary" onClick={() => void done(api.wsRenameWorkspace(rename)).then(() => setRename(null))}>Сохранить</Button>
            </div>
          )}
        </SettingRow>
      )}
      <SettingRow title="Новое рабочее пространство" hint="Например, для отдельного направления или компании.">
        <div className="row" style={{ gap: 6 }}>
          <TextInput value={name} onChange={setName} maxLength={120} placeholder="Название" aria-label="Название нового рабочего пространства" />
          <Button small icon="plus" disabled={!name.trim()} onClick={() => void done(api.wsCreateWorkspace(name)).then((r) => { if (r) setName(""); })}>Создать</Button>
        </div>
      </SettingRow>
    </Group>
  );
}

/** Люди, перенесённые из бывшего облачного пространства: остаются в списке ответственных, чтобы записи не потеряли владельца. */
function Members() {
  const ws = useStore((s) => s.ws)!;
  return (
    <Group title={`Ответственные · ${integer(ws.members.length)}`} note="Список перенесён из прежнего общего пространства: по этим именам видно, кто отвечает за записи.">
      <ul className="ws-member-list">
        {ws.members.map((m) => (
          <li key={m.userId} className="ws-member">
            <Avatar name={m.displayName} src={m.avatarPath} size={28} />
            <span className="col grow" style={{ gap: 0, minWidth: 0 }}>
              <span className="ellipsis">{m.displayName}{m.userId === ws.me ? <span className="faint"> · вы</span> : null}</span>
            </span>
            <Tag>{m.roleName}</Tag>
          </li>
        ))}
      </ul>
    </Group>
  );
}
