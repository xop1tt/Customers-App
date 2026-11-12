import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/app.css";
import { Component, StrictMode, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { initBackend } from "./api/backend";
import { App } from "./app/App";
import { applyTheme, resolveTheme, systemIsDark } from "./lib/theme";
import { getLanguage, subscribeLanguage } from "./lib/i18n";

// До загрузки настроек берём тему системы, чтобы окно не вспыхивало не тем цветом.
applyTheme(resolveTheme("system", systemIsDark()));

/** Ошибка отрисовки не должна оставлять пустое окно: показываем текст ошибки и кнопку «Перезапустить интерфейс». */
class Crash extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) }; }
  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div style={{ padding: 24, color: "var(--text, #ddd)", font: "13px/1.5 system-ui, sans-serif" }}>
        <h2 style={{ margin: "0 0 8px" }}>Интерфейс не смог открыться</h2>
        <p style={{ margin: "0 0 12px" }}>Данные не изменены. Нажмите «Перезапустить интерфейс»; если ошибка повторяется, отправьте текст ниже разработчику.</p>
        <button onClick={() => location.reload()}>Перезапустить интерфейс</button>
        <pre style={{ marginTop: 12, whiteSpace: "pre-wrap", userSelect: "text" }}>{this.state.error}</pre>
      </div>
    );
  }
}

/** При смене языка дерево собирается заново: тексты, считаемые при создании, обновляются. */
function Root() {
  const lang = useSyncExternalStore(subscribeLanguage, getLanguage);
  return <App key={lang} />;
}

void initBackend().then(() => {
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <Crash><Root /></Crash>
    </StrictMode>,
  );
});
