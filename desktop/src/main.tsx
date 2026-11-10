import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/app.css";
import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { initBackend } from "./api/backend";
import { App } from "./app/App";
import { applyTheme, resolveTheme, systemIsDark } from "./lib/theme";
import { getLanguage, subscribeLanguage } from "./lib/i18n";

// До загрузки настроек берём тему системы, чтобы окно не вспыхивало не тем цветом.
applyTheme(resolveTheme("system", systemIsDark()));

/** При смене языка дерево собирается заново: тексты, считаемые при создании, обновляются. */
function Root() {
  const lang = useSyncExternalStore(subscribeLanguage, getLanguage);
  return <App key={lang} />;
}

void initBackend().then(() => {
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
});
