import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["web/tests/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["web/tests/setup.ts"],
  },
});
