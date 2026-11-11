// Сотрудники, профили, чат и уведомления в демо-режиме облачного Workspace (?team).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { window.history.replaceState({}, "", "/?team"); });

import { resetChatMock } from "../../api/chatMock";
import { resetWsMock } from "../../api/wsMock";
import { getState } from "../../state/store";
import { App } from "../App";

afterEach(cleanup);
beforeEach(() => { resetWsMock(); resetChatMock(); });

async function nav() {
  render(<App />);
  const n = await screen.findByLabelText("Навигация");
  // Бейдж непрочитанного появляется после первого опроса.
  await waitFor(() => expect(getState().chat?.available).toBe(true));
  // Группа «Команда» — в модуле «Команда» рейки (C2).
  fireEvent.click(within(screen.getByRole("navigation", { name: "Модули" })).getByRole("button", { name: /^Команда/ }));
  await within(n).findByRole("button", { name: /Сотрудники/ });
  return n;
}

describe("команда в левой панели", () => {
  it("«Сообщения» — отдельный модуль рейки с числом непрочитанных; в группе «Команда» уведомления, группа сворачивается", async () => {
    const n = await nav();
    const rail = within(screen.getByRole("navigation", { name: "Модули" }));
    await waitFor(() => expect(rail.getByRole("button", { name: "Сообщения, новых: 3" })).toBeInTheDocument());
    expect(Array.from(n.querySelectorAll(".side-scroll .nav-item")).some((b) => /Сообщения/.test(b.textContent ?? ""))).toBe(false);
    expect(within(within(n).getByRole("button", { name: /Уведомления/ })).getByLabelText("Непрочитанных: 2")).toBeInTheDocument();
    fireEvent.click(within(n).getByRole("button", { name: "Команда" }));
    // В свёрнутой группе остаётся только открытый раздел («Сотрудники»).
    await waitFor(() => expect(within(n).queryByRole("button", { name: /Уведомления/ })).toBeNull());
    fireEvent.click(within(n).getByRole("button", { name: "Команда" }));
    expect(await within(n).findByRole("button", { name: /Уведомления/ })).toBeInTheDocument();
  });
});

