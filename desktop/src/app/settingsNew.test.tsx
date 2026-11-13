// Настройки: «Оформление» и «Уведомления» в категории «Приложение»; пузырёк «Новое» у раздела и подраздела (ADR-090).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NEW_SETTINGS, markSettingsSeen, resetSettingsSeen } from "../lib/newSettings";
import { setState } from "../state/store";
import { CATEGORIES, Settings } from "./settings/Settings";

afterEach(() => { cleanup(); setState({ settings: null, settingsSub: null }); });
beforeEach(() => resetSettingsSeen());

describe("категории настроек", () => {
  it("«Оформление» и «Уведомления» — в «Приложении» (после «Системы»), в «Личном» остался «Аккаунт»", () => {
    const of = (t: string) => CATEGORIES.find((c) => c.title === t)!.items.map((i) => i.title);
    expect(of("Приложение")).toEqual(["Система", "Оформление", "Уведомления", "Обновления"]);
    expect(of("Личное")).toEqual(["Аккаунт"]);
  });
});

describe("пузырёк «Новое»", () => {
  const open = (section: "account" | "system", sub: string | null = null) => {
    setState({ settings: section, settingsSub: sub });
    render(<Settings />);
    return screen.getByRole("navigation", { name: "Разделы настроек" });
  };
  const badges = (el: HTMLElement) => within(el).queryAllByText("Новое");

  it("у раздела с новыми параметрами — пузырёк, у других нет", () => {
    const nav = open("account");
    const system = within(nav).getByRole("button", { name: /Система/ });
    expect(within(system).getByText("Новое")).toBeInTheDocument();
    expect(badges(within(nav).getByRole("button", { name: /Аккаунт/ }))).toHaveLength(0);
    expect(NEW_SETTINGS.length).toBeGreaterThan(0);
  });

  it("внутри раздела пузырёк стоит у подраздела «Поиск» и пропадает, когда его открыли", () => {
    const nav = open("system");
    const subs = within(nav).getByRole("group", { name: /Подразделы: Система/ });
    const search = within(subs).getByRole("button", { name: /Поиск/ });
    expect(within(search).getByText("Новое")).toBeInTheDocument();
    expect(badges(within(nav).getByRole("button", { name: /Система/ }))).toHaveLength(0);
    fireEvent.click(search);
    expect(badges(within(nav).getByRole("group", { name: /Подразделы: Система/ }))).toHaveLength(0);
  });

  it("просмотренное не возвращается; открыть другой подраздел метку не снимает", () => {
    markSettingsSeen("system", "startup");
    const first = open("system");
    expect(badges(first)).toHaveLength(1);
    cleanup();
    markSettingsSeen("system", "gsearch");
    const nav = open("account");
    expect(badges(nav)).toHaveLength(0);
  });
});

describe("сноски «См. также»", () => {
  it("у связанных параметров есть ссылки в другие разделы, переход открывает нужный раздел и подраздел", async () => {
    const { getState } = await import("../state/store");
    setState({ settings: "system", settingsSub: "power" });
    render(<Settings />);
    const note = await screen.findByLabelText("Связанные параметры");
    expect(note).toHaveTextContent("См. также");
    fireEvent.click(within(note).getByRole("button", { name: /Оформление — анимации/ }));
    expect(getState().settings).toBe("appearance");
    expect(getState().settingsSub).toBe("look");
  });

  it("сноски есть в «Автопоиске», «Уведомлениях», «Обновлениях» и «Оформлении»", async () => {
    const { api } = await import("../api");
    setState({ account: await api.accountPrefs(), overview: await api.searchOverview(), update: await api.updateInfo() });
    for (const section of ["search", "notifications", "updates", "appearance"] as const) {
      setState({ settings: section, settingsSub: null });
      const { unmount } = render(<Settings />);
      expect((await screen.findAllByLabelText("Связанные параметры")).length).toBeGreaterThan(0);
      unmount();
    }
  });
});
