import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {readFile, stat} from "node:fs/promises";
import {join} from "node:path";
import {describe, expect, test} from "vitest";
import {parseCatalogTextToReport} from "../scripts/catalog-parse-cli.js";
import {loadProviderCatalog, resetProviderCatalogMemoryCacheForTests} from "../src/lib/provider-catalog/cache.js";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";

/**
 * 目录解析 CLI 回归（2026-09-23 架构）：官网 deepaa.dev 编辑/草稿/发布链路经
 * spawn dist/catalog-parser.mjs 调用本 CLI，是两侧唯一权威校验器——
 * 官网不再维护第二套值域校验，杜绝「官网放行、应用拒绝/静默隔离」的漂移窗口。
 */

const BUNDLED_PATH = "data/defaults/llm_catalog.jsonl";

function validCatalogText(extraProvider = ""): string {
  return [
    JSON.stringify({schemaVersion: 2, catalogRevision: "2026.09.23.01", publishedAt: "2026-09-23T00:00:00+08:00"}),
    JSON.stringify({
      catalogKey: "demo",
      name: "Demo", brandId: "demo", pricingProviderId: "demo",
      region: "global", category: "global_official",
      models: [{id: "m1", category: "chat", pricing: {input: 1, output: 2}}],
    }),
    extraProvider,
  ].filter(Boolean).join("\n") + "\n";
}

describe("目录解析 CLI 纯函数报告", () => {
  test("随包真实目录解析通过并产出摘要", async () => {
    const report = parseCatalogTextToReport(await readFile(BUNDLED_PATH, "utf8"));
    expect(report.ok).toBe(true);
    expect(report.revision).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d{2}$/);
    expect(report.providerCount).toBeGreaterThan(0);
    expect(report.modelCount).toBeGreaterThan(0);
    expect(report.errors).toEqual([]);
  });

  test("整份拒绝（meta/结构错误）时 ok=false 且 errors 透出根因", () => {
    const bad = validCatalogText().replace('"schemaVersion":2', '"schemaVersion":3');
    const report = parseCatalogTextToReport(bad);
    expect(report.ok).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0]).toContain("CATALOG_SCHEMA_UNSUPPORTED");
  });

  test("条目级隔离（campaign 结构非法）ok=true 但 diagnostics 非空", () => {
    const provider = JSON.stringify({
      catalogKey: "demo2",
      name: "Demo2", brandId: "demo2", pricingProviderId: "demo2",
      region: "global", category: "global_official",
      models: [{id: "m1", category: "chat", pricing: {input: 1, output: 2}}],
      campaigns: [{id: "bad", channel: "plan", period: {from: "2026-01-01T00:00:00+08:00"}, effect: {kind: "totally-unknown"}}],
    });
    const report = parseCatalogTextToReport(validCatalogText(provider));
    expect(report.ok).toBe(true);
    expect(report.diagnostics.length).toBeGreaterThan(0);
    expect(report.diagnostics.some(item => item.code === "CAMPAIGN_STRUCTURE_INVALID")).toBe(true);
  });
});

describe("目录解析 CLI 构建产物冒烟（dist 存在时执行）", () => {
  test("stdin 输入随包目录 → exit 0 且报告为构建产物形态", async () => {
    const bundle = join(process.cwd(), "dist", "catalog-parser.mjs");
    const exists = await stat(bundle).then(() => true, () => false);
    if (!exists) return; // 未构建环境（如纯 vitest CI）跳过；pnpm build / test:package 必跑构建
    const child = spawn(process.execPath, [bundle, "-"], {stdio: ["pipe", "pipe", "pipe"]});
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stdin.write(await readFile(BUNDLED_PATH, "utf8"));
    child.stdin.end();
    const code = await new Promise<number>(resolvePromise => child.once("exit", c => resolvePromise(c ?? -1)));
    expect(code).toBe(0);
    const report = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
    expect(report.ok).toBe(true);
    expect(report.parserBuild).not.toBe("source");
  });
});

describe("随包兜底目录只读守护（2026-09-23 用户确认红线）", () => {
  test("全部加载路径（远程成功/失败/离线）绝不写随包目录文件", async () => {
    const before = createHash("sha256").update(await readFile(BUNDLED_PATH)).digest("hex");
    const dataDir = await mkdtemp(join(tmpdir(), "deepaa-bundled-readonly-"));
    try {
      await loadProviderCatalog(dataDir, {forceRefresh: true, fetchCatalogText: async () => validCatalogText()});
      await loadProviderCatalog(dataDir, {forceRefresh: true, fetchCatalogText: async () => { throw new Error("模拟远程不可用"); }});
      await loadProviderCatalog(dataDir, {allowRemote: false, forceRefresh: true});
    } finally {
      resetProviderCatalogMemoryCacheForTests();
      await rm(dataDir, {recursive: true, force: true});
    }
    const after = createHash("sha256").update(await readFile(BUNDLED_PATH)).digest("hex");
    expect(after).toBe(before);
  });
});
