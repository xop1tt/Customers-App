import { useEffect, useState } from "react";
import { Group, SettingRow, Switch, TextArea } from "../../ui/kit";
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
        <SettingRow title="Спрашивать перед звонком" hint="Перед открытием приложения для звонков показывается подтверждение."><Switch checked={a.confirmCalls} onChange={(v) => void patchAccount({ confirmCalls: v })} /></SettingRow>
      </Group>
    </>
  );
}
