import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { BackupFile } from "../../api/types";
import { bytes, fullRu, plural, shortenHome } from "../../lib/format";
import { pickFile, pickFolder } from "../../lib/platform";
import { Button, EmptyState, Group, NumberInput, SettingRow, Switch, Tag, TextInput } from "../../ui/kit";
import { confirmDialog } from "../../ui/overlay";
import { Icon } from "../../ui/icons";
import { attempt, boot, patchAccount, refreshSnapshot, toast, useStore } from "../../state/store";
import { DrivesPanel } from "../panels/DrivesPanel";

export function DataSection() {
  const session = useStore((s) => s.session);
  const size = useStore((s) => s.snap.databaseSize);
  const a = useStore((s) => s.account);
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => { void api.listBackups().then(setBackups).catch(() => {}); }, []);
  useEffect(load, [load]);
  if (!a || !session) return null;

  const now = async () => {
    setBusy("backup");
    const r = await attempt(() => api.backupNow());
    setBusy(null);
    if (r) { toast("Резервная копия создана", "success"); load(); }
  };
  const restore = async (b: BackupFile) => {
    const ok = await confirmDialog({ title: "Восстановить из копии?", message: `Текущая база будет заменена копией «${b.name}». Перед этим приложение сохранит текущую базу.`, confirm: "Восстановить", danger: true });
    if (!ok) return;
    setBusy(b.path);
    const r = await attempt(() => api.restoreBackup(b.path));
    setBusy(null);
    if (r) { toast(r, "success"); await refreshSnapshot(); load(); }
  };
  const move = async () => {
    const dir = await pickFolder("Куда перенести базу данных");
    if (!dir) return;
    const ok = await confirmDialog({ title: "Перенести базу данных?", message: `База будет перенесена в папку:\n${dir}`, confirm: "Перенести" });
    if (!ok) return;
    setBusy("move");
    const r = await attempt(() => api.moveDatabase(dir));
    setBusy(null);
    if (r) { toast(r, "success"); await boot(); }
  };
  const chooseBackupDir = async () => {
    const dir = await pickFolder("Папка резервных копий", a.backupDirectory || undefined);
    if (dir) await patchAccount({ backupDirectory: dir });
  };

  return (
    <>
      <Group title="База данных" sub="db">
        <SettingRow title="Расположение" hint={<span className="selectable">{shortenHome(session.databasePath)}</span>}>
          <Button icon="folder" onClick={() => void attempt(() => api.revealPath(session.databasePath))}>Показать</Button>
          <Button busy={busy === "move"} onClick={() => void move()}>Перенести…</Button>
        </SettingRow>
        <SettingRow title="Размер" hint="Данные зашифрованы на диске ключом, который хранится в защищённом хранилище системы."><span className="num">{bytes(size)}</span></SettingRow>
      </Group>

      <Group title="Резервные копии" sub="backups" note="Копии хранятся рядом с вашими документами. Перед восстановлением приложение всегда сохраняет текущую базу.">
        <SettingRow title="Автоматические копии" hint="Раз в день, пока приложение запущено."><Switch checked={a.autoBackup} onChange={(v) => void patchAccount({ autoBackup: v })} /></SettingRow>
        <SettingRow title="Хранить копий" hint="Старые копии удаляются автоматически."><NumberInput value={a.keepBackups} min={1} max={90} width={130} onChange={(v) => void patchAccount({ keepBackups: v })} /></SettingRow>
        <SettingRow title="Папка копий" hint={a.backupDirectory ? <span className="selectable">{shortenHome(a.backupDirectory)}</span> : "Стандартная папка приложения"}>
          <Button onClick={() => void chooseBackupDir()}>Выбрать…</Button>
          {a.backupDirectory && <Button variant="ghost" onClick={() => void patchAccount({ backupDirectory: "" })}>Сбросить</Button>}
        </SettingRow>
        <SettingRow title="Создать копию сейчас"><Button icon="download" variant="primary" busy={busy === "backup"} onClick={() => void now()}>Создать копию</Button></SettingRow>
        {backups.length === 0 ? (
          <div style={{ paddingTop: 8 }}><EmptyState icon="archive" title="Копий пока нет" /></div>
        ) : (
          <ul className="backup-list">
            {backups.map((b) => (
              <li key={b.path} className="backup">
                <Icon name="database" size={15} className="faint" />
                <div className="col grow" style={{ gap: 1 }}><span className="ellipsis">{b.name}</span><span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{fullRu(b.modifiedAt)} · {bytes(b.size)}</span></div>
                <Button small busy={busy === b.path} onClick={() => void restore(b)}>Восстановить</Button>
              </li>
            ))}
          </ul>
        )}
      </Group>

      <Group title="Облачные диски" sub="drives" note="Копии базы можно загружать в папку приложения на вашем диске. Приложение не видит другие ваши файлы.">
        <DrivesPanel />
      </Group>
    </>
  );
}

const KIND_TITLE = { domain: "Сайт", email: "Почта", phone: "Телефон", name: "Название" } as const;

export function ExclusionsSection() {
  const list = useStore((s) => s.snap.exclusions);
  const [value, setValue] = useState("");
  const add = async () => {
    if (!value.trim()) return;
    const r = await attempt(() => api.exclude(value.trim()));
    if (r) { setValue(""); toast(r); await refreshSnapshot(); }
  };
  const importFile = async () => {
    const path = await pickFile("Файл с исключениями", ["csv", "txt"]);
    if (!path) return;
    const r = await attempt(() => api.importExclusions(path));
    if (r) { toast(r, "success"); await refreshSnapshot(); }
  };
  return (
    <Group title={`Исключения (${list.length})`} note="Лиды с такими сайтами, почтой, телефонами или названиями не добавляются при поиске, а уже найденные уходят в «Исключённые».">
      <div className="row" style={{ padding: "14px 0" }}>
        <TextInput value={value} onChange={setValue} placeholder="Сайт, почта, телефон или название" wrapClass="grow" onKeyDown={(e) => { if (e.key === "Enter") void add(); }} aria-label="Новое исключение" />
        <Button icon="plus" disabled={!value.trim()} onClick={() => void add()}>Добавить</Button>
        <Button icon="upload" onClick={() => void importFile()}>Импорт…</Button>
      </div>
      {list.length === 0 ? <EmptyState icon="ban" title="Исключений нет" /> : (
        <ul className="backup-list">
          {list.map((e) => (
            <li key={e.id} className="backup">
              <Tag>{KIND_TITLE[e.kind]}</Tag>
              <span className="ellipsis grow selectable">{e.value}</span>
              <Button small variant="ghost" icon="x" onClick={() => void attempt(() => api.removeExclusion(e.id)).then(refreshSnapshot)}>Убрать</Button>
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only">{plural(list.length, "исключение", "исключения", "исключений")}</span>
    </Group>
  );
}
