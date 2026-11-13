// Чат Ai как выдвижная панель: кнопка в рейке, растягивание, вложения, изменение событий и назначение ответственных с проверкой прав.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { hubDemo } from "../api/mock";
import { addWsMockMember, resetWsMock, setWsMockRole } from "../api/wsMock";
import { askAi, clearChat } from "../state/ai";
import { loadHub, saveAi } from "../state/hub";
import { getState, refreshWorkspace, setState } from "../state/store";
import { App } from "./App";

afterEach(cleanup);
beforeEach(async () => { resetWsMock(); hubDemo.reset(); clearChat(); setState({ aiOpen: false }); await loadHub(); });

type Body = { messages: { role: string; content?: unknown }[] };
const rail = () => screen.getByRole("navigation", { name: "Модули" });

async function ready() {
  render(<App />);
  await screen.findByLabelText("Навигация");
  await waitFor(() => expect(getState().ws).not.toBeNull());
}
const openAi = () => fireEvent.click(within(rail()).getByRole("button", { name: "Ai" }));
async function connect(extra: Record<string, unknown> = {}) {
  await saveAi({ enabled: true, model: "demo-model-7b", mode: "safe", ...extra });
}
const script = (calls: { name: string; args: unknown }[], final = "Готово.") => {
  hubDemo.reply = (body: Body) => {
    const last = body.messages.at(-1)!;
    if (last.role === "tool") return { choices: [{ message: { role: "assistant", content: final } }] };
    return { choices: [{ message: { role: "assistant", content: null, tool_calls: calls.map((c, i) => ({ id: `c${i}`, function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] };
  };
};
const run = async (text: string) => {
  const p = askAi(text);
  const ok = await screen.findByRole("button", { name: "Выполнить" }).catch(() => null);
  if (ok) fireEvent.click(ok);
  await act(async () => { await p; });
};

describe("выдвижной чат Ai", () => {
  it("открывается кнопкой над рейкой, остаётся при смене вкладки и закрывается кнопкой и Escape", async () => {
    await connect();
    await ready();
    expect(screen.queryByRole("complementary", { name: "Чат Ai" })).toBeNull();
    openAi();
    const drawer = await screen.findByRole("complementary", { name: "Чат Ai" });
    expect(within(rail()).getByRole("button", { name: "Ai" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(within(rail()).getByRole("button", { name: /^Команда/ }));
    await waitFor(() => expect(getState().section).toBe("people"));
    fireEvent.click(within(rail()).getByRole("button", { name: /^Чат/ }));
    await waitFor(() => expect(getState().chatPopup).toBe(true));
    expect(screen.getByRole("complementary", { name: "Чат Ai" })).toBe(drawer);
    fireEvent.click(within(drawer).getByRole("button", { name: "Закрыть чат" }));
    expect(screen.queryByRole("complementary", { name: "Чат Ai" })).toBeNull();
    openAi();
    fireEvent.keyDown(await screen.findByLabelText("Сообщение помощнику"), { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Чат Ai" })).toBeNull();
  });

  it("растягивается за края (в том числе клавишами) и держится в пределах окна", async () => {
    await connect();
    await ready();
    openAi();
    const drawer = await screen.findByRole("complementary", { name: "Чат Ai" });
    const w0 = parseInt(drawer.style.width, 10);
    const h0 = parseInt(drawer.style.height, 10);
    fireEvent.keyDown(within(drawer).getByRole("separator", { name: "Ширина чата" }), { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(within(drawer).getByRole("separator", { name: "Высота чата" }), { key: "ArrowUp" });
    expect(parseInt(drawer.style.width, 10)).toBe(w0 + 60);
    expect(parseInt(drawer.style.height, 10)).toBe(h0 + 20);
    for (let i = 0; i < 80; i++) fireEvent.keyDown(within(drawer).getByRole("separator", { name: "Ширина чата" }), { key: "ArrowRight", shiftKey: true });
    expect(parseInt(drawer.style.width, 10)).toBeLessThanOrEqual(window.innerWidth - 64 - 16);
  });

  it("маленькая кнопка настроек в чате открывает настройки Ai; без модели чат предлагает их открыть", async () => {
    await ready();
    openAi();
    const drawer = await screen.findByRole("complementary", { name: "Чат Ai" });
    expect(within(drawer).getByText("Подключите локальную модель")).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Настройки Ai" }));
    const settings = await screen.findByRole("dialog", { name: "Настройки" });
    expect(await within(settings).findByLabelText("Адрес сервера модели")).toBeInTheDocument();
  });
});

describe("вложения", () => {
  const file = (name: string, type: string, body: string | Uint8Array) => new File([body as BlobPart], name, { type });
  const attach = (...files: File[]) => fireEvent.change(screen.getByLabelText("Выбрать файлы"), { target: { files } });
  const send = (text: string) => {
    fireEvent.change(screen.getByLabelText("Сообщение помощнику"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
  };

  it("текстовый файл уходит модели с любой моделью, и это данные, а не указания", async () => {
    await connect();
    await ready();
    openAi();
    await screen.findByLabelText("Сообщение помощнику");
    let seen: Body | null = null;
    hubDemo.reply = (b: Body) => { seen = b; return { choices: [{ message: { role: "assistant", content: "Прочитал." } }] }; };
    attach(file("клиенты.csv", "text/csv", "Имя;Телефон\nИван;+7 900 000-00-00"));
    expect(await screen.findByRole("list", { name: "Вложения" })).toHaveTextContent("клиенты.csv");
    send("Что в файле?");
    expect(await screen.findByText("Прочитал.")).toBeInTheDocument();
    const user = seen!.messages.find((m) => m.role === "user")!;
    expect(JSON.stringify(user.content)).toContain("Иван;+7 900");
    expect(JSON.stringify(user.content)).toContain("не указания");
    expect(screen.queryByRole("list", { name: "Вложения" })).toBeNull();
  });

  it("картинка не прикладывается, пока в настройках не указано, что модель их понимает; потом уходит как image_url", async () => {
    await connect();
    await ready();
    openAi();
    await screen.findByLabelText("Сообщение помощнику");
    attach(file("схема.png", "image/png", new Uint8Array([137, 80, 78, 71])));
    expect(await screen.findByText(/не отмечена как понимающая изображения/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Вложения" })).toBeNull();
    await act(async () => { await saveAi({ vision: true }); });
    let seen: Body | null = null;
    hubDemo.reply = (b: Body) => { seen = b; return { choices: [{ message: { role: "assistant", content: "Вижу схему." } }] }; };
    attach(file("схема.png", "image/png", new Uint8Array([137, 80, 78, 71])));
    expect(await screen.findByRole("list", { name: "Вложения" })).toHaveTextContent("схема.png");
    send("Что на картинке?");
    expect(await screen.findByText("Вижу схему.")).toBeInTheDocument();
    const parts = seen!.messages.find((m) => m.role === "user")!.content as { type: string; image_url?: { url: string } }[];
    expect(parts.find((p) => p.type === "image_url")?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  });

  it("неподдерживаемый формат отклоняется с понятным объяснением", async () => {
    await connect({ vision: true });
    await ready();
    openAi();
    await screen.findByLabelText("Сообщение помощнику");
    attach(file("договор.pdf", "application/pdf", "%PDF"));
    expect(await screen.findByText(/такой формат модели не передать/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Вложения" })).toBeNull();
  });
});

describe("изменение событий и ответственные по запросу", () => {
  async function seed() {
    const task = await api.wsSave("tasks", null, { title: "Позвонить", due_at: "2026-11-20T10:00:00.000Z" });
    const act1 = await api.wsSave("activities", null, { type: "meeting", summary: "Встреча", occurred_at: "2026-11-21T10:00:00.000Z", entity_type: "company", entity_id: (await api.wsList("companies")).items[0]!.id, payload: {} });
    return { task, act1 };
  }

  it("изменяет задачу и событие (название, время, статус) после подтверждения", async () => {
    await connect({ mode: "writes" });
    await ready();
    openAi();
    await screen.findByLabelText("Сообщение помощнику");
    const { task, act1 } = await seed();
    script([
      { name: "update_event", args: { entity: "task", id: task.id, title: "Позвонить Ивану", at: "2026-11-22T09:00:00Z", status: "in_progress" } },
      { name: "update_event", args: { entity: "activity", id: act1.id, title: "Встреча в офисе", at: "2026-11-23T12:00:00Z" } },
    ]);
    const p = askAi("Перенеси");
    for (const what of [/Изменить задачу/, /Изменить событие/]) {
      const card = await screen.findByRole("group", { name: what });
      fireEvent.click(await within(card).findByRole("button", { name: "Выполнить" }));
      await waitFor(() => expect(within(card).getByText(/Выполнено/)).toBeInTheDocument());
    }
    await act(async () => { await p; });
    const t = (await api.wsCard("tasks", task.id)).record;
    expect(t).toMatchObject({ title: "Позвонить Ивану", status: "in_progress", due_at: "2026-11-22T09:00:00.000Z" });
    expect((await api.wsCard("activities", act1.id)).record).toMatchObject({ summary: "Встреча в офисе", occurred_at: "2026-11-23T12:00:00.000Z" });
  });

  it("без прав менять записи изменение события отклоняется, данные не меняются", async () => {
    await connect();
    await ready();
    const { task } = await seed();
    setWsMockRole("viewer");
    await act(async () => { await refreshWorkspace(); });
    openAi();
    await screen.findByLabelText("Сообщение помощнику");
    const seen: string[] = [];
    hubDemo.reply = (body: Body) => {
      const last = body.messages.at(-1)!;
      if (last.role === "tool") { seen.push(String(last.content)); return { choices: [{ message: { role: "assistant", content: "Не получилось." } }] }; }
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "x", function: { name: "update_event", arguments: JSON.stringify({ entity: "task", id: task.id, title: "Взлом" }) } }] } }] };
    };
    await run("Переименуй задачу");
    expect(seen[0]).toContain("Отказано");
    expect((await api.wsCard("tasks", task.id)).record.title).toBe("Позвонить");
  });

  it("назначает и снимает ответственного по имени; чужие и неоднозначные имена не угадывает", async () => {
    await connect();
    await ready();
    const { task } = await seed();
    const company = (await api.wsList("companies")).items[0]!;
    const gleb = addWsMockMember("Глеб Орлов");
    addWsMockMember("Глеб Новиков");
    await act(async () => { await refreshWorkspace(); });
    const results: string[] = [];
    const step = (args: Record<string, unknown>) => {
      hubDemo.reply = (body: Body) => {
        const last = body.messages.at(-1)!;
        if (last.role === "tool") { results.push(String(last.content)); return { choices: [{ message: { role: "assistant", content: "ок" } }] }; }
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "s", function: { name: "set_responsible", arguments: JSON.stringify(args) } }] } }] };
      };
    };
    openAi();
    await screen.findByLabelText("Сообщение помощнику");
    step({ entity: "task", id: task.id, member: "Глеб" });
    await run("назначь");
    expect(results.at(-1)).toContain("несколько сотрудников");
    step({ entity: "task", id: task.id, member: "Глеб Орлов" });
    await run("назначь");
    expect((await api.wsCard("tasks", task.id)).record.assignee_id).toBe(gleb);
    step({ entity: "company", id: company.id, member: gleb });
    await run("назначь");
    expect((await api.wsCard("companies", company.id)).record.owner_id).toBe(gleb);
    step({ entity: "task", id: task.id, unassign: true });
    await run("сними");
    expect((await api.wsCard("tasks", task.id)).record.assignee_id).toBeNull();
  });

  it("сотрудник с правом только на свои записи не может назначать и снимать ответственных", async () => {
    await connect();
    await ready();
    const { task } = await seed();
    const other = addWsMockMember("Глеб Орлов");
    await api.wsSave("tasks", task.id, { assignee_id: other });
    setWsMockRole("employee");
    await act(async () => { await refreshWorkspace(); });
    const seen: string[] = [];
    hubDemo.reply = (body: Body) => {
      const last = body.messages.at(-1)!;
      if (last.role === "tool") { seen.push(String(last.content)); return { choices: [{ message: { role: "assistant", content: "Нельзя." } }] }; }
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "u", function: { name: "set_responsible", arguments: JSON.stringify({ entity: "task", id: task.id, unassign: true }) } }] } }] };
    };
    openAi();
    await screen.findByLabelText("Сообщение помощнику");
    await run("сними ответственного");
    expect(seen[0]).toContain("Отказано");
    expect((await api.wsCard("tasks", task.id)).record.assignee_id).toBe(other);
  });
});

describe("уведомления Ai", () => {
  const focus = (v: boolean) => vi.spyOn(document, "hasFocus").mockReturnValue(v);
  afterEach(() => vi.restoreAllMocks());

  it("окно не на виду: системное уведомление, когда модель закончила и когда ждёт подтверждения", async () => {
    await connect({ mode: "writes" });
    await ready();
    focus(false);
    hubDemo.reply = () => ({ choices: [{ message: { role: "assistant", content: "Всё сделал." } }] });
    await act(async () => { await askAi("привет"); });
    expect(hubDemo.notified).toEqual([{ title: "Ai закончил", body: "Всё сделал." }]);

    hubDemo.notified = [];
    script([{ name: "create_task", args: { title: "Позвонить" } }], "Готово.");
    const p = askAi("создай задачу");
    openAi();
    await screen.findByRole("button", { name: "Выполнить" });
    expect(hubDemo.notified[0]).toMatchObject({ title: "Ai ждёт ответа" });
    expect(hubDemo.notified[0]!.body).toContain("Создать задачу");
    fireEvent.click(screen.getByRole("button", { name: "Выполнить" }));
    await act(async () => { await p; });
    expect(hubDemo.notified.at(-1)).toMatchObject({ title: "Ai закончил", body: "Готово." });
  });

  it("окно в фокусе и чат закрыт — подсказка; чат открыт перед вами — тишина", async () => {
    await connect();
    await ready();
    focus(true);
    hubDemo.reply = () => ({ choices: [{ message: { role: "assistant", content: "Готов." } }] });
    await act(async () => { await askAi("раз"); });
    expect(await screen.findByText("Ai закончил: Готов.")).toBeInTheDocument();
    expect(hubDemo.notified).toHaveLength(0);
    openAi();
    await screen.findByLabelText("Сообщение помощнику");
    await act(async () => { await askAi("два"); });
    expect(screen.queryAllByText("Ai закончил: Готов.")).toHaveLength(1);
    expect(hubDemo.notified).toHaveLength(0);
  });

  it("настройка «Уведомлять об Ai» выключает все уведомления", async () => {
    await connect({ notify: false });
    await ready();
    focus(false);
    await act(async () => { await askAi("привет"); });
    expect(hubDemo.notified).toHaveLength(0);
    act(() => setState({ settings: "ai", settingsSub: "access" }));
    const settings = await screen.findByRole("dialog", { name: "Настройки" });
    const sw = await within(settings).findByRole("switch", { name: "Уведомлять, когда модель закончила или требует ответа" });
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(JSON.stringify(hubDemo.blob)).toContain("\"notify\":true"));
  });
});
