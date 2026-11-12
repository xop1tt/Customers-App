import { useState } from "react";
import { loadPrefs, savePrefs, type NotifyPrefs } from "../../lib/notifyPrefs";
import { intervalTitle } from "../../lib/format";
import { Button, Group, Notice, Select, SettingRow, Switch } from "../../ui/kit";
import { openSettings, patchAccount, useStore } from "../../state/store";

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
          <Button onClick={() => openSettings("sources")}>Настроить источники</Button>
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
      <InAppNotifications />
    </>
  );
}

/** Подсказки внутри приложения (настройка хранится на этом устройстве). */
function InAppNotifications() {
  const [p, setP] = useState<NotifyPrefs>(loadPrefs);
  const set = (patch: Partial<NotifyPrefs>) => { const next = { ...p, ...patch }; setP(next); savePrefs(next); };
  return (
    <Group title="Подсказки в приложении" note="Относятся только к подсказкам, которые появляются в углу окна, и хранятся на этом компьютере. Уведомления в разделе «Уведомления» и счётчики остаются.">
      <SettingRow title="О новых сообщениях"><Switch checked={p.messages} onChange={(v) => set({ messages: v })} aria-label="Подсказки о сообщениях" /></SettingRow>
      <SettingRow title="О добавлении в обсуждение"><Switch checked={p.groups} onChange={(v) => set({ groups: v })} aria-label="Подсказки об обсуждениях" /></SettingRow>
      <SettingRow title="Тихие часы" hint="В это время подсказки не показываются.">
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <Switch checked={p.quiet} onChange={(v) => set({ quiet: v })} aria-label="Тихие часы" />
          {p.quiet && (
            <>
              <input type="time" className="input" value={p.from} onChange={(e) => set({ from: e.target.value || p.from })} aria-label="Тихие часы с" />
              <span className="faint">до</span>
              <input type="time" className="input" value={p.to} onChange={(e) => set({ to: e.target.value || p.to })} aria-label="Тихие часы до" />
            </>
          )}
        </div>
      </SettingRow>
    </Group>
  );
}
