import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  // Source files use JSX in .js (not .jsx) extensions, same as Next.js itself
  // treats them — Vite 8's oxc transform excludes .js from JSX parsing by
  // default (only .jsx/.tsx), so it has to be told to include .js too.
  oxc: {
    lang: "jsx",
    include: /\.(m?[jt]sx?)$/,
    exclude: [],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.mjs"],
    globals: true,
    include: ["src/**/*.test.{js,jsx}"],
  },
});
