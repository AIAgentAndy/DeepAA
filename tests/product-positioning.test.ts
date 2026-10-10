import { expect, test } from "vitest";
import { existsSync, readFileSync } from "fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf-8"));
const proxy = readFileSync("src/reverse-proxy.ts", "utf-8");
const types = readFileSync("src/types.ts", "utf-8");
const readme = readFileSync("README.md", "utf-8");
const readmeCn = readFileSync("README_cn.md", "utf-8");

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

test("README documents the local proxy inspector with verified agents", () => {
  expect(readme).toContain("DeepAA");
  expect(readme).toContain(
    "an OpenAI-compatible upstream URL, an Anthropic-compatible upstream URL, or both",
  );
  expect(readme).toContain("Standalone Node proxy");
  expect(readme).toContain("parsed JSON");
  expect(readme).toContain("http://127.0.0.1:3211");
  expect(readme).toContain("Claude Code");
  expect(readme).toContain("Codex");
  expect(readme).toContain("Next.js 16");
  expect(readme).toContain("React 19");
  expect(readme).toContain("pnpm");
  expect(readme).toContain("Node.js 22");
  expect(readme).not.toContain("Bun");
  expect(readme).toContain("deepaa proxy");
  expect(readme).toContain("pnpm build");
  expect(readme).toContain("data/captures/v2");
  expect(readme).toContain("deepaa.sqlite");
  expect(readme).toContain("WAL");
  expect(readme).toContain("paused_disk");
  expect(readme).toContain("DEEPAA_DATA_DIR");
  expect(readme).toContain("does not import legacy captures");
});

test("Chinese README documents the same local proxy workflow with verified agents", () => {
  expect(readmeCn).toContain("DeepAA");
  expect(readmeCn).toContain("OpenAI 兼容上游 URL、Anthropic 兼容上游 URL");
  expect(readmeCn).toContain("Agent / SDK / CLI");
  expect(readmeCn).toContain("查看调用链路");
  expect(readmeCn).toContain("http://127.0.0.1:3211");
  expect(readmeCn).toContain("Claude Code");
  expect(readmeCn).toContain("Codex");
  expect(readmeCn).toContain("Next.js 16");
  expect(readmeCn).toContain("React 19");
  expect(readmeCn).toContain("pnpm");
  expect(readmeCn).toContain("Node.js 22");
  expect(readmeCn).not.toContain("Bun");
  expect(readmeCn).toContain("deepaa proxy");
  expect(readmeCn).toContain("pnpm build");
  expect(readmeCn).toContain("data/captures/v2");
  expect(readmeCn).toContain("deepaa.sqlite");
  expect(readmeCn).toContain("WAL");
  expect(readmeCn).toContain("paused_disk");
  expect(readmeCn).toContain("DEEPAA_DATA_DIR");
  expect(readmeCn).toContain("不导入旧 capture");
  expect(readmeCn).toContain("Thread");
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
    "README_cn.md",
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
