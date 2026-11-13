// «Золотые» экраны: каждый экран на демо-бэкенде при фиксированном времени даёт один и тот же контур.
// Намеренное изменение интерфейса: `npm run golden:update`, затем просмотреть diff снимков.
import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { resetWsMock } from "../api/wsMock";
import { refreshSnapshot, setState } from "../state/store";
import { refreshTeam } from "../state/team";
import type { AppState } from "../state/store";
import { HomePage } from "../app/pages/Home";
import { LeadsPage } from "../app/pages/LeadsPage";
import { RunsPage } from "../app/pages/RunsPage";
import { TodayPage } from "../app/crm/TodayPage";
import { CalendarPage } from "../app/crm/CalendarPage";
import { ReportsPage } from "../app/crm/ReportsPage";
import { TrashPage } from "../app/crm/TrashPage";
import { JournalPage } from "../app/crm/JournalPage";
import { PeoplePage } from "../app/team/PeoplePage";
import { ChatPage } from "../app/team/ChatPage";
import { ChatWindow } from "../app/team/ChatWindow";
import { ProfilePage } from "../app/team/ProfilePage";
import { Marketplace } from "../app/market/Marketplace";
import { Settings } from "../app/settings/Settings";
import { ModuleRail } from "../app/ModuleRail";
import { Sidebar } from "../app/Sidebar";
import { TopBar } from "../app/TopBar";
import { TitleBar } from "../app/TitleBar";
import { outline } from "./outline";

// Состояние, в котором экран что-то показывает (Settings и Marketplace — окна, открываемые из состояния).
const PREPARE: Record<string, Partial<AppState>> = {
  "Все лиды": { section: "all" },
  "Магазин приложений": { market: "catalog" },
  "Настройки": { settings: "appearance" },
  "Чат: всплывающее окно": { chatPopup: true },
  "Заголовок окна": { phase: "ready" },
};

const SCREENS: [string, ComponentType][] = [
  ["Главная", HomePage],
  ["Все лиды", LeadsPage],
  ["Запуски поиска", RunsPage],
  ["CRM: Сегодня", TodayPage],
  ["CRM: Календарь", CalendarPage],
  ["CRM: Отчёты", ReportsPage],
  ["CRM: Корзина", TrashPage],
  ["CRM: Журнал", JournalPage],
  ["Команда: Сотрудники", PeoplePage],
  ["Команда: Чат", ChatPage],
  ["Чат: всплывающее окно", ChatWindow],
  ["Команда: Профиль", ProfilePage],
  ["Магазин приложений", Marketplace],
  ["Настройки", Settings],
  ["Панель модулей", ModuleRail],
  ["Боковая панель", Sidebar as ComponentType],
  ["Верхняя панель", TopBar],
  ["Заголовок окна", TitleBar],
];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 13, 12, 0, 0));
});
afterAll(() => vi.useRealTimers());
afterEach(cleanup);
beforeEach(async () => {
  resetWsMock();
  setState({ ws: await api.wsState(), section: "home", market: null, settings: null, profileId: null, chatPopup: false });
  setState({ session: (await api.bootInfo()).session });
  await refreshSnapshot();
  await refreshTeam();
});

describe("золотые экраны", () => {
  for (const [name, Screen] of SCREENS) {
    it(name, async () => {
      setState(PREPARE[name] ?? {});
      const { baseElement } = render(<Screen />);
      await vi.waitFor(() => expect(baseElement.childElementCount).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 50));
      expect(outline(baseElement)).toMatchSnapshot();
    });
  }
});
