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

test("English README documents the local proxy inspector with verified agents", () => {
  expect(readmeEn).toContain("DeepAA");
  expect(readmeEn).toContain(
    "an OpenAI-compatible upstream URL, an Anthropic-compatible upstream URL, or both",
  );
  expect(readmeEn).toContain("Standalone Node proxy");
  expect(readmeEn).toContain("parsed JSON");
  expect(readmeEn).toContain("http://127.0.0.1:3211");
  expect(readmeEn).toContain("Claude Code");
  expect(readmeEn).toContain("Codex");
  expect(readmeEn).toContain("Next.js 16");
  expect(readmeEn).toContain("React 19");
  expect(readmeEn).toContain("pnpm");
  expect(readmeEn).toContain("Node.js 22");
  expect(readmeEn).not.toContain("Bun");
  expect(readmeEn).toContain("deepaa proxy");
  expect(readmeEn).toContain("pnpm build");
  expect(readmeEn).toContain("data/captures/v2");
  expect(readmeEn).toContain("deepaa.sqlite");
  expect(readmeEn).toContain("WAL");
  expect(readmeEn).toContain("paused_disk");
  expect(readmeEn).toContain("DEEPAA_DATA_DIR");
  expect(readmeEn).toContain("does not import legacy captures");
});

test("Default Chinese README documents the same local proxy workflow with verified agents", () => {
  expect(readmeZh).toContain("DeepAA");
  expect(readmeZh).toContain("OpenAI 兼容上游 URL、Anthropic 兼容上游 URL");
  expect(readmeZh).toContain("Agent / SDK / CLI");
  expect(readmeZh).toContain("查看调用链路");
  expect(readmeZh).toContain("http://127.0.0.1:3211");
  expect(readmeZh).toContain("Claude Code");
  expect(readmeZh).toContain("Codex");
  expect(readmeZh).toContain("Next.js 16");
  expect(readmeZh).toContain("React 19");
  expect(readmeZh).toContain("pnpm");
  expect(readmeZh).toContain("Node.js 22");
  expect(readmeZh).not.toContain("Bun");
  expect(readmeZh).toContain("deepaa proxy");
  expect(readmeZh).toContain("pnpm build");
  expect(readmeZh).toContain("data/captures/v2");
  expect(readmeZh).toContain("deepaa.sqlite");
  expect(readmeZh).toContain("WAL");
  expect(readmeZh).toContain("paused_disk");
  expect(readmeZh).toContain("DEEPAA_DATA_DIR");
  expect(readmeZh).toContain("不导入旧 capture");
  expect(readmeZh).toContain("Thread");
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
