import { useEffect, useState } from "react";
import { api } from "../api";
import type { ReleaseSummary, WhatsNew } from "../api/types";
import { dateOnly } from "../lib/format";
import { Button, EmptyState } from "../ui/kit";
import { Icon } from "../ui/icons";
import { Dialog } from "../ui/overlay";
import { attempt, boot, patchDevice, setState, useStore } from "../state/store";
import { openLink } from "../state/actions";
import { ReportDialog } from "./settings/SystemSections";
import { Brand } from "./Auth";

/** «Что нового»: при первом запуске новой версии и по запросу из меню справки. */
export function WhatsNewDialog() {
  const [data, setData] = useState<WhatsNew | null>(null);
  const [fallback, setFallback] = useState<ReleaseSummary | null>(null);
  useEffect(() => {
    void api.whatsNew().then(async (w) => {
      setData(w);
      if (!w.show) setFallback((await api.recentReleases().catch(() => [])).find((r) => r.current) ?? null);
    }).catch(() => setData({ show: false }));
  }, []);
  const close = () => { setState({ whatsNewOpen: false }); void attempt(() => api.markWhatsNewSeen()); };
  if (!data) return null;
  return (
    <Dialog title={data.show ? data.title : "Что нового"} onClose={close} width={560} footer={<>{data.show && data.page && <Button variant="ghost" icon="external" onClick={() => void openLink(data.page as string)}>Подробнее</Button>}<Button variant="primary" onClick={close}>Понятно</Button></>}>
      {data.show ? (
        <div className="col" style={{ gap: 16 }}>
          {data.features.map((f) => (
            <section key={f.title} className="col" style={{ gap: 6 }}>
              <h4 className="row"><Icon name="sparkles" size={14} />{f.title}</h4>
              <ul className="bullets">{f.items.map((i) => <li key={i}>{i}</li>)}</ul>
            </section>
          ))}
          {data.features.length === 0 && data.notes && <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{data.notes}</p>}
        </div>
      ) : fallback ? (
        <div className="col" style={{ gap: 8 }}><strong>{fallback.title}</strong><span className="faint">{dateOnly(fallback.date)}</span><p className="muted selectable" style={{ whiteSpace: "pre-wrap" }}>{fallback.notes || "Описание версии отсутствует."}</p></div>
      ) : (
        <EmptyState icon="sparkles" title="Описание недоступно" />
      )}
    </Dialog>
  );
}

/** После сбоя предлагает отправить отчёт (один раз для каждого сбоя). */
export function CrashPrompt() {
  const offer = useStore((s) => s.device.reportsOfferAfterCrash);
  const seen = useStore((s) => s.device.reportsLastSeen);
  const [open, setOpen] = useState<{ date: string; text: string } | null>(null);
  useEffect(() => {
    if (!offer) return;
    let alive = true;
    void (async () => {
      const list = await api.crashReports().catch(() => []);
      const latest = list[0];
      if (!latest || latest.date === seen) return;
      const text = await api.crashReportText(latest.path).catch(() => "");
      if (alive) setOpen({ date: latest.date, text });
    })();
    return () => { alive = false; };
    // Проверка нужна только при открытии сессии.
  }, []);
  if (!open) return null;
  const close = () => { void patchDevice({ reportsLastSeen: open.date }); setOpen(null); };
  return <ReportDialog crash initial={open.text} onClose={close} />;
}

/** Экран, если ядро не смогло запуститься (например, не открылась база). */
export function StartupError() {
  const error = useStore((s) => s.error);
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand"><Brand /><strong style={{ fontSize: "var(--fs-lg)" }}>Customers</strong></div>
        <h2>Не удалось запустить приложение</h2>
        <p className="muted selectable">{error ?? "Неизвестная ошибка."}</p>
        <p className="faint">Ваши данные не изменены. Попробуйте запустить ещё раз; если ошибка повторяется, откройте журнал и отправьте его разработчику.</p>
        <div className="row">
          <Button variant="primary" icon="refresh" onClick={() => void boot()}>Повторить</Button>
          <Button onClick={async () => { const p = await api.pathsInfo().catch(() => null); if (p) await api.revealPath(p.logs).catch(() => {}); }}>Открыть журнал</Button>
          <span className="grow" />
          <Button variant="ghost" onClick={() => void api.quitApp()}>Выйти</Button>
        </div>
      </div>
    </div>
  );
}
