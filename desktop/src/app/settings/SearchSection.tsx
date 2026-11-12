import { intervalTitle } from "../../lib/format";
import { Button, Group, Notice, Select, SettingRow, Switch } from "../../ui/kit";
import { patchAccount, setSection, setState, useStore } from "../../state/store";

// Не чаще раза в 2 часа (решение Maksim): чаще источники не опрашиваются.
const AUTO = [0, 120, 240, 480, 720, 1440];
const autoTitle = (m: number) => (m === 0 ? "Выключен" : m < 60 ? `Каждые ${m} мин` : intervalTitle(m / 60));

export function SearchSection() {
  const a = useStore((s) => s.account);
  const overview = useStore((s) => s.overview);
  if (!a) return null;
  const enabled = overview ? [overview.settings.rss.enabled, overview.settings.telegram.enabled, overview.settings.vk.enabled, overview.settings.osm.enabled].filter(Boolean).length : 0;
  return (
    <>
      <Group title="Автоматический поиск" note="Автопоиск работает, пока приложение запущено, в том числе в фоне. Каждый источник проверяется по собственному расписанию.">
        <SettingRow title="Запускать поиск автоматически">
          <Select width={170} value={a.autoSearchMinutes} options={[...new Set([...AUTO, a.autoSearchMinutes])].sort((x, y) => x - y).map((m) => ({ value: m, label: autoTitle(m) }))} onChange={(v) => void patchAccount({ autoSearchMinutes: v })} label="Автопоиск" />
        </SettingRow>
        <SettingRow title="Новыми считать лиды из последних поисков" hint="Столько последних поисков попадают в раздел «Новые». Синий кружок рядом с лидом пропадает, когда вы его открыли, а сам лид остаётся в списке.">
          <Select width={170} value={a.newLeadsSearches} options={[1, 2, 3, 5, 10, 20].concat([a.newLeadsSearches]).filter((v, i, all) => all.indexOf(v) === i).sort((x, y) => x - y).map((n) => ({ value: n, label: String(n) }))} onChange={(v) => void patchAccount({ newLeadsSearches: v })} label="Новые лиды" />
        </SettingRow>
        <SettingRow title="Источники" hint={`Включено источников: ${enabled} из 4`}>
          <Button onClick={() => { setState({ settings: null }); setSection("sources"); }}>Настроить источники</Button>
        </SettingRow>
      </Group>
      {enabled === 0 && <Notice tone="warn">Все источники выключены, поиск ничего не найдёт.</Notice>}
    </>
  );
}

export function NotificationsSection() {
  const a = useStore((s) => s.account);
  if (!a) return null;
  return (
    <>
      <Group title="Системные уведомления" note="Уведомления показываются, когда окно приложения не в фокусе.">
        <SettingRow title="О новых лидах"><Switch checked={a.notifyNewLeads} onChange={(v) => void patchAccount({ notifyNewLeads: v })} /></SettingRow>
        <SettingRow title="Об ошибках поиска"><Switch checked={a.notifyErrors} onChange={(v) => void patchAccount({ notifyErrors: v })} /></SettingRow>
        <SettingRow title="О синхронизации"><Switch checked={a.notifySync} onChange={(v) => void patchAccount({ notifySync: v })} /></SettingRow>
        <SettingRow title="О сообщениях и упоминаниях" hint="Личные сообщения, @упоминания в обсуждениях, заметках и комментариях, добавление в обсуждение."><Switch checked={a.notifyMessages} onChange={(v) => void patchAccount({ notifyMessages: v })} /></SettingRow>
      </Group>
    </>
  );
}
