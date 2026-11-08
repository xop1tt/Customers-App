import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Каталог категорий OpenStreetMap общий с Rust-ядром: один файл, интерфейс его только читает.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, fs: { allow: [".."] } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, sourcemap: false },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/test-setup.ts"], include: ["src/**/*.test.{ts,tsx}"] },
});
