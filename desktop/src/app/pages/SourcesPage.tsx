import { useState } from "react";
import { api } from "../../api";
import type { OsmCategory, SearchSettings } from "../../api/types";
import { intervalTitle, plural, shortRelative } from "../../lib/format";
import { SOURCES, type SourceMeta, INTERVAL_OPTIONS, sourceItemCount, sourceSettings } from "../../lib/sources";
import { feedUrl, keyword, region, telegramChannel, vkCommunity } from "../../lib/sourceInput";
import { Button, Checkbox, Group, Notice, NumberInput, PasswordInput, Select, SettingRow, Switch, Tag, TextInput, ValueList } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { confirmDialog } from "../../ui/overlay";
import { attempt, refreshOverview, setState, toast, updateSettings, useStore } from "../../state/store";
import { startSearch } from "../../state/actions";

const intervals = (extra?: number[]) => [...new Set([...INTERVAL_OPTIONS, ...(extra ?? [])])].sort((a, b) => a - b).map((h) => ({ value: h, label: intervalTitle(h) }));

export function SourcesPage() {
  const overview = useStore((s) => s.overview);
  const key = useStore((s) => s.sourceKey);
  const states = useStore((s) => s.snap.sources);
  const search = useStore((s) => s.search);
  if (!overview) return null;
  const meta = SOURCES.find((s) => s.key === key) ?? (SOURCES[0] as SourceMeta);
  return (
    <div className="page sources-page">
      <div className="src-master" role="listbox" aria-label="Источники">
        {SOURCES.map((m) => {
          const cfg = sourceSettings(overview.settings, m.group);
          const st = states.find((s) => s.source === m.key);
          const problem = overview.problems[m.key];
          const n = sourceItemCount(overview.settings, m.group);
          return (
            <div key={m.key} className={`src-row${m.key === meta.key ? " active" : ""}`} role="option" aria-selected={m.key === meta.key} tabIndex={0}
              onClick={() => setState({ sourceKey: m.key })} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setState({ sourceKey: m.key }); } }}>
              <Icon name={m.icon} size={18} className="src-ico" />
              <div className="col grow" style={{ gap: 2 }}>
                <span className="ellipsis" style={{ fontWeight: 560 }}>{m.title}</span>
                <span className="ellipsis faint" style={{ fontSize: "var(--fs-sm)" }}>
                  {problem ?? (cfg.enabled ? `${n} ${plural(n, "запись", "записи", "записей")}${st?.last_success_at ? ` · ${shortRelative(st.last_success_at)}` : ""}` : "Выключен")}
                </span>
              </div>
              {st && st.consecutive_failures > 0 && cfg.enabled && <Tag tone="orange" title={st.last_error ?? undefined}>сбои</Tag>}
              <span onClick={(e) => e.stopPropagation()}>
                <Switch checked={cfg.enabled} label={`Включить ${m.title}`} onChange={(v) => void updateSettings((s) => { sourceSettings(s, m.group).enabled = v; })} />
              </span>
            </div>
          );
        })}
      </div>
      <div className="src-detail">
        <div className="src-detail-inner">
          <header className="src-detail-head">
            <Icon name={meta.icon} size={22} />
            <div className="col grow" style={{ gap: 2 }}>
              <h2>{meta.title}</h2>
              <span className="muted">{meta.note}</span>
            </div>
          </header>
          {overview.problems[meta.key] && <Notice tone="warn">{overview.problems[meta.key]}</Notice>}
          <SourceEditor meta={meta} settings={overview.settings} hasVk={overview.hasVkToken} />
          <Group title="Действия">
            <SettingRow title="Проверить сейчас" hint="Запустит поиск только по этому источнику.">
              <Button icon="play" disabled={search.running || !sourceSettings(overview.settings, meta.group).enabled} onClick={() => void startSearch([meta.key])}>Запустить</Button>
            </SettingRow>
            <SettingRow title="Сбросить историю источника" hint="Источник снова обработает записи, которые уже видел. Лиды в базе не удаляются.">
              <Button variant="danger" onClick={async () => {
                const ok = await confirmDialog({ title: `Сбросить историю источника «${meta.title}»?`, message: "При следующем поиске источник заново пройдёт по доступным записям.", confirm: "Сбросить", danger: true });
                if (ok) { await attempt(() => api.resetSourceMemory(meta.key)); toast("Память источника очищена"); }
              }}>Сбросить</Button>
            </SettingRow>
          </Group>
        </div>
      </div>
    </div>
  );
}

