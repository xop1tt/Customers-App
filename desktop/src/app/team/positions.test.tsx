// Должности, кадровые запросы и имя профиля в демо-режиме ?team (ADR-079).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { window.history.replaceState({}, "", "/?team"); });

import { api } from "../../api";
import type { ChatConversation, ChatMessage, TeamMember } from "../../api/types";
import { resetChatMock } from "../../api/chatMock";
import { resetWsMock, setWsMockRole } from "../../api/wsMock";
import { getState, openProfile, openSettings, setState } from "../../state/store";
import { App } from "../App";
import { RequestDialog } from "./Requests";

afterEach(cleanup);
beforeEach(() => { resetWsMock(); resetChatMock(); });

async function boot() {
  render(<App />);
  await waitFor(() => expect(getState().chat?.available).toBe(true));
}

const BORIS = "00000000-0000-4000-8000-000000000002";

describe("имя профиля", () => {
  it("сотрудник не меняет имя сам: поле закрыто, есть «Запрос на смену имени», он уходит руководителю", async () => {
    await boot();
    await waitFor(() => expect(getState().team.length).toBeGreaterThan(1));
    openSettings("account", "profile");
    const field = await screen.findByLabelText("Имя");
    expect(field).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Запрос на смену имени" }));
    const dialog = await screen.findByRole("dialog", { name: "Запрос на смену имени" });
    const send = within(dialog).getByRole("button", { name: "Отправить запрос" });
    expect(send).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Новое имя"), { target: { value: "Анна Ким" } });
    fireEvent.change(within(dialog).getByLabelText("Причина"), { target: { value: "вышла замуж" } });
    fireEvent.click(send);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Запрос на смену имени" })).toBeNull());
    const direct = (await api.wsChat<ChatConversation[]>("chat_list")).find((c) => c.kind === "direct" && c.participants.some((p) => p.user_id === BORIS))!;
    const { messages } = await api.wsChat<{ messages: ChatMessage[] }>("chat_messages", { conversation: direct.id });
    expect(messages.some((x) => x.body.includes("Запрос на смену имени профиля: «Анна Ким»") && x.body.includes("вышла замуж"))).toBe(true);
  });

  it("владелец имя меняет сам", async () => {
    setWsMockRole("owner");
    await boot();
    openSettings("account", "profile");
    expect(await screen.findByLabelText("Имя")).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: "Запрос на смену имени" })).toBeNull();
  });
});

describe("профиль", () => {
  it("нет плашки «В сети», остаётся зелёный кружок", async () => {
    await boot();
    await waitFor(() => expect(getState().team.length).toBeGreaterThan(1));
    openProfile(null);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText("В сети", { selector: ".tag, .tag *" })).toBeNull();
    expect(document.querySelector(".profile-head .person-online")).not.toBeNull();
  });
});

describe("отделы", () => {
  it("рядовой руководитель-менеджер не создаёт отделы; владелец создаёт и закрывает", async () => {
    await boot();
    setState({ section: "people" });
    fireEvent.click(await screen.findByRole("tab", { name: "Отделы" }));
    const sec = await screen.findByLabelText("Отделы");
    expect(within(sec).queryByRole("button", { name: "Создать отдел" })).toBeNull();
    expect(within(sec).queryByRole("button", { name: "Переименовать…" })).toBeNull();
    expect(within(sec).getByText(/Отделы создают и закрывают владелец/)).toBeInTheDocument();
  });
  it("владелец создаёт отдел из выбранных сотрудников", async () => {
    await boot();
    setWsMockRole("owner");
    setState({ section: "people" });
    fireEvent.click(await screen.findByRole("tab", { name: "Отделы" }));
    fireEvent.click(await screen.findByRole("button", { name: "Создать отдел" }));
    const dialog = await screen.findByRole("dialog", { name: "Новый отдел" });
    const create = within(dialog).getByRole("button", { name: "Создать" });
    expect(create).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Название отдела"), { target: { value: "Поддержка" } });
    fireEvent.click(within(dialog).getAllByRole("checkbox")[0]!);
    fireEvent.click(create);
    await waitFor(() => expect(within(screen.getByLabelText("Отделы")).getByText("Поддержка")).toBeInTheDocument());
    const section = within(screen.getByLabelText("Отделы")).getByText("Поддержка").closest("section") as HTMLElement;
    fireEvent.click(within(section).getByRole("button", { name: "Закрыть отдел…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Закрыть отдел" }));
    await waitFor(() => expect(within(screen.getByLabelText("Отделы")).queryByText("Поддержка")).toBeNull());
  });
});

describe("кадровые запросы", () => {
  it("запрос на оформление уходит владельцу и заместителям личным сообщением", async () => {
    await boot();
    await waitFor(() => expect(getState().team.length).toBeGreaterThan(1));
    const team = getState().team;
    const author: TeamMember = { ...team.find((m) => m.user_id === getState().ws?.me)!, title: "Специалист отдела кадров" };
    render(<RequestDialog kind="hire" author={author} team={team} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Запрос на оформление сотрудника" });
    const send = within(dialog).getByRole("button", { name: "Отправить запрос" });
    expect(send).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Почта нового сотрудника"), { target: { value: "new@example.com" } });
    fireEvent.change(within(dialog).getByLabelText("Имя в профиле"), { target: { value: "Ирина Волк" } });
    fireEvent.click(send);
    await waitFor(async () => {
      const direct = (await api.wsChat<ChatConversation[]>("chat_list")).find((c) => c.kind === "direct" && c.participants.some((p) => p.user_id === BORIS))!;
      const { messages } = await api.wsChat<{ messages: ChatMessage[] }>("chat_messages", { conversation: direct.id });
      expect(messages.some((x) => x.body.includes("создать учётную запись для new@example.com, имя профиля «Ирина Волк»"))).toBe(true);
    });
  });
});
