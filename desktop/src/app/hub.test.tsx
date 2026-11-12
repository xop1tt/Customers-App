// «Интеграции» (встроенный каталог) и чат «Ai» в демо-режиме: установка, настройка, проверка, разговор с моделью и подтверждения.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubDemo } from "../api/mock";
import { askAi, clearChat } from "../state/ai";
import { loadHub, notifyEvent, saveAi } from "../state/hub";
import { getState, setState } from "../state/store";
import { App } from "./App";

afterEach(cleanup);
beforeEach(async () => { hubDemo.reset(); clearChat(); setState({ aiOpen: false }); await loadHub(); });

const SLACK = "https://hooks.slack.com/services/T0/B0/xyz";

async function confirm(label: string) {
  await waitFor(() => expect(document.querySelectorAll(".dialog").length).toBeGreaterThan(0));
  const dlgs = document.querySelectorAll<HTMLElement>(".dialog");
  fireEvent.click(within(dlgs[dlgs.length - 1]!).getByRole("button", { name: label }));
}

async function ready() {
  render(<App />);
  await screen.findByLabelText("Навигация");
}

describe("интеграции", () => {
  it("каталог работает без облака: карточки с описанием и кнопкой «Установить»", async () => {
    await ready();
    act(() => setState({ market: "catalog" }));
    const dlg = await screen.findByRole("dialog", { name: "Интеграции" });
    const grid = await within(dlg).findByRole("list", { name: "Встроенные интеграции" });
    for (const name of ["Slack", "Telegram", "Discord", "Microsoft Teams", "Notion", "Битрикс24"]) expect(within(grid).getByText(name)).toBeInTheDocument();
    expect(within(grid).getByText("Сообщения о новых лидах и сделках в канал Slack")).toBeInTheDocument();
    expect(within(dlg).getByText(/ставятся в облачное рабочее пространство/)).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Поиск интеграций"), { target: { value: "notion" } });
    await waitFor(() => expect(within(dlg).queryByText("Slack")).toBeNull());
    expect(within(dlg).getByText("Notion")).toBeInTheDocument();
  });

  it("Slack: установка, адрес, проверка, события и сообщение о завершённом поиске", async () => {
    await ready();
    act(() => setState({ market: "catalog" }));
    const dlg = await screen.findByRole("dialog", { name: "Интеграции" });
    fireEvent.click(await within(dlg).findByRole("button", { name: "Установить Slack" }));
    await confirm("Установить");
    // Открылась страница интеграции с описанием, версией и датой.
    expect(await within(dlg).findByRole("heading", { name: "Slack" })).toBeInTheDocument();
    expect(within(dlg).getByText(/версия 1\.0\.0/)).toBeInTheDocument();
    expect(within(dlg).getByText(/Обновлена/)).toBeInTheDocument();
    expect(within(dlg).getByText("Что добавляет")).toBeInTheDocument();
    expect(within(dlg).getByText("Нужна настройка")).toBeInTheDocument();
    const test = within(dlg).getByRole("button", { name: "Проверить" });
    expect(test).toBeDisabled();
    fireEvent.change(within(dlg).getByLabelText("Адрес вебхука"), { target: { value: SLACK } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(hubDemo.sent).toHaveLength(1));
    expect(hubDemo.sent[0]).toMatchObject({ service: "slack" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(within(dlg).getByText("Установлена")).toBeInTheDocument());
    expect(JSON.stringify(hubDemo.blob)).toContain(SLACK);

    await notifyEvent("search.finished", "Customers: найдено 3 новых лида");
    expect(hubDemo.sent.at(-1)).toEqual({ service: "slack", text: "Customers: найдено 3 новых лида" });

    // Событие выключено — сообщение не уходит; выключенная интеграция молчит.
    fireEvent.click(within(dlg).getByRole("checkbox", { name: /Поиск клиентов завершён/ }));
    await waitFor(() => expect(JSON.stringify(hubDemo.blob)).not.toContain("search.finished"));
    const before = hubDemo.sent.length;
    await notifyEvent("search.finished", "ещё");
    expect(hubDemo.sent).toHaveLength(before);
  });

  it("удаление интеграции стирает данные доступа", async () => {
    await ready();
    act(() => setState({ market: "catalog" }));
    const dlg = await screen.findByRole("dialog", { name: "Интеграции" });
    fireEvent.click(await within(dlg).findByRole("button", { name: "Установить Discord" }));
    await confirm("Установить");
    fireEvent.change(await within(dlg).findByLabelText("Адрес вебхука"), { target: { value: "https://discord.com/api/webhooks/1/a" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(JSON.stringify(hubDemo.blob)).toContain("discord.com"));
    fireEvent.click(within(dlg).getByRole("button", { name: "Удалить" }));
    await confirm("Удалить");
    await waitFor(() => expect(JSON.stringify(hubDemo.blob)).not.toContain("discord.com"));
  });
});

describe("чат Ai", () => {
  it("кнопка «Ai» есть в левой рейке; без модели предлагает подключить её в настройках", async () => {
    await ready();
    const rail = screen.getByRole("navigation", { name: "Модули" });
    fireEvent.click(within(rail).getByRole("button", { name: "Ai" }));
    expect(await screen.findByText("Подключите локальную модель")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Открыть настройки Ai" }));
    const settings = await screen.findByRole("dialog", { name: "Настройки" });
    expect(await within(settings).findByLabelText("Адрес сервера модели")).toHaveValue("http://localhost:1234/v1");
  });

  it("настройки: проверка сервера подгружает модели и выбирает первую", async () => {
    await ready();
    act(() => setState({ settings: "ai", settingsSub: null }));
    const settings = await screen.findByRole("dialog", { name: "Настройки" });
    fireEvent.click(await within(settings).findByRole("button", { name: "Проверить и загрузить модели" }));
    await waitFor(() => expect(within(settings).getByText(/Моделей: 2/)).toBeInTheDocument());
    await waitFor(() => expect(JSON.stringify(hubDemo.blob)).toContain("demo-model-7b"));
    fireEvent.change(within(settings).getByLabelText("Адрес сервера модели"), { target: { value: "http://offline:1234/v1" } });
    fireEvent.click(within(settings).getByRole("button", { name: "Проверить и загрузить модели" }));
    expect(await within(settings).findByText(/Сервер модели недоступен/)).toBeInTheDocument();
  });

  async function openChat(mode: "writes" | "all" | "safe") {
    await saveAi({ enabled: true, model: "demo-model-7b", mode });
    await ready();
    const rail = screen.getByRole("navigation", { name: "Модули" });
    fireEvent.click(within(rail).getByRole("button", { name: "Ai" }));
    return screen.findByRole("log", { name: "Разговор с помощником" });
  }
  const script = (calls: { name: string; args: unknown }[], final: string) => {
    hubDemo.reply = (body) => {
      const last = body.messages.at(-1)!;
      if (last.role === "tool") return { choices: [{ message: { role: "assistant", content: final } }] };
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: calls.map((c, i) => ({ id: `c${i}`, function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] };
    };
  };
  const send = async (text: string) => {
    fireEvent.change(screen.getByLabelText("Сообщение помощнику"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
  };

  it("чтение выполняется сразу, а правка ждёт «Выполнить»", async () => {
    await openChat("writes");
    const id = getState().snap.leads[0]!.id;
    script([{ name: "get_overview", args: {} }, { name: "set_favorite", args: { ids: [id], on: true } }], "Готово, добавил в избранное.");
    await send("Добавь первый лид в избранное");
    const card = await screen.findByRole("group", { name: "Действие: В избранное: лидов 1" });
    expect(within(card).getByRole("button", { name: "Отклонить" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Действие: Прочитать сводку" })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Выполнить" }));
    expect(await screen.findByText("Готово, добавил в избранное.")).toBeInTheDocument();
    expect(within(card).getByText(/Выполнено/)).toBeInTheDocument();
  });

  it("отклонённое действие не выполняется, модель получает отказ", async () => {
    await openChat("writes");
    const seen: string[] = [];
    hubDemo.reply = (body) => {
      const last = body.messages.at(-1)!;
      if (last.role === "tool") { seen.push(String(last.content)); return { choices: [{ message: { role: "assistant", content: "Хорошо, не буду." } }] }; }
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "x", function: { name: "set_setting", arguments: JSON.stringify({ key: "theme", value: "light" }) } }] } }] };
    };
    const before = getState().device.theme;
    await send("Включи светлую тему");
    fireEvent.click(await screen.findByRole("button", { name: "Отклонить" }));
    expect(await screen.findByText("Хорошо, не буду.")).toBeInTheDocument();
    expect(seen[0]).toContain("отклонил");
    expect(getState().device.theme).toBe(before);
  });

  it("удаление спрашивает даже в режиме «Безопасное — без вопросов», а безопасное выполняется молча", async () => {
    await openChat("safe");
    const id = getState().snap.leads[0]!.id;
    const count = getState().snap.leads.length;
    script([{ name: "set_setting", args: { key: "compactRows", value: true } }, { name: "delete_leads", args: { ids: [id] } }], "Не стал удалять.");
    await send("Включи компактный вид и удали первый лид");
    const del = await screen.findByRole("group", { name: "Действие: УДАЛИТЬ лидов: 1" });
    expect(within(del).getByText("Удаление")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Настройка «compactRows»/ })).toHaveTextContent("Выполнено");
    expect(getState().device.compactRows).toBe(true);
    fireEvent.click(within(del).getByRole("button", { name: "Отклонить" }));
    expect(await screen.findByText("Не стал удалять.")).toBeInTheDocument();
    expect(getState().snap.leads).toHaveLength(count);
  });

  it("запрещённая в настройках группа недоступна модели, неверные аргументы возвращаются ей как ошибка", async () => {
    await saveAi({ allow: ["read"] });
    await openChat("all");
    await saveAi({ allow: ["read"] });
    const seen: string[] = [];
    hubDemo.reply = (body) => {
      const last = body.messages.at(-1)!;
      if (last.role === "tool") { seen.push(String(last.content)); return { choices: [{ message: { role: "assistant", content: "ок" } }] }; }
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "x", function: { name: "delete_leads", arguments: "{}" } }] } }] };
    };
    await act(async () => { await askAi("удали всё"); });
    expect(seen[0]).toContain("недоступен");
    expect(screen.queryByRole("button", { name: "Выполнить" })).toBeNull();
  });

  it("сообщение в Slack без подключённой интеграции не отправляется", async () => {
    await openChat("safe");
    script([{ name: "send_message", args: { service: "slack", text: "привет" } }], "Slack не подключён.");
    await send("Напиши в Slack привет");
    expect(await screen.findByText("Slack не подключён.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Выполнить" })).toBeNull();
    expect(hubDemo.sent).toHaveLength(0);
  });
});
