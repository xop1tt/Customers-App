import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getState, setState } from "../state/store";
import { App } from "./App";

afterEach(cleanup);

describe("метка канала", () => {
  it("Beta видна в левой панели, Stable — без метки", async () => {
    render(<App />);
    const nav = await screen.findByLabelText("Навигация");
    await waitFor(() => expect(getState().boot).not.toBeNull());
    expect(within(nav).queryByText("Beta")).toBeNull();
    const boot = getState().boot!;
    setState({ boot: { ...boot, channel: "beta" } });
    expect(await within(nav).findByText("Beta")).toBeTruthy();
    setState({ boot: { ...boot, channel: "stable" } });
    await waitFor(() => expect(within(nav).queryByText("Beta")).toBeNull());
  });
});
