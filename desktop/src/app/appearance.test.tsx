import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { patchDevice } from "../state/store";
import { setLanguage } from "../lib/i18n";

afterEach(async () => {
  cleanup();
  await patchDevice({ language: "system", theme: "system" });
  setLanguage("ru");
});

describe("тема и язык", () => {
  it("светлая тема ставится на страницу, «как в системе» берёт тему системы", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    await patchDevice({ theme: "light" });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    await patchDevice({ theme: "dark" });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
  });

  it("английский язык переводит интерфейс, русский возвращает обратно", async () => {
    render(<App />);
    await screen.findByLabelText("Навигация");
    await patchDevice({ language: "en" });
    await screen.findByLabelText("Navigation");
    expect(document.documentElement.lang).toBe("en");
    await patchDevice({ language: "ru" });
    await screen.findByLabelText("Навигация");
  });
});
