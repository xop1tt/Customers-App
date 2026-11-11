import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { resetWsMock } from "../api/wsMock";
import { boot, getState, setState } from "../state/store";
import { applyTemplate, Welcome } from "./Welcome";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(async () => {
  resetWsMock();
  await boot();
  setState({ ws: await api.wsState(), phase: "welcome" });
});

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

async function clearDeals() {
  for (const d of (await api.wsList("deals", { limit: 5000 })).items) await api.wsDelete("deals", d.id);
}

describe("мастер первого запуска", () => {
  it("идёт по шагам макета: компания, воронка, клиенты, связь", async () => {
    const details = vi.spyOn(api, "wsSetLocalDetails");
    render(<Welcome />);
    expect(screen.getByText("Шаг 1 из 5")).toBeTruthy();
    expect(screen.getByText("Клиенты и сделки")).toBeTruthy();
    click("Начать");

    await screen.findByRole("heading", { name: "Ваша компания" });
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Студия «Пиксель»" } });
    click("Далее");
    await screen.findByRole("heading", { name: "Как вы продаёте" });
    expect(details).toHaveBeenCalledWith("Студия «Пиксель»", "RUB");
    expect(getState().ws?.workspaces.find((w) => w.id === getState().ws?.active)?.name).toBe("Студия «Пиксель»");

    const goods = screen.getByRole("radio", { name: /Товары/ });
    fireEvent.click(goods);
    expect(goods.getAttribute("aria-checked")).toBe("true");
    click("Далее");

    await screen.findByRole("heading", { name: "Добавьте клиентов" });
    click("Добавить");
    fireEvent.change(screen.getByLabelText("Название компании"), { target: { value: "ООО Ромашка" } });
    click("Сохранить");
    await screen.findByText(/Добавлено: 1/);
    expect((await api.wsList("companies", { search: "Ромашка" })).items.length).toBeGreaterThan(0);
    click("Позже");

    await screen.findByRole("heading", { name: "Звонки и письма" });
    fireEvent.change(screen.getByLabelText("Подпись в письмах"), { target: { value: "Анна, Студия «Пиксель»" } });
    click("Начать работу");
    await waitFor(() => expect(getState().phase).toBe("ready"));
    expect(getState().account?.welcomeDone).toBe(true);
    expect(getState().account?.signature).toBe("Анна, Студия «Пиксель»");
    expect(getState().section).toBe("today");
  });

  it("сделки уже есть — этапы воронки не меняются; без сделок шаблон применяется", async () => {
    const before = (await api.wsList("pipeline_stages", { limit: 500 })).items.map((s) => s.name).sort();
    expect(await applyTemplate("goods")).toMatch(/уже есть сделки/);
    expect((await api.wsList("pipeline_stages", { limit: 500 })).items.map((s) => s.name).sort()).toEqual(before);

    await clearDeals();
    expect(await applyTemplate("goods")).toBeNull();
    const pipes = (await api.wsList("pipelines", { limit: 50 })).items;
    const def = pipes.find((p) => p.is_default) ?? pipes[0]!;
    const stages = (await api.wsList("pipeline_stages", { limit: 500 })).items.filter((s) => s.pipeline_id === def.id && !s.deleted_at)
      .sort((a, b) => Number(a.position) - Number(b.position));
    expect(stages.filter((s) => s.kind === "open").map((s) => s.name)).toEqual(["Заявка", "Счёт выставлен", "Оплачено", "Отгрузка"]);
    expect(stages.find((s) => s.kind === "won")?.name).toBe("Получено");
    expect(stages.at(-1)?.kind).toBe("lost");
  });

  it("«Найти новых» ведёт после мастера в настройки поиска", async () => {
    render(<Welcome />);
    click("Начать");
    await screen.findByRole("heading", { name: "Ваша компания" });
    click("Позже");
    await screen.findByRole("heading", { name: "Как вы продаёте" });
    click("Позже");
    const step = await screen.findByRole("heading", { name: "Добавьте клиентов" });
    expect(step).toBeTruthy();
    click("Настроить поиск");
    expect(within(document.body).getByRole("button", { name: "После мастера" })).toBeTruthy();
    click("Пропустить настройку");
    await waitFor(() => expect(getState().phase).toBe("ready"));
    expect(getState().section).toBe("home");
    expect(getState().settings).toBe("search");
  });
});
