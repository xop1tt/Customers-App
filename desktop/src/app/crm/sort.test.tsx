import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock } from "../../api/wsMock";
import { boot, setState } from "../../state/store";
import { CollectionPage } from "./CollectionPage";

afterEach(cleanup);
beforeEach(async () => {
  resetWsMock();
  try { localStorage.clear(); } catch { /* нет хранилища */ }
  await boot();
  setState({ ws: await api.wsState(), record: null });
});

describe("сортировка таблицы CRM", () => {
  it("щелчок по заголовку сортирует, повторный — в обратную сторону, третий — сбрасывает", async () => {
    for (const r of (await api.wsList("companies", { limit: 5000 })).items) await api.wsDelete("companies", r.id);
    for (const name of ["Ромашка", "Альфа", "Вега"]) await api.wsSave("companies", null, { name });
    const all = (await api.wsCollections()).find((c) => c.entity_type === "company" && !c.config.filters?.length)!;
    setState({ collectionId: all.id });
    render(<CollectionPage />);
    const header = await screen.findByRole("button", { name: /Название/ });
    const names = () => screen.getAllByRole("row").slice(1).map((r) => r.querySelector(".crm-title")?.textContent);
    fireEvent.click(header);
    await waitFor(() => expect(names()).toEqual(["Альфа", "Вега", "Ромашка"]));
    expect(header.parentElement).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(header);
    await waitFor(() => expect(names()).toEqual(["Ромашка", "Вега", "Альфа"]));
    expect(header.parentElement).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(header);
    await waitFor(() => expect(header.parentElement).not.toHaveAttribute("aria-sort"));
  });
});
