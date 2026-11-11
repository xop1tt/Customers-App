import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock } from "../../api/wsMock";
import { setState } from "../../state/store";
import { TrashPage } from "./TrashPage";

afterEach(cleanup);
beforeEach(async () => {
  resetWsMock();
  setState({ ws: await api.wsState() });
});

describe("корзина", () => {
  it("показывает удалённую запись и возвращает её", async () => {
    const c = await api.wsSave("companies", null, { name: "Удалённая компания" });
    await api.wsDelete("companies", c.id);
    render(<TrashPage />);
    const row = (await screen.findByText("Удалённая компания")).closest("[role=row]") as HTMLElement;
    expect(within(row).getByText("Компания")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Восстановить" }));
    await waitFor(() => expect(screen.queryByText("Удалённая компания")).toBeNull());
    expect((await api.wsList("companies", { search: "Удалённая компания" })).items).toHaveLength(1);
  });

  it("пустая корзина объясняет, что здесь появится", async () => {
    render(<TrashPage />);
    expect(await screen.findByText("Корзина пуста")).toBeInTheDocument();
  });
});
