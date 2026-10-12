import { expect, test } from "vitest";
import { existsSync, readFileSync } from "fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf-8"));
const proxy = readFileSync("src/reverse-proxy.ts", "utf-8");
const types = readFileSync("src/types.ts", "utf-8");
const readmeZh = readFileSync("README.md", "utf-8");
const readmeEn = readFileSync("README_en.md", "utf-8");

test("legacy single-page server and provider registry are removed", () => {
  expect(existsSync("src/server.ts")).toBe(false);
  expect(existsSync("src/providers/proxy-capture.ts")).toBe(false);
  expect(existsSync("src/frontend")).toBe(false);
  expect(types).not.toContain("CapturedExchange");
  expect(types).not.toContain("TurnSummary");
  expect(types).not.toContain("WSMessage");
  expect(types).not.toContain("StreamState");
  expect(types).not.toContain("SSEEvent");
});

test("Claude Code history provider and raw types are removed", () => {
  expect(existsSync("src/providers/claude-code.ts")).toBe(false);
  expect(existsSync("src/providers/registry.ts")).toBe(false);
  expect(types).not.toContain("ClaudeCode");
  expect(types).not.toContain("ILogProvider");
  expect(types).not.toContain("ProviderInfo");
});

test("English README documents the local gateway product with verified agents", () => {
  expect(readmeEn).toContain("DeepAA");
  expect(readmeEn).toContain("Codex, Claude Code, OpenCode, DeepSeek Harness, and ZCode");
  expect(readmeEn).toContain("http://127.0.0.1:3210");
  expect(readmeEn).toContain("https://deepaa.dev/install.sh");
  expect(readmeEn).toContain("npm install -g deepaa");
  expect(readmeEn).toContain("macOS and Windows");
  expect(readmeEn).toContain("Node.js 22.13+");
  expect(readmeEn).toContain("pnpm install");
  expect(readmeEn).toContain("pnpm build");
  expect(readmeEn).toContain("pnpm start");
  expect(readmeEn).toContain("deepaa status");
  expect(readmeEn).toContain("Session → Thread → Turn → Step");
  expect(readmeEn).not.toContain("Bun");
});

test("Default Chinese README documents the same local gateway workflow with verified agents", () => {
  expect(readmeZh).toContain("DeepAA");
  expect(readmeZh).toContain("Codex、Claude Code、OpenCode、DeepSeek Harness、ZCode");
  expect(readmeZh).toContain("http://127.0.0.1:3210");
  expect(readmeZh).toContain("https://deepaa.dev/install.sh");
  expect(readmeZh).toContain("npm install -g deepaa");
  expect(readmeZh).toContain("macOS 和 Windows");
  expect(readmeZh).toContain("Node.js 22.13+");
  expect(readmeZh).toContain("pnpm install");
  expect(readmeZh).toContain("pnpm build");
  expect(readmeZh).toContain("pnpm start");
  expect(readmeZh).toContain("deepaa status");
  expect(readmeZh).toContain("Session → Thread → Turn → Step");
  expect(readmeZh).not.toContain("Bun");
});

test("package metadata is ready for permissive open source release", () => {
  expect(packageJson.description).toContain("Deep Agent Analytics");
  expect(packageJson.license).toBe("MIT");
  expect(packageJson.repository).toMatchObject({
    type: "git",
    url: "git+https://github.com/AIAgentAndy/DeepAA.git",
  });
  expect(packageJson.files).toEqual([
    "bin",
    "config/agents/catalog-template.json",
    "dist/proxy",
    ".next",
    "!.next/cache",
    "!.next/dev",
    "scripts/build-proxy.mjs",
    "scripts/normalize-next-trace.mjs",
    "scripts/verify-next-trace.mjs",
    "src",
    "public/agent-logos",
    "public/deepaa-mark.png",
    "data/defaults/litellm-model-prices.snapshot.json",
    "data/defaults/llm_catalog.jsonl",
    "README.md",
    "README_en.md",
    "LICENSE",
    "next.config.ts",
    "tsconfig.json",
  ]);
  expect(packageJson.bin).toEqual({ "deepaa": "./bin/deepaa.mjs" });
  expect(packageJson.scripts["legacy:start"]).toBeUndefined();
  expect(packageJson.scripts.typecheck).toContain("tsc --noEmit");
});

test("proxy defaults to loopback-only listening", () => {
  expect(proxy).toContain('const DEFAULT_PROXY_HOST = "127.0.0.1";');
  expect(proxy).toContain("options.hostname ?? process.env.PROXY_HOST ?? process.env.HOST ?? DEFAULT_PROXY_HOST");
  expect(proxy).not.toContain('hostname: options.hostname ?? "0.0.0.0"');
});
