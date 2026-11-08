import { useState } from "react";
import { back, canGoBack, canSkip, finish, isLast, newFlow, next, position, progress, skip, stepOf } from "../lib/welcomeFlow";
import { ACCENTS, DEFAULT_ACCENT } from "../lib/theme";
import { feedUrl, region, telegramChannel } from "../lib/sourceInput";
import { Button, Group, ProgressBar, Select, SettingRow, Switch, ValueList } from "../ui/kit";
import { Icon } from "../ui/icons";
import { patchAccount, patchDevice, setState, updateSettings, useStore } from "../state/store";
import { DrivesPanel } from "./panels/DrivesPanel";
import { MailPanel } from "./panels/MailPanel";
import { Brand } from "./Auth";

const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((v) => ({ value: v, label: `${Math.round(v * 100)}%` }));

export function Welcome() {
  const [flow, setFlow] = useState(newFlow());
  const step = stepOf(flow);
  const name = useStore((s) => s.session?.displayName);
  const done = async () => {
    await patchAccount({ welcomeDone: true });
    setState({ phase: "ready" });
  };
  const go = async (f: typeof flow) => { setFlow(f); if (f.finished) await done(); };

  return (
    <div className="welcome">
      <div className="welcome-card">
        <header className="welcome-head">
          <div className="row"><Brand size={32} /><span className="faint">{position(flow)}</span><span className="grow" /><Button variant="ghost" small onClick={() => void done()}>Пропустить настройку</Button></div>
          <ProgressBar value={progress(flow)} />
          <h1>{step.id === "intro" ? `Добро пожаловать${name ? `, ${name}` : ""}` : step.title}</h1>
        </header>
        <div className="welcome-body">
          {step.id === "intro" && <Intro />}
          {step.id === "sources" && <SourcesStep />}
          {step.id === "integrations" && <><p className="muted" style={{ marginBottom: 12 }}>Письма можно отправлять из почтовой программы или напрямую со своего сервера. Выгрузка в Битрикс24, Notion и вебхуки настраивается при первом экспорте лидов.</p><Group><MailPanel /></Group></>}
          {step.id === "drives" && <><p className="muted" style={{ marginBottom: 12 }}>Копии базы можно хранить на вашем облачном диске. Этот шаг можно пропустить и вернуться к нему позже в настройках.</p><Group><DrivesPanel /></Group></>}
          {step.id === "appearance" && <AppearanceStep />}
        </div>
        <footer className="welcome-foot">
          {canGoBack(flow) && <Button onClick={() => setFlow(back(flow))}>Назад</Button>}
          <span className="grow" />
          {canSkip(flow) && <Button variant="ghost" onClick={() => void go(skip(flow))}>Пропустить</Button>}
          <Button variant="primary" onClick={() => void go(isLast(flow) ? finish(flow) : next(flow))}>{isLast(flow) ? "Начать работу" : "Далее"}</Button>
        </footer>
      </div>
    </div>
  );
}

function Intro() {
  const items: [string, string, string][] = [
    ["search", "Находит клиентов", "Проверяет RSS-ленты, Telegram, VK и карты и показывает заказы и организации, которым нужен сайт, бот или реклама."],
    ["star", "Оценивает и объясняет", "У каждого лида есть оценка и список причин: бюджет, срочность, нет сайта, нет мобильной версии."],
    ["lock", "Хранит данные у вас", "База зашифрована на вашем компьютере. Облачный аккаунт нужен только для синхронизации между устройствами."],
  ];
  return (
    <ul className="intro">
      {items.map(([icon, title, text]) => (
        <li key={title}><span className="intro-ico"><Icon name={icon} size={18} /></span><div className="col" style={{ gap: 2 }}><strong>{title}</strong><span className="muted">{text}</span></div></li>
      ))}
    </ul>
  );
}

function SourcesStep() {
  const o = useStore((s) => s.overview);
  if (!o) return null;
  const s = o.settings;
  return (
    <div className="col" style={{ gap: 4 }}>
      <Group title="Где искать">
        <SettingRow title="RSS-ленты" hint="Заказы с бирж фриланса"><Switch checked={s.rss.enabled} onChange={(v) => void updateSettings((x) => { x.rss.enabled = v; })} /></SettingRow>
        <SettingRow title="Telegram-каналы" hint="Публичные каналы с заказами"><Switch checked={s.telegram.enabled} onChange={(v) => void updateSettings((x) => { x.telegram.enabled = v; })} /></SettingRow>
        <SettingRow title="OpenStreetMap" hint="Организации в вашем городе без сайта или с устаревшим сайтом"><Switch checked={s.osm.enabled} onChange={(v) => void updateSettings((x) => { x.osm.enabled = v; })} /></SettingRow>
      </Group>
      <Group title="Города и регионы">
        <div style={{ paddingTop: 12 }}><ValueList items={s.osm.regions} onChange={(r) => void updateSettings((x) => { x.osm.regions = r; })} normalize={region} placeholder="Например, Казань" emptyText="Добавьте город, чтобы искать организации." /></div>
      </Group>
      <Group title="Telegram-каналы">
        <div style={{ paddingTop: 12 }}><ValueList items={s.telegram.channels} prefix="@" onChange={(c) => void updateSettings((x) => { x.telegram.channels = c; })} normalize={telegramChannel} placeholder="@канал или ссылка t.me" /></div>
      </Group>
      <Group title="Ленты">
        <div style={{ paddingTop: 12 }}><ValueList items={s.rss.feeds} onChange={(f) => void updateSettings((x) => { x.rss.feeds = f; })} normalize={feedUrl} placeholder="Адрес RSS-ленты" /></div>
      </Group>
    </div>
  );
}

function AppearanceStep() {
  const d = useStore((s) => s.device);
  const current = d.accent ?? DEFAULT_ACCENT;
  return (
    <Group>
      <SettingRow title="Акцентный цвет">
        <div className="swatches">{ACCENTS.map((c) => <button key={c} type="button" className={`swatch${current.toLowerCase() === c ? " on" : ""}`} style={{ background: c }} aria-label={c} onClick={() => void patchDevice({ accent: c === DEFAULT_ACCENT ? null : c })} />)}</div>
      </SettingRow>
      <SettingRow title="Масштаб интерфейса" hint="Подберите удобный размер для вашего экрана."><Select width={110} value={SCALES.find((s) => Math.abs(s.value - d.uiScale) < 0.01)?.value ?? 1} options={SCALES} onChange={(v) => void patchDevice({ uiScale: v })} /></SettingRow>
      <SettingRow title="Компактные строки"><Switch checked={d.compactRows} onChange={(v) => void patchDevice({ compactRows: v })} /></SettingRow>
      <SettingRow title="Анимации"><Switch checked={d.animations} onChange={(v) => void patchDevice({ animations: v })} /></SettingRow>
    </Group>
  );
}
