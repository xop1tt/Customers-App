// Чат: ответ на сообщение, меню чужих и своих сообщений, вложения кнопками, файлы (ADR-087).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { window.history.replaceState({}, "", "/?team"); });

import { resetChatMock } from "../../api/chatMock";
import { resetWsMock } from "../../api/wsMock";
import { parseReply, replyLine } from "../../lib/team";
import { getState, setState } from "../../state/store";
import { App } from "../App";

afterEach(cleanup);
beforeEach(() => { resetWsMock(); resetChatMock(); setState({ section: "home", record: null, chatPopup: false, bellOpen: false }); });

async function openGroup() {
  render(<App />);
  await screen.findByLabelText("Навигация");
  await waitFor(() => expect(getState().chat?.available).toBe(true));
  fireEvent.click(within(screen.getByRole("navigation", { name: "Модули" })).getByRole("button", { name: /^Чат/ }));
  const items = await screen.findByRole("complementary", { name: "Обсуждения" });
  fireEvent.click(await within(items).findByText("Отдел продаж"));
  return screen.findByText(/в пятницу планёрка/);
}
const menuLabels = () => screen.getAllByRole("menuitem").map((i) => i.textContent);

describe("формат ответа", () => {
  it("цитата первой строкой, обрезается и не вкладывается", () => {
    const line = replyLine("Борис", "Привет\nкак дела?");
    expect(line).toBe("↪ Борис: Привет как дела?");
    expect(parseReply(`${line}\nОтлично`)).toMatchObject({ quote: { name: "Борис", text: "Привет как дела?" }, rest: "Отлично" });
    expect(replyLine("Вера", `${line}\nответ`)).toBe("↪ Вера: ответ");
    expect(replyLine("А", "x".repeat(300)).length).toBeLessThan(160);
    expect(parseReply("обычный текст")).toMatchObject({ quote: null, rest: "обычный текст" });
  });
});

describe("сообщения чата", () => {
  it("у чужого сообщения только «Ответить» и «Скопировать»", async () => {
    const msg = await openGroup();
    fireEvent.contextMenu(msg);
    expect(menuLabels()).toEqual(["Ответить", "Скопировать"]);
  });

  it("ответ: над полем ввода имя и текст, в ленте у отправленного сообщения видна цитата", async () => {
    const msg = await openGroup();
    fireEvent.contextMenu(msg);
    fireEvent.click(within(await screen.findByRole("menuitem", { name: "Ответить" })).getByRole("button"));
    const reply = await screen.findByLabelText("Ответ на сообщение");
    expect(reply).toHaveTextContent("Ответ: Борис Петров");
    expect(reply).toHaveTextContent("в пятницу планёрка");
    fireEvent.change(screen.getByLabelText("Сообщение"), { target: { value: "Буду" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(screen.queryByLabelText("Ответ на сообщение")).toBeNull());
    const quote = await waitFor(() => { const q = document.querySelector(".chat-quote"); expect(q).not.toBeNull(); return q as HTMLElement; });
    expect(quote).toHaveTextContent("Борис Петров");
    expect(quote).toHaveTextContent("в пятницу планёрка");
    expect(await screen.findByText("Буду")).toBeInTheDocument();
  });

  it("у своего сообщения есть и «Изменить», и «Удалить»", async () => {
    await openGroup();
    fireEvent.change(screen.getByLabelText("Сообщение"), { target: { value: "Моё сообщение" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect((screen.getByLabelText("Сообщение") as HTMLTextAreaElement).value).toBe(""));
    fireEvent.contextMenu(await screen.findByText("Моё сообщение"));
    expect(menuLabels()).toEqual(["Ответить", "Скопировать", "Изменить", "Удалить"]);
  });
});

describe("вложения", () => {
  it("скрепка слева от поля ввода; окно «Прикрепить вложение» с отдельными кнопками и иконками", async () => {
    await openGroup();
    const clip = screen.getByRole("button", { name: "Прикрепить вложение" });
    const input = screen.getByLabelText("Сообщение");
    expect(clip.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(clip);
    const dlg = await screen.findByRole("dialog", { name: "Прикрепить вложение" });
    const kinds = within(within(dlg).getByRole("group", { name: "Что прикрепить" })).getAllByRole("button");
    expect(kinds.map((b) => b.textContent)).toEqual(["Файл", "Заявки", "Компании", "Контакты", "Сделки"]);
    expect(kinds.every((b) => b.querySelector("svg"))).toBe(true);
    expect(screen.queryByText("Прикрепить карточку")).toBeNull();
  });

  it("файл выбирается, показывается в сообщении и отправляется", async () => {
    await openGroup();
    fireEvent.click(screen.getByRole("button", { name: "Прикрепить вложение" }));
    const dlg = await screen.findByRole("dialog", { name: "Прикрепить вложение" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Файл" }));
    const file = new File(["привет"], "договор.pdf", { type: "application/pdf" });
    fireEvent.change(within(dlg).getByLabelText("Выбрать файлы"), { target: { files: [file] } });
    const pending = await screen.findByLabelText("Вложения сообщения");
    expect(pending).toHaveTextContent("договор.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(screen.queryByLabelText("Вложения сообщения")).toBeNull());
    expect((await screen.findAllByRole("button", { name: /договор\.pdf/ })).at(-1)!.className).toContain("chat-card");
  });
});
