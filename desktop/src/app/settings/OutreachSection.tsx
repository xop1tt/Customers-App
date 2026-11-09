import { useEffect, useState } from "react";
import { api } from "../../api";
import type { CallAppInfo } from "../../api/types";
import { Group, Select, SettingRow, Switch, TextArea } from "../../ui/kit";
import { patchAccount, useStore } from "../../state/store";
import { MailPanel } from "../panels/MailPanel";

export function OutreachSection() {
  const a = useStore((s) => s.account);
  const [signature, setSignature] = useState(a?.signature ?? "");
  useEffect(() => setSignature(a?.signature ?? ""), [a?.signature]);
  if (!a) return null;
  return (
    <>
      <Group title="Почта"><MailPanel /></Group>
      <Group title="Подпись" note="Добавляется в конец писем, которые создаёт приложение.">
        <div style={{ paddingTop: 12 }}>
          <TextArea value={signature} onChange={setSignature} onBlur={() => { if (signature !== a.signature) void patchAccount({ signature }); }} placeholder={"С уважением,\nИмя Фамилия\n+7 …"} rows={4} />
        </div>
      </Group>
      <Group title="Звонки">
        <CallApps />
        <SettingRow title="Спрашивать перед звонком" hint="Перед открытием приложения для звонков показывается подтверждение."><Switch checked={a.confirmCalls} onChange={(v) => void patchAccount({ confirmCalls: v })} /></SettingRow>
      </Group>
    </>
  );
}

/** Выбор программы для звонков среди установленных на этом компьютере. */
export function CallApps() {
  const chosen = useStore((s) => s.account?.callApp ?? "system");
  const [apps, setApps] = useState<CallAppInfo[]>([]);
  useEffect(() => { void api.callApps().then(setApps).catch(() => {}); }, []);
  const list = apps.filter((a) => a.installed || a.id === chosen);
  const current = apps.find((a) => a.id === chosen);
  return (
    <SettingRow title="Программа для звонков" hint={current?.opensChat ? "Откроется чат с номером, звонок начинается кнопкой в самой программе." : "Показаны программы, установленные на этом компьютере."}>
      <Select width={250} value={chosen} label="Программа для звонков"
        options={(list.length ? list : [{ id: "system", title: "Стандартное приложение системы", installed: true, opensChat: false }]).map((a) => ({ value: a.id, label: a.installed ? a.title : `${a.title} (не найдено)` }))}
        onChange={(v) => void patchAccount({ callApp: v })} />
    </SettingRow>
  );
}