describe("сотрудники и профили", () => {
  it("список, структура и профиль коллеги с кнопкой «Отправить сообщение»", async () => {
    const n = await nav();
    fireEvent.click(within(n).getByRole("button", { name: /Сотрудники/ }));
    const list = await screen.findByRole("list", { name: "Сотрудники" });
    expect(within(list).getByText("Борис Петров")).toBeInTheDocument();
    expect(within(list).getAllByLabelText("В сети").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "Структура" }));
    const tree = await screen.findByRole("list", { name: "Структура" });
    const rows = within(tree).getAllByRole("listitem").map((li) => li.textContent ?? "");
    // Борис — глава, под ним вы, под вами Вера и Глеб.
    expect(rows.findIndex((t) => t.includes("Борис"))).toBeLessThan(rows.findIndex((t) => t.includes("Вера")));
    expect(within(tree).getByText("подчинённых: 2")).toBeInTheDocument();

    fireEvent.click(within(tree).getByText("Вера Ким"));
    expect(await screen.findByRole("heading", { name: "Вера Ким" })).toBeInTheDocument();
    expect(screen.getByText("Менеджер по продажам · Продажи")).toBeInTheDocument();
    expect(screen.getByText("vera@example.com")).toBeInTheDocument();
    expect(screen.getByText(/с 1 февраля 2023/)).toBeInTheDocument();
    // Руководитель — ссылка на профиль.
    const facts = screen.getByText("Руководитель").closest(".profile-fact") as HTMLElement;
    expect(within(facts).getByRole("button", { name: /anna|Анна/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Отправить сообщение" }));
    await waitFor(() => expect(getState().section).toBe("chat"));
    expect(await screen.findByRole("heading", { name: "Вера Ким" })).toBeInTheDocument();
  });

  it("руководитель меняет карточку подчинённого; круг руководителей не предлагается", async () => {
    const n = await nav();
    fireEvent.click(within(n).getByRole("button", { name: /Сотрудники/ }));
    fireEvent.click(await screen.findByText("Глеб Орлов"));
    fireEvent.click(await screen.findByRole("button", { name: "Изменить карточку" }));
    const dialog = await screen.findByRole("dialog", { name: /Карточка: Глеб Орлов/ });
    const title = within(dialog).getByPlaceholderText("Например, менеджер по продажам");
    fireEvent.change(title, { target: { value: "Старший менеджер" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Старший менеджер · Продажи")).toBeInTheDocument();
  });

  it("свой профиль открывается из меню и ведёт в настройки", async () => {
    await nav();
    fireEvent.click(screen.getByLabelText("Учётная запись"));
    fireEvent.click(await screen.findByText("Профиль", { selector: ".menu-item" }));
    expect(await screen.findByText("Руководитель группы · Продажи")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Отправить сообщение" })).toBeNull();
    expect(screen.getByRole("button", { name: "Изменить профиль" })).toBeInTheDocument();
  });
});

describe("сообщения", () => {
  it("лента, отправка с @упоминанием из подсказки, непрочитанное сбрасывается", async () => {
    await nav();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Модули" })).getByRole("button", { name: /^Сообщения/ }));
    const items = await screen.findByRole("complementary", { name: "Обсуждения" });
    fireEvent.click(await within(items).findByText("Отдел продаж"));
    expect(await screen.findByText(/подскажи, где шаблон договора/)).toBeInTheDocument();
    expect(screen.getByText(`@${getState().session?.displayName}`).className).toContain("mention");

    const box = screen.getByLabelText("Сообщение") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Шаблон в папке, @Ве", selectionStart: 19 } });
    box.setSelectionRange(19, 19);
    fireEvent.change(box, { target: { value: "Шаблон в папке, @Ве" } });
    const opt = await screen.findByRole("option", { name: /Вера Ким/ });
    fireEvent.mouseDown(opt);
    await waitFor(() => expect(box.value).toBe("Шаблон в папке, @Вера Ким "));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("Вы")).toBeInTheDocument();
    await waitFor(() => expect(box.value).toBe(""));
    const mine = screen.getAllByText("@Вера Ким").at(-1)!;
    expect(mine.className).toContain("mention");
  });

  it("карточка CRM в сообщении: выбор, отправка без текста и переход к карточке", async () => {
    await nav();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Модули" })).getByRole("button", { name: /^Сообщения/ }));
    const items = await screen.findByRole("complementary", { name: "Обсуждения" });
    fireEvent.click(await within(items).findByText("Отдел продаж"));
    await screen.findByText(/подскажи, где шаблон договора/);
    fireEvent.click(screen.getByRole("button", { name: "Прикрепить карточку CRM" }));
    const dlg = await screen.findByRole("dialog", { name: "Прикрепить карточку" });
    fireEvent.click(within(dlg).getByRole("tab", { name: "Компании" }));
    const list = await within(dlg).findByRole("list", { name: "Карточки" });
    const first = within(list).getAllByRole("button")[0]!;
    const name = first.textContent!.replace("🏢", "").trim();
    fireEvent.click(first);
    const pending = await screen.findByLabelText("Карточки в сообщении");
    expect(within(pending).getByText(name.split(/\s{2,}/)[0]!, { exact: false })).toBeInTheDocument();
    // Без текста: отправляется одна карточка.
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(screen.queryByLabelText("Карточки в сообщении")).toBeNull());
    const sent = (await screen.findAllByRole("button", { name: /Компания/ })).at(-1)!;
    expect(sent.className).toContain("chat-card");
    fireEvent.click(sent);
    await waitFor(() => expect(getState().record?.table).toBe("companies"));
  });

  it("новое групповое обсуждение с участниками, участники добавляют коллег", async () => {
    await nav();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Модули" })).getByRole("button", { name: /^Сообщения/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Новое сообщение или обсуждение" }));
    fireEvent.click(await screen.findByText("Групповое обсуждение"));
    const dialog = await screen.findByRole("dialog", { name: "Новое обсуждение" });
    fireEvent.change(within(dialog).getByPlaceholderText(/Например, Сделка/), { target: { value: "Сделка «Зерно»" } });
    fireEvent.click(within(dialog).getByText("Вера Ким"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Создать" }));
    expect(await screen.findByRole("heading", { name: "Сделка «Зерно»" })).toBeInTheDocument();
    expect((await screen.findAllByText(/создаёт обсуждение «Сделка «Зерно»»/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Участники" }));
    const members = await screen.findByRole("dialog", { name: "Участники и настройки" });
    expect(within(members).getByText("Владелец")).toBeInTheDocument();
    fireEvent.click(within(members).getByRole("button", { name: "Добавить участников" }));
    const pick = await screen.findByRole("dialog", { name: "Добавить в обсуждение" });
    fireEvent.click(within(pick).getByText("Глеб Орлов"));
    await waitFor(() => expect(within(members).getByText("Глеб Орлов")).toBeInTheDocument());
  });
});

describe("уведомления", () => {
  it("список упоминаний, переход к обсуждению отмечает прочитанным", async () => {
    const n = await nav();
    fireEvent.click(within(n).getByRole("button", { name: /Уведомления/ }));
    const list = await screen.findByRole("list", { name: "Уведомления" });
    expect(within(list).getByText("Глеб Орлов упоминает вас в заметке")).toBeInTheDocument();
    fireEvent.click(within(list).getByText("Вера Ким упоминает вас в обсуждении"));
    await waitFor(() => expect(getState().section).toBe("chat"));
    await waitFor(() => expect(getState().chat?.notifications.find((x) => x.kind === "mention")?.read).toBe(true));
  });
});
