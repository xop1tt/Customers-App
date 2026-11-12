import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { telegramChannel } from "../lib/sourceInput";
import { Checkbox, Select, Switch, ValueList } from "./kit";

describe("UI-кит", () => {
  it("переключатель сообщает новое значение", () => {
    const f = vi.fn();
    render(<Switch checked={false} onChange={f} label="Тест" />);
    fireEvent.click(screen.getByRole("switch", { name: "Тест" }));
    expect(f).toHaveBeenCalledWith(true);
  });

  it("флажок меняется кликом по подписи", () => {
    const f = vi.fn();
    render(<Checkbox checked={false} onChange={f} label="Скрыть" />);
    fireEvent.click(screen.getByText("Скрыть"));
    expect(f).toHaveBeenCalledWith(true);
  });

  it("список выбора открывается, выбирает вариант и закрывается", () => {
    const f = vi.fn();
    render(<Select value="a" onChange={f} options={[{ value: "a", label: "Первый" }, { value: "b", label: "Второй" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /Первый/ }));
    fireEvent.click(screen.getByRole("option", { name: /Второй/ }));
    expect(f).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("список значений добавляет, нормализует, отбрасывает дубли и удаляет", () => {
    const rejected = vi.fn();
    function Host() {
      const [items, setItems] = useState<string[]>([]);
      return <ValueList items={items} onChange={setItems} normalize={telegramChannel} placeholder="канал" onRejected={rejected} />;
    }
    render(<Host />);
    const input = screen.getByPlaceholderText("канал");
    fireEvent.change(input, { target: { value: "https://t.me/freetasks, @FreeTasks, ###" } });
    fireEvent.click(screen.getByRole("button", { name: /Добавить/ }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(rejected).toHaveBeenCalledWith(["###"]);
    fireEvent.click(screen.getByRole("button", { name: /Убрать/ }));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