function IntervalRow({ hours, onChange }: { hours: number; onChange: (h: number) => void }) {
  return (
    <SettingRow title="Как часто проверять" hint="Источник проверяется не чаще этого интервала, даже если поиск запущен вручную чаще.">
      <Select width={190} value={hours} options={intervals([hours])} onChange={onChange} label="Интервал" />
    </SettingRow>
  );
}

const rejectedToast = (what: string) => (r: string[]) => toast(`Не удалось добавить (${what}): ${r.slice(0, 3).join(", ")}${r.length > 3 ? "…" : ""}`, "error");

function SourceEditor({ meta, settings, hasVk }: { meta: SourceMeta; settings: SearchSettings; hasVk: boolean }) {
  const set = (f: (s: SearchSettings) => void) => void updateSettings(f);
  switch (meta.group) {
    case "rss":
      return (
        <>
          <Group title="Ленты">
            <ValueList items={settings.rss.feeds} onChange={(feeds) => set((s) => { s.rss.feeds = feeds; })} normalize={feedUrl} placeholder="Адрес ленты, например https://www.fl.ru/rss/all.xml" emptyText="Лент пока нет." onRejected={rejectedToast("ссылки")} />
          </Group>
          <Group title="Ключевые слова" note="Если слова заданы, берутся только записи, где встречается хотя бы одно из них. Пусто: подходят все записи.">
            <ValueList items={settings.rss.keywords} onChange={(keywords) => set((s) => { s.rss.keywords = keywords; })} normalize={keyword} placeholder="Слово или фраза" />
          </Group>
          <Group title="Расписание"><IntervalRow hours={settings.rss.intervalHours} onChange={(h) => set((s) => { s.rss.intervalHours = h; })} /></Group>
        </>
      );
    case "telegram":
      return (
        <>
          <Group title="Каналы" note="Нужны публичные каналы с веб-просмотром (t.me/s/…). Можно вставить ссылку или имя через @.">
            <ValueList items={settings.telegram.channels} prefix="@" onChange={(channels) => set((s) => { s.telegram.channels = channels; })} normalize={telegramChannel} placeholder="@канал или https://t.me/канал" emptyText="Каналов пока нет." onRejected={rejectedToast("каналы")} />
          </Group>
          <Group title="Ключевые слова">
            <ValueList items={settings.telegram.keywords} onChange={(keywords) => set((s) => { s.telegram.keywords = keywords; })} normalize={keyword} placeholder="Слово или фраза" />
          </Group>
          <Group title="Параметры">
            <SettingRow title="Страниц на канал" hint="Каждая страница — около 20 последних сообщений."><NumberInput value={settings.telegram.maxPages} min={1} max={10} onChange={(v) => set((s) => { s.telegram.maxPages = v; })} /></SettingRow>
            <IntervalRow hours={settings.telegram.intervalHours} onChange={(h) => set((s) => { s.telegram.intervalHours = h; })} />
          </Group>
        </>
      );
    case "vk":
      return (
        <>
          <Group title="Сервисный ключ VK" note="Бесплатный ключ приложения создаётся на dev.vk.com. Ключ хранится только на этом устройстве в защищённом хранилище.">
            <VkToken hasToken={hasVk} />
          </Group>
          <Group title="Сообщества">
            <ValueList items={settings.vk.communities} onChange={(communities) => set((s) => { s.vk.communities = communities; })} normalize={vkCommunity} placeholder="Ссылка или короткое имя сообщества" emptyText="Сообществ пока нет." onRejected={rejectedToast("сообщества")} />
          </Group>
          <Group title="Ключевые слова">
            <ValueList items={settings.vk.keywords} onChange={(keywords) => set((s) => { s.vk.keywords = keywords; })} normalize={keyword} placeholder="Слово или фраза" />
          </Group>
          <Group title="Параметры">
            <SettingRow title="Записей на странице"><NumberInput value={settings.vk.pageSize} min={5} max={100} step={5} onChange={(v) => set((s) => { s.vk.pageSize = v; })} /></SettingRow>
            <SettingRow title="Страниц на сообщество"><NumberInput value={settings.vk.maxPages} min={1} max={10} onChange={(v) => set((s) => { s.vk.maxPages = v; })} /></SettingRow>
            <IntervalRow hours={settings.vk.intervalHours} onChange={(h) => set((s) => { s.vk.intervalHours = h; })} />
          </Group>
        </>
      );
    case "osm":
      return <OsmEditor settings={settings} set={set} />;
  }
}

