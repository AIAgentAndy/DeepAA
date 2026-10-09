import {readFile} from "node:fs/promises";
import {describe, expect, test} from "vitest";

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  const fileUrl = new URL(`../${relativePath}`, import.meta.url);
  return JSON.parse(await readFile(fileUrl, "utf8")) as Record<string, unknown>;
}

describe("Node-only 工具链", () => {
  test("测试、依赖和 TypeScript 类型不再引用 Bun", async () => {
    const packageJson = await readJson("package.json");
    const tsconfig = await readJson("tsconfig.json");
    const scripts = packageJson.scripts as Record<string, string>;
    const devDependencies = packageJson.devDependencies as Record<string, string>;
    const compilerOptions = tsconfig.compilerOptions as {types?: string[]};

    expect(scripts.test).toContain("test:vitest");
    expect(scripts).not.toHaveProperty("test:bun");
    expect(devDependencies).not.toHaveProperty("@types/bun");
    expect(compilerOptions.types ?? []).not.toContain("bun");
    // 运行类脚本 = deepaa 命令一一镜像（2026-10-05 用户确认）：
    // start=裸 deepaa 智能启动；open=前台；dev/dev:web/dev:proxy=开发；
    // proxy/web/stop/status/service 同名透传，一律经启动器（不再直连 dist/tsx）。
    expect(scripts.start).toBe("node ./bin/deepaa.mjs");
    expect(scripts.open).toBe("node ./bin/deepaa.mjs open");
    expect(scripts.dev).toBe("node ./bin/deepaa.mjs dev");
    expect(scripts["dev:web"]).toBe("node ./bin/deepaa.mjs dev web");
    expect(scripts["dev:proxy"]).toBe("node ./bin/deepaa.mjs dev proxy");
    expect(scripts.proxy).toBe("node ./bin/deepaa.mjs proxy");
    expect(scripts.web).toBe("node ./bin/deepaa.mjs web");
    expect(scripts.stop).toBe("node ./bin/deepaa.mjs stop");
    expect(scripts.status).toBe("node ./bin/deepaa.mjs status");
    expect(scripts.service).toBe("node ./bin/deepaa.mjs service");
    // 旧命名/直连脚本已删除（help 脚本与 pnpm 内建命令冲突亦不设）
    for (const legacy of ["start:dev", "proxy:dev", "web:dev", "launch", "help"]) {
      expect(scripts).not.toHaveProperty(legacy);
    }
    expect(Object.values(scripts).join("\n")).not.toContain("${PORT:-");
  });

  test("生产 Agent 分类和 UI 不保留 Bun 专属分支", async () => {
    const sources = await Promise.all([
      "src/lib/harness/fingerprint.ts",
      "src/lib/agent-display.ts",
      "src/components/harness-workbench.tsx",
    ].map(path => readFile(new URL(`../${path}`, import.meta.url), "utf8")));

    expect(sources.join("\n")).not.toMatch(/Bun|\bbun\b/u);
  });

  test("Node 专属测试全部从 Vitest 入口排除", async () => {
    const packageJson = await readJson("package.json");
    const scripts = packageJson.scripts as Record<string, string>;
    const vitestConfig = await readFile(
      new URL("../vitest.config.ts", import.meta.url),
      "utf8",
    );
    const nodeTestFiles = scripts["test:sqlite"].match(/tests\/[^\s]+\.test\.ts/gu) ?? [];

    expect(nodeTestFiles.length).toBeGreaterThan(0);
    for (const testFile of nodeTestFiles) {
      expect(vitestConfig).toContain(`"${testFile}"`);
    }
  });

  test("活跃文档只展示统一的生产和开发命令", async () => {
    const sources = await Promise.all([
      "README.md",
      "README_cn.md",
    ].map(path => readFile(new URL(`../${path}`, import.meta.url), "utf8")));

    for (const source of sources) {
      // 脚本名与 deepaa 命令同名（2026-10-05 用户确认）
      expect(source).toContain("pnpm dev");
      expect(source).toContain("pnpm dev:proxy");
      expect(source).toContain("pnpm dev:web");
      expect(source).toContain("pnpm open");
      // 旧脚本名不再出现
      expect(source).not.toContain("pnpm start:dev");
      expect(source).not.toContain("pnpm proxy:dev");
      expect(source).not.toContain("pnpm web:dev");
    }
  });
});
