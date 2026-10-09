import {readFile} from "node:fs/promises";
import {expect, test} from "vitest";

/**
 * 守卫测试：网关模型串（<真实模型ID>_<路由ID>）的拼接与切分只能经由
 * src/proxy/gateway-prefix.ts 的 buildGatewayModelId / parseGatewayModelId /
 * isGatewayModelForTarget 完成。业务目录中出现手写下划线拆分或模板拼接时
 * 直接判失败，防止再次散落出与权威模块行为漂移的实现。
 */

const SCAN_DIRS = [
  "src/lib/config-sync",
  "src/lib/development-launch",
] as const;

/** 允许存在的例外：旧格式残留迁移逻辑（按「文件 :: 精确行」白名单登记）。 */
const ALLOWED_LINES = new Set([
  // zcode 老条目元数据回收：以 `_模型ID` 后缀匹配上一代同步遗留键，属于迁移而非编解码。
  "src/lib/config-sync/adapters/zcode.ts ::   const suffix = `_${baseIdLower}`;",
]);

const FORBIDDEN_PATTERNS: Array<{name: string; pattern: RegExp}> = [
  {name: 'split("_")', pattern: /\.split\(["']_["']\)/u},
  {name: 'indexOf("_")', pattern: /\.(lastI|i)ndexOf\(["']_["']\)/u},
  // 手工模板拼接网关模型串：`${…}_${…}` 或 `字面量_${…}` 形态（完整反引号内）。
  {name: "模板拼接 <a>_<b>", pattern: /`\$\{[^}]+\}_\$|_[a-zA-Z][A-Za-z0-9.\[\]]*`\$\{|`\$\{[^}]+\}_`/u},
];

/** 必须直接引用权威编解码实现的模块（生成或解析网关模型串的业务侧入口）。 */
const MUST_IMPORT_CODEC = [
  // catalog-template.ts 自 2026-09-21 重构后不再生成网关模型串（模型条目组装移至各适配器）。
  "src/lib/config-sync/file-display.ts",
  "src/lib/config-sync/adapters/claude.ts",
  "src/lib/config-sync/adapters/codex.ts",
  "src/lib/config-sync/adapters/opencode.ts",
  "src/lib/config-sync/adapters/dsh.ts",
  "src/lib/config-sync/adapters/zcode.ts",
  "src/lib/development-launch/service.ts",
  "src/lib/development-launch/strategies/codex.ts",
  "src/lib/development-launch/strategies/claude.ts",
  "src/lib/development-launch/strategies/opencode.ts",
  "src/lib/development-launch/strategies/shared.ts",
] as const;

test("业务层禁止手写网关模型串的下划线切分/拼接，统一走 gateway-prefix 编解码", async () => {
  const violations: string[] = [];
  for (const dir of SCAN_DIRS) {
    for await (const path of collectFiles(dir)) {
      if (!/\.(ts|tsx)$/u.test(path)) continue;
      const content = await readFile(path, "utf8");
      for (const [lineIndex, line] of content.split("\n").entries()) {
        const key = `${path} :: ${line}`;
        if (ALLOWED_LINES.has(key)) continue;
        for (const forbidden of FORBIDDEN_PATTERNS) {
          if (forbidden.pattern.test(line)) {
            violations.push(`${path}:${lineIndex + 1} 命中 ${forbidden.name}`);
          }
        }
      }
    }
  }
  expect(violations).toEqual([]);
});

test("处理网关模型串的模块必须引用权威编解码实现", async () => {
  for (const path of MUST_IMPORT_CODEC) {
    const content = await readFile(path, "utf8");
    expect(
      content.includes("@/proxy/gateway-prefix"),
      `${path} 应从 src/proxy/gateway-prefix 导入编解码函数`,
    ).toBe(true);
  }
});

async function* collectFiles(dir: string): AsyncGenerator<string> {
  const {readdir} = await import("node:fs/promises");
  const {join} = await import("node:path");
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) yield* collectFiles(child);
    else yield child;
  }
}

import {extractServiceTierValue} from "../src/proxy/gateway-prefix.js";

test("service_tier 计费参数提取：priority/flex/fast 可识别，其他与缺省返回 undefined", async () => {
  expect(extractServiceTierValue(Buffer.from(`{"model":"gpt-5.6-sol_x","service_tier":"priority","input":"hi"}`))).toBe("priority");
  expect(extractServiceTierValue(`{"service_tier":"flex"}`)).toBe("flex");
  expect(extractServiceTierValue(`{"service_tier":"fast"}`)).toBe("fast");
  expect(extractServiceTierValue(`{"service_tier":"default"}`)).toBeUndefined();
  expect(extractServiceTierValue(`{"model":"m"}`)).toBeUndefined();
  expect(extractServiceTierValue("")).toBeUndefined();
});
