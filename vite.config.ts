import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    manifest: true,
  },
  test: {
    environment: "jsdom",
    // 上游源码仅作为事实依据，不纳入自有 Web 服务测试发现范围。
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    setupFiles: ["./src/web/test-setup.ts"],
  },
});
