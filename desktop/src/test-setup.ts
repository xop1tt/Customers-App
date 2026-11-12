import "@testing-library/jest-dom/vitest";

// jsdom не считает вёрстку: подставляем недостающие браузерные API.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
Element.prototype.scrollIntoView = () => {};
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 700 });
// Язык системы в тестах русский: тесты ищут русские подписи.
Object.defineProperty(navigator, "language", { configurable: true, get: () => "ru-RU" });