function VkToken({ hasToken }: { hasToken: boolean }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (value: string) => {
    setBusy(true);
    const ok = await attempt(async () => { await api.setVkToken(value); return true; });
    setBusy(false);
    if (ok) { setToken(""); await refreshOverview(); toast(value ? "Ключ сохранён" : "Ключ удалён"); }
  };
  return (
    <SettingRow title={hasToken ? "Ключ сохранён" : "Ключ не задан"} hint={hasToken ? "Чтобы заменить, введите новый ключ." : "Без ключа источник не работает."} stack>
      <div className="row" style={{ width: "100%" }}>
        <div className="grow"><PasswordInput value={token} onChange={setToken} placeholder="Сервисный ключ" aria-label="Сервисный ключ VK" /></div>
        <Button variant="primary" busy={busy} disabled={!token.trim()} onClick={() => void save(token.trim())}>Сохранить</Button>
        {hasToken && <Button variant="danger" onClick={() => void save("")}>Удалить</Button>}
      </div>
    </SettingRow>
  );
}

function OsmEditor({ settings, set }: { settings: SearchSettings; set: (f: (s: SearchSettings) => void) => void }) {
  const osm = settings.osm;
  const groups = new Map<string, OsmCategory[]>();
  for (const c of osm.categories) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  const enabledCount = osm.categories.filter((c) => c.enabled).length;
  const [more, setMore] = useState(false);
  return (
    <>
      <Group title="Регионы" note="Название города или области, как на карте: «Казань», «Санкт-Петербург», «Республика Татарстан».">
        <ValueList items={osm.regions} onChange={(regions) => set((s) => { s.osm.regions = regions; })} normalize={region} placeholder="Город или регион" emptyText="Регионов пока нет: поиск по организациям не запустится." />
      </Group>
      <Group title={`Категории организаций (${enabledCount} из ${osm.categories.length})`}
        action={<><Button small variant="ghost" onClick={() => set((s) => { s.osm.categories.forEach((c) => { c.enabled = true; }); })}>Все</Button><Button small variant="ghost" onClick={() => set((s) => { s.osm.categories.forEach((c) => { c.enabled = false; }); })}>Ничего</Button></>}>
        <div className="cats">
          {[...groups.entries()].map(([g, list]) => (
            <div key={g} className="cat">
              <Checkbox
                checked={list.every((c) => c.enabled)}
                indeterminate={list.some((c) => c.enabled) && !list.every((c) => c.enabled)}
                onChange={(v) => set((s) => { s.osm.categories.filter((c) => c.group === g).forEach((c) => { c.enabled = v; }); })}
                label={list[0]?.label ?? g}
              />
              {list.length > 1 && (
                <ul className="cat-sub">
                  {list.map((c) => <li key={c.key}><Checkbox checked={c.enabled} onChange={(v) => set((s) => { const t = s.osm.categories.find((x) => x.key === c.key); if (t) t.enabled = v; })} label={c.label} /></li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Group>
      <Group title="Параметры">
        <SettingRow title="Проверять сайты организаций" hint="Приложение открывает сайт и отмечает, работает ли он, есть ли HTTPS и мобильная версия."><Switch checked={osm.checkWebsites} onChange={(v) => set((s) => { s.osm.checkWebsites = v; })} /></SettingRow>
        <SettingRow title="Новых организаций за запуск" hint="Ограничивает нагрузку на бесплатный сервис карт."><NumberInput value={osm.maxNewPerRun} min={5} max={500} step={5} onChange={(v) => set((s) => { s.osm.maxNewPerRun = v; })} /></SettingRow>
        <SettingRow title="Обновлять данные не реже" hint="Через сколько дней повторно запрашивать уже найденные организации."><NumberInput value={osm.refreshDays} min={1} max={365} suffix="дн." width={130} onChange={(v) => set((s) => { s.osm.refreshDays = v; })} /></SettingRow>
        <SettingRow title="Перепроверять сайт через" hint="Через сколько дней заново проверять сайт организации."><NumberInput value={osm.recheckDays} min={1} max={365} suffix="дн." width={130} onChange={(v) => set((s) => { s.osm.recheckDays = v; })} /></SettingRow>
        <IntervalRow hours={osm.intervalHours} onChange={(h) => set((s) => { s.osm.intervalHours = h; })} />
      </Group>
      <Group title="Дополнительно">
        <SettingRow title="Сервер Overpass" hint="Адрес API карт. Менять нужно, только если основной сервер недоступен." stack>
          {more ? <TextInput value={osm.endpoint} onChange={(v) => set((s) => { s.osm.endpoint = v; })} aria-label="Адрес Overpass" /> : <Button small variant="subtle" onClick={() => setMore(true)}>Показать адрес</Button>}
        </SettingRow>
      </Group>
      <p className="group-note">Данные © участники OpenStreetMap, лицензия ODbL.</p>
    </>
  );
}
