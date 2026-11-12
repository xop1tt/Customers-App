import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock } from "../../api/wsMock";
import { boot, setState } from "../../state/store";
import { ConfirmHost } from "../../ui/overlay";
import { CollectionPage } from "./CollectionPage";

afterEach(cleanup);
beforeEach(async () => {
  resetWsMock();
  try { localStorage.clear(); } catch { /* нет хранилища */ }
  await boot();
  setState({ ws: await api.wsState(), record: null });
});

async function openAll() {
  for (const r of (await api.wsList("companies", { limit: 5000 })).items) await api.wsDelete("companies", r.id);
  for (const name of ["Ромашка", "Альфа", "Вега"]) await api.wsSave("companies", null, { name });
  const all = (await api.wsCollections()).find((c) => c.entity_type === "company" && !c.config.filters?.length)!;
  setState({ collectionId: all.id });
  render(<><CollectionPage /><ConfirmHost /></>);
  await screen.findByText("Альфа");
}

describe("массовые действия в таблице CRM", () => {
  it("можно отметить записи, выбрать все и снять выбор", async () => {
    await openAll();
    expect(screen.queryByRole("toolbar", { name: "Массовые действия" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Выбрать: Альфа"));
    const bar = await screen.findByRole("toolbar", { name: "Массовые действия" });
    expect(bar.textContent).toContain("1");
    fireEvent.click(screen.getByLabelText("Выбрать все"));
    await waitFor(() => expect(screen.getByRole("toolbar").textContent).toContain("3"));
    fireEvent.click(within(screen.getByRole("toolbar")).getByText("Снять выбор"));
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  });

  it("отмеченные записи уходят в корзину после подтверждения и восстанавливаются", async () => {
    await openAll();
    fireEvent.click(screen.getByLabelText("Выбрать: Альфа"));
    fireEvent.click(screen.getByLabelText("Выбрать: Вега"));
    fireEvent.click(within(await screen.findByRole("toolbar")).getByText("В корзину"));
    fireEvent.click(within(await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"))).getByText("В корзину"));
    await waitFor(async () => expect((await api.wsList("companies", { limit: 50 })).items.map((c) => c.name)).toEqual(["Ромашка"]));
  });
});
