import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../../api";
import { resetWsMock } from "../../api/wsMock";
import { collectionGlyph, ENTITIES } from "../../lib/crm";
import { Icon } from "../../ui/icons";
import { canAdminister, Settings } from "../settings/Settings";
import { openSettings, setState } from "../../state/store";

afterEach(() => { cleanup(); openSettings(null); });
beforeEach(async () => {
  resetWsMock();
  setState({ ws: await api.wsState() });
});

describe("иконки вместо эмодзи", () => {
  it("у каждого типа записи есть линейная иконка, которой нет в наборе-заглушке", () => {
    for (const e of Object.values(ENTITIES)) {
      expect(e.icon.length).toBeGreaterThan(0);
      const { container } = render(<Icon name={e.icon} />);
      expect(container.querySelector("path")?.getAttribute("d")).not.toBe("M12 12h.01");
      cleanup();
    }
  });

  it("встроенные коллекции получают иконку, а выбранный человеком эмодзи остаётся", () => {
    expect(collectionGlyph({ name: "Все клиенты", emoji: "🤝", entity_type: "company" })).toEqual({ icon: "users" });
    expect(collectionGlyph({ name: "Любимые", emoji: "🔥", entity_type: "company" })).toEqual({ emoji: "🔥" });
    expect(collectionGlyph({ name: "Без значка", emoji: null, entity_type: "deal" })).toEqual({ icon: "briefcase" });
  });
});

describe("настройки: администрирование по праву", () => {
  it("право управлять пространством открывает раздел администрирования", () => {
    expect(canAdminister(["members.manage"])).toBe(true);
    expect(canAdminister(["workspace.manage"])).toBe(true);
    expect(canAdminister(["deals.view"])).toBe(false);
    expect(canAdminister(undefined)).toBe(false);
  });

  it("раздел показан владельцу и спрятан у сотрудника без права", () => {
    openSettings("appearance");
    const owner = render(<Settings />);
    expect(screen.getByText("Администрирование")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Участники, воронки, поля"));
    owner.unmount();
    setState((s) => ({ ws: s.ws ? { ...s.ws, permissions: [] } : s.ws }));
    openSettings("appearance");
    render(<Settings />);
    expect(screen.queryByText("Администрирование")).toBeNull();
  });
});
