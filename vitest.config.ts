import {defineConfig} from "vitest/config";
import {fileURLToPath} from "node:url";

const nodeTestFiles = [
  "tests/sqlite-schema.test.ts",
  "tests/raw-source-reader.test.ts",
  "tests/sqlite-derivation.test.ts",
  "tests/sqlite-worker.test.ts",
  "tests/sqlite-retention-window.test.ts",
  "tests/sqlite-auto-purge-scheduler.test.ts",
  "tests/sqlite-workbench-queries.test.ts",
  "tests/sqlite-workbench-search.test.ts",
  "tests/sqlite-export-conversation.test.ts",
  "tests/export-content-stream.test.ts",
  "tests/sqlite-token-pricing.test.ts",
  "tests/sqlite-large-data.test.ts",
  "tests/catalog-notification-store.test.ts",
  "tests/sqlite-harness-snapshot.test.ts",
  "tests/sqlite-harness-backfill.test.ts",
  "tests/sqlite-step-evidence-p1.test.ts",
  "tests/sqlite-agent-local-import.test.ts",
  "tests/sqlite-dsh-local-import.test.ts",
  "tests/sqlite-codex-local-import.test.ts",
  "tests/sqlite-legacy-identity-repair.test.ts",
  "tests/export-list-rows.test.ts",
  "tests/export-deep-link.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: nodeTestFiles,
    // 全局 HOME 沙箱：防止缺省路径解析到真实主目录的测试写入伤害本机 CLI 配置。
    setupFiles: ["tests/helpers/home-sandbox.ts"],
  },
});
