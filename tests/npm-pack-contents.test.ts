/**
 * npm 发布内容守护测试（2026-10-12 全新安装 ENOENT 事故后新增）。
 *
 * 事故：package.json 的 files 白名单漏掉 config/agents/catalog-template.json，
 * npm 全新安装的用户在「新建供应商向导」第一步即 ENOENT——源码模式文件永远在，
 * 只有发布成 npm 包才缺，开发期测试全绿也拦不住。
 *
 * 本测试以 `npm pack --dry-run --ignore-scripts` 的真实产物清单为唯一真相源，
 * 断言所有「运行时按包内路径读取」的资源都在包里。files 白名单与运行时读文件
 * 是两套解耦清单，任何一边新增都极易漏另一边——新增运行时包内资源时，必须
 * 同步在下方 REQUIRED 中登记。
 *
 * 注意：dist/proxy 与 .next 属构建产物，未构建的裸检出会失败——这是刻意的
 * 发布闸门（没有构建产物就不该 publish）。
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 运行时按包内路径读取（或直接执行）的必需资源；前缀以 / 结尾表示目录级断言。 */
const REQUIRED: readonly string[] = [
  // 模型能力产品兜底模板（config-sync 全链路依赖；2026-10-12 事故本体）
  "config/agents/catalog-template.json",
  // 离线目录与价格兜底（在线拉取失败时的唯一退路）
  "data/defaults/llm_catalog.jsonl",
  "data/defaults/litellm-model-prices.snapshot.json",
  // 代理独立进程产物
  "dist/proxy/proxy-server.mjs",
  // Web 构建产物（目录级：至少一个 .next/** 条目）
  ".next/",
  // CLI 入口与静态资源
  "bin/deepaa.mjs",
  "public/deepaa-mark.png",
  "public/agent-logos/",
];

function packListing(): string[] {
  // --ignore-scripts：跳过生命周期钩子，纯列清单，防止测试触发真实构建/发布动作。
  // npm 把 notice 清单写到 stderr，必须同时捕获两路输出。
  const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run 失败（exit ${result.status}）：${(result.stderr || "").slice(0, 2000)}`);
  }
  // 输出行形如 `npm notice 12.3kB config/agents/catalog-template.json`；
  // 过滤掉 tgz 名、大小汇总等非文件行。
  return `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map(line => line.match(/^npm notice\s+[\d.]+\s*[kKmMgG]?\s*[bB]?\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter(entry => entry.length > 0 && !entry.endsWith(".tgz"));
}

describe("npm 发布内容守护（npm pack --dry-run 真实清单）", () => {
  it("files 白名单遗漏会导致全新安装 ENOENT——所有运行时必需资源必须在包内", () => {
    const listing = packListing();
    expect(listing.length, "pack 清单为空：npm pack --dry-run 未产出文件列表").toBeGreaterThan(0);

    const missing: string[] = [];
    for (const required of REQUIRED) {
      if (required.endsWith("/")) {
        if (!listing.some(entry => entry.startsWith(required))) missing.push(`${required}**（整个目录缺失）`);
      } else if (!listing.includes(required)) {
        missing.push(required);
      }
    }
    expect(
      missing,
      `npm 包缺失运行时必需资源（请把对应条目加入 package.json files 并在 REQUIRED 登记）：\n${missing.join("\n")}`
    ).toEqual([]);
  });
});
