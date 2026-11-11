// Проверка доступности (пакет G8, ADR-060): axe-core на главных экранах в jsdom. Правила, которым нужна настоящая
// отрисовка (контраст цветов, видимость), здесь не работают и проверяются глазами по макетам; остальное — строго.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { toggleQuick } from "./QuickSearch";
import { KeyEntryDialog, RecoveryKeyDialog } from "./settings/PortableCopy";
import { Welcome } from "./Welcome";

afterEach(cleanup);

/** Нарушения axe на странице: «правило: элемент — подсказка». */
async function violations(): Promise<string[]> {
  const res = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    resultTypes: ["violations"],
  });
  const out = res.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")} — ${n.failureSummary?.split("\n").slice(1).join(" ").trim()}`));
  return out;
}

const go = async (name: string) => {
  fireEvent.click(within(await screen.findByLabelText("Навигация")).getByText(name));
};

describe("доступность главных экранов", () => {
  it("модуль CRM: «Сегодня», календарь, сделки, отчёты, клиенты и карточка", async () => {
    render(<App />);
    fireEvent.click(await within(await screen.findByRole("navigation", { name: "Модули" })).findByRole("button", { name: /^CRM/ }));
    await go("Сегодня");
    await screen.findByRole("heading", { name: "Сегодня" });
    expect(await violations()).toEqual([]);

    await go("Календарь");
    await screen.findByRole("grid");
    expect(await violations()).toEqual([]);

    await go("Сделки");
    await screen.findByRole("list", { name: /Воронка/ });
    expect(await violations()).toEqual([]);

    await go("Отчёты");
    await screen.findAllByText(/Прогноз/);
    expect(await violations()).toEqual([]);

    await go("Все клиенты");
    fireEvent.click(await screen.findByText("ООО «Северный ветер»"));
    await screen.findByRole("group", { name: "Связаться" });
    expect(await violations()).toEqual([]);

    fireEvent.click(within(screen.getByRole("group", { name: "Связаться" })).getByRole("button", { name: "Написать" }));
    await screen.findByRole("dialog", { name: "Написать письмо" });
    expect(await violations()).toEqual([]);
  });

  it("поиск клиентов и быстрый поиск", async () => {
    render(<App />);
    fireEvent.click(await within(await screen.findByRole("navigation", { name: "Модули" })).findByRole("button", { name: /^Поиск/ }));
    await go("Главная");
    await screen.findByText("Лучшие новые лиды");
    expect(await violations()).toEqual([]);
    act(() => toggleQuick());
    await screen.findByRole("dialog");
    expect(await violations()).toEqual([]);
  });

  it("ключ восстановления переносимой копии: показ и ввод", async () => {
    const shown = render(<RecoveryKeyDialog value="7KQ2M-XW9RT-4HBNC-P3VZE-6GJ8S-YD5FA" onDone={() => {}} />);
    await screen.findByRole("dialog");
    expect(await violations()).toEqual([]);
    shown.unmount();
    render(<KeyEntryDialog onClose={() => {}} onSubmit={() => {}} />);
    await screen.findByRole("dialog");
    expect(await violations()).toEqual([]);
  });

  it("мастер первого запуска: все шаги", async () => {
    render(<Welcome />);
    for (const title of ["Ваша компания", "Как вы продаёте", "Добавьте клиентов", "Звонки и письма"]) {
      expect(await violations()).toEqual([]);
      const go = screen.queryByRole("button", { name: "Начать" }) ?? screen.getByRole("button", { name: "Позже" });
      fireEvent.click(go);
      await screen.findByRole("heading", { name: title });
    }
    expect(await violations()).toEqual([]);
  });
});
