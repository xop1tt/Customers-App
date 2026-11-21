// Настройки Ai: что понимает модель (изображения, звук) определяется автоматически, переключателей нет.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubDemo } from "../../api/mock";
import { loadHub, saveAi } from "../../state/hub";
import { AiSection, capsText } from "./AiSection";

beforeEach(async () => { hubDemo.reset(); await loadHub(); });
afterEach(cleanup);

describe("что понимает модель", () => {
  it("подпись: известное перечисляется, неизвестное помечено как проба", () => {
    expect(capsText({ vision: true, audio: true })).toBe("Текст, изображения и звук");
    expect(capsText({ vision: false, audio: false })).toBe("Текст");
    expect(capsText({ vision: true, audio: null })).toBe("Текст, изображения; звук — не удалось узнать, файл будет отправлен на пробу");
  });

  it("в настройках нет переключателей «Модель понимает…», вместо них — определённое автоматически", async () => {
    hubDemo.caps = { vision: true, audio: false };
    await saveAi({ model: "llama3.1" });
    render(<AiSection />);
    expect(await screen.findByText("Текст, изображения")).toBeInTheDocument();
    expect(screen.queryByText("Модель понимает изображения")).toBeNull();
    expect(screen.queryByText("Модель понимает звук")).toBeNull();
    expect(screen.queryByRole("switch", { name: /понимает/ })).toBeNull();
  });
});
