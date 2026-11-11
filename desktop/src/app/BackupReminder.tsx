// Напоминание на «Сегодня», если резервной копии нет неделю и дольше или нет ни одной (пакет G8).
// «Сделать копию» — та же команда, что в настройках; «Позже» скрывает напоминание на сутки на этом устройстве.

import { useEffect, useState } from "react";
import { api } from "../api";
import type { BackupFile } from "../api/types";
import { backupState, snoozeUntil } from "../lib/backupReminder";
import { integer, plural } from "../lib/format";
import { Button, Notice } from "../ui/kit";
import { attempt, openSettings, toast } from "../state/store";

const KEY = "customers.backupReminder.snoozedUntil";
const readSnooze = (): number | null => {
  try { const v = Number(localStorage.getItem(KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
};

export function BackupReminder() {
  const [backups, setBackups] = useState<BackupFile[] | null>(null);
  const [snoozed, setSnoozed] = useState<number | null>(readSnooze);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.listBackups().then(setBackups).catch(() => setBackups(null)); }, []);
  if (!backups) return null;
  const st = backupState(backups, new Date(), snoozed);
  if (st.kind === "ok") return null;

  const now = async () => {
    setBusy(true);
    const r = await attempt(() => api.backupNow());
    setBusy(false);
    if (r === undefined) return;
    toast("Резервная копия создана", "success");
    setBackups(await api.listBackups().catch(() => backups));
  };
  const later = () => {
    const until = snoozeUntil();
    try { localStorage.setItem(KEY, String(until)); } catch { /* только в памяти */ }
    setSnoozed(until);
  };
  return (
    <div className="backup-reminder" role="status">
      <Notice tone="warn" action={
        <div className="row" style={{ gap: 6 }}>
          <Button small variant="primary" busy={busy} onClick={() => void now()}>Сделать копию</Button>
          <Button small onClick={() => openSettings("data")}>Настроить</Button>
          <Button small variant="ghost" onClick={later}>Позже</Button>
        </div>
      }>
        {st.kind === "never"
          ? "Резервной копии данных ещё нет. Сделайте её, чтобы не потерять клиентов и сделки."
          : `Последняя резервная копия — ${integer(st.days)} ${plural(st.days, "день", "дня", "дней")} назад. Проверьте настройки копий или сделайте её сейчас.`}
      </Notice>
    </div>
  );
}
