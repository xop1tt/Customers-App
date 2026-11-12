// «Коннекторы» без встроенных сервисов и чат «Ai» в демо-режиме: настройка, проверка, разговор с моделью и подтверждения.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubDemo } from "../api/mock";
import { askAi, clearChat } from "../state/ai";
import { loadHub, saveAi } from "../state/hub";
import { getState, setState } from "../state/store";
import { App } from "./App";

afterEach(cleanup);
beforeEach(async () => { hubDemo.reset(); clearChat(); setState({ aiOpen: false }); await loadHub(); });

const SLACK = "https://hooks.slack.com/services/T0/B0/xyz";

async function ready() {
  render(<App />);
  await screen.findByLabelText("Навигация");
}

describe("коннекторы: встроенных нет", () => {
  it("каталог без облака пуст и предлагает войти; Slack, Telegram и прочие из приложения убраны", async () => {
    await ready();
    act(() => setState({ market: "catalog" }));
    const dlg = await screen.findByRole("dialog", { name: "Коннекторы" });
    expect(within(dlg).getByText("Коннекторы доступны в облачной учётной записи")).toBeInTheDocument();
    for (const name of ["Slack", "Telegram", "Discord", "Microsoft Teams", "Notion", "Битрикс24"]) expect(within(dlg).queryByText(name)).toBeNull();
    expect(within(dlg).queryByRole("list", { name: "Встроенные интеграции" })).toBeNull();
    expect(within(dlg).getByRole("button", { name: "На проверке" })).toBeInTheDocument();
  });

  it("старые настройки мессенджеров стираются при первом сохранении настроек Ai", async () => {
    hubDemo.blob = { integrations: { slack: { enabled: true, webhook: SLACK, events: [] } } };
    await loadHub();
    await saveAi({ mode: "safe" });
    expect(JSON.stringify(hubDemo.blob)).not.toContain("hooks.slack.com");
    expect(hubDemo.blob).toMatchObject({ ai: { mode: "safe" } });
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

  it("инструмента отправки сообщений в мессенджеры у помощника больше нет", async () => {
    await openChat("safe");
    const seen: string[] = [];
    hubDemo.reply = (body) => {
      const last = body.messages.at(-1)!;
      if (last.role === "tool") { seen.push(String(last.content)); return { choices: [{ message: { role: "assistant", content: "Не получилось." } }] }; }
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "x", function: { name: "send_message", arguments: JSON.stringify({ service: "slack", text: "привет" }) } }] } }] };
    };
    await send("Напиши в Slack привет");
    expect(await screen.findByText("Не получилось.")).toBeInTheDocument();
    expect(seen[0]).toContain("недоступен");
    expect(screen.queryByRole("button", { name: "Выполнить" })).toBeNull();
  });
});
