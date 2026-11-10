import { useState } from "react";
import { ACCENTS, DEFAULT_ACCENT, isHex } from "../../lib/theme";
import { clampThreshold, explanation } from "../../lib/powerPolicy";
import { Button, Group, Notice, NumberInput, Select, SettingRow, Switch, TextInput } from "../../ui/kit";
import { patchDevice, setState, useStore } from "../../state/store";

const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map((v) => ({ value: v, label: `${Math.round(v * 100)}%` }));

const THEMES: Array<{ value: "system" | "dark" | "light"; label: string }> = [
  { value: "system", label: "Как в системе" },
  { value: "dark", label: "Тёмная" },
  { value: "light", label: "Светлая" },
];
// Названия языков не переводятся: их узнают на любом языке.
const LANGUAGES: Array<{ value: "system" | "ru" | "en"; label: string }> = [
  { value: "system", label: "Как в системе" },
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
];

export function Appearance() {
  const d = useStore((s) => s.device);
  const [hex, setHex] = useState(d.accent ?? "");
  const current = d.accent ?? DEFAULT_ACCENT;
  return (
    <>
      <Group title="Оформление" sub="look">
        <SettingRow title="Тема оформления" hint="«Как в системе» следует за светлой или тёмной темой macOS и Windows.">
          <Select width={170} value={d.theme} options={THEMES} onChange={(v) => void patchDevice({ theme: v })} label="Тема оформления" />
        </SettingRow>
        <SettingRow title="Язык интерфейса" hint="Для «Как в системе» берётся язык системы: русский или английский.">
          <Select width={170} value={d.language} options={LANGUAGES} onChange={(v) => void patchDevice({ language: v })} label="Язык интерфейса" />
        </SettingRow>
        <SettingRow title="Акцентный цвет" hint="Используется для кнопок, выделения и переключателей.">
          <div className="swatches" role="radiogroup" aria-label="Акцентный цвет">
            {ACCENTS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={current.toLowerCase() === c} className={`swatch${current.toLowerCase() === c ? " on" : ""}`} style={{ background: c }} aria-label={c} onClick={() => { setHex(c === DEFAULT_ACCENT ? "" : c); void patchDevice({ accent: c === DEFAULT_ACCENT ? null : c }); }} />
            ))}
          </div>
          <TextInput value={hex} onChange={(v) => { setHex(v); if (isHex(v)) void patchDevice({ accent: v }); }} placeholder="#4c8dff" invalid={hex !== "" && !isHex(hex)} wrapClass="hex-input" aria-label="Свой цвет" />
        </SettingRow>
        <SettingRow title="Масштаб интерфейса" hint="Также меняется сочетаниями Ctrl/⌘ + и Ctrl/⌘ −, сброс: Ctrl/⌘ 0.">
          <Select width={110} value={SCALES.find((s) => Math.abs(s.value - d.uiScale) < 0.01)?.value ?? 1} options={SCALES} onChange={(v) => void patchDevice({ uiScale: v })} label="Масштаб" />
        </SettingRow>
        <SettingRow title="Компактные строки" hint="Больше лидов на экране: строки списка ниже, без второй строки."><Switch checked={d.compactRows} onChange={(v) => void patchDevice({ compactRows: v })} /></SettingRow>
        <SettingRow title="Анимации" hint="Плавные переходы и появление окон."><Switch checked={d.animations} onChange={(v) => void patchDevice({ animations: v })} /></SettingRow>
      </Group>

      <Group title="Боковая панель" sub="sidebar">
        <SettingRow title="Числа у разделов"><Switch checked={d.sidebarCounts} onChange={(v) => void patchDevice({ sidebarCounts: v })} /></SettingRow>
        <SettingRow title="Список источников"><Switch checked={d.sidebarSources} onChange={(v) => void patchDevice({ sidebarSources: v })} /></SettingRow>
        <SettingRow title="Показ при наведении" hint="Свёрнутая панель выезжает, когда курсор у левого края окна."><Switch checked={d.sidebarHover} onChange={(v) => void patchDevice({ sidebarHover: v })} /></SettingRow>
        <SettingRow title="Порядок и видимость разделов"><Button onClick={() => setState({ settings: null, customizeNav: true })}>Настроить панель</Button></SettingRow>
      </Group>

    </>
  );
}

export function SystemSection() {
  const d = useStore((s) => s.device);
  const light = useStore((s) => s.lightMode);
  return (
    <>
      <Group title="Запуск и фон" sub="startup">
        <SettingRow title="Запускать при входе в систему"><Switch checked={d.launchAtLogin} onChange={(v) => void patchDevice({ launchAtLogin: v })} /></SettingRow>
        <SettingRow title="Запускать свёрнутым" hint="Окно не показывается при запуске, приложение работает в фоне и в значке в трее."><Switch checked={d.startMinimized} onChange={(v) => void patchDevice({ startMinimized: v })} /></SettingRow>
        <SettingRow title="Закрытие окна сворачивает в трей" hint="Автопоиск и синхронизация продолжают работать. Выйти полностью можно из меню значка."><Switch checked={d.closeToTray} onChange={(v) => void patchDevice({ closeToTray: v })} /></SettingRow>
      </Group>
      <Group title="Экономия энергии" sub="power">
        <SettingRow title="Облегчённый режим автоматически" hint="Отключает анимации, когда включено энергосбережение или заряд батареи низкий.">
          <Switch checked={d.lightModeAuto} onChange={(v) => void patchDevice({ lightModeAuto: v })} />
        </SettingRow>
        {d.lightModeAuto && (
          <SettingRow title="Порог заряда" hint="Ниже этого заряда без зарядки включается облегчённый режим.">
            <NumberInput value={clampThreshold(d.lightModeThreshold)} min={5} max={50} step={5} suffix="%" width={130} onChange={(v) => void patchDevice({ lightModeThreshold: v })} />
          </SettingRow>
        )}
        {light && <Notice tone="info">{explanation(light)}</Notice>}
      </Group>

    </>
  );
}
