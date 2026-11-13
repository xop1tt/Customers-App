import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

/** Менеджеры паролей (Связка ключей, Edge/WebView2) подсказывают вход по подсказкам autocomplete. */
async function show(search: string) {
  window.history.pushState({}, "", search);
  const { AuthScreen } = await import("./Auth");
  const { setState } = await import("../state/store");
  setState({ phase: "auth", boot: { version: "1", platform: "macos", cloudAvailable: true, hasUsers: true, existingInstall: false, session: null, device: { rememberedUser: null } } as never });
  return render(<AuthScreen />);
}
const attrs = (c: HTMLElement) => Array.from(c.querySelectorAll("input:not([type=checkbox])")).map((i) => [i.getAttribute("type"), i.getAttribute("name"), i.getAttribute("autocomplete")]);

describe("автозаполнение на экране входа", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("вход в облако: почта — username, пароль — current-password, всё в одной форме", async () => {
    const { container } = await show("/?auth&cloud");
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(attrs(container)).toEqual([["email", "email", "username"], ["password", "password", "current-password"]]);
  });

  it("регистрация: новый пароль и повтор — new-password", async () => {
    const { container } = await show("/?auth&cloud");
    fireEvent.click(screen.getByText("Создать аккаунт"));
    expect(attrs(container)).toEqual([[null, "nickname", "nickname"], ["email", "email", "email"], ["password", "password", "new-password"], ["password", "confirm-password", "new-password"]]);
  });

  it("заголовок по центру над формой, логотип вне формы", async () => {
    const { container } = await show("/?auth&cloud");
    const title = screen.getByRole("heading", { name: "Вход" });
    expect(title.className).toContain("auth-title");
    expect(container.querySelector("form img")).toBeNull();
    expect(container.querySelector(".auth-stack > img.auth-logo-img")).not.toBeNull();
    fireEvent.click(screen.getByText("Создать аккаунт"));
    expect(screen.getByRole("heading", { name: "Регистрация" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("← Ко входу"));
    fireEvent.click(screen.getByText("Забыли пароль?"));
    expect(screen.getByRole("heading", { name: "Восстановление пароля" })).toBeInTheDocument();
  });

  it("локального входа нет: только облачная форма, без вкладки «На этом компьютере»", async () => {
    const { container } = await show("/?auth&cloud");
    expect(screen.queryByRole("tab", { name: "На этом компьютере" })).toBeNull();
    expect(container.querySelectorAll("form")).toHaveLength(1);
  });
});
