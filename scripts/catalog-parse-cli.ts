/**
 * 目录解析 CLI（官网 deepaa.dev 编辑/草稿/发布链路的唯一权威校验器）。
 *
 * 官网管理台与 catalog-test/promote 脚本经 spawn 调用本 CLI 的构建产物
 * dist/catalog-parser.mjs，保证「编辑时校验 = 应用运行时解析」同源——
 * 应用解析器怎么变，官网校验就怎么变，不存在两侧漂移窗口（2026-09-23 架构）。
 *
 * 入口：argv[2] 为 JSONL 文件路径；无参数或 "-" 时从 stdin 读取全文。
 * 输出：stdout 单行 JSON 报告；exit 0 = 解析通过（诊断可以为空也可以非空，
 * 由调用方决定是否放行），exit 1 = 整份拒绝（结构/契约错误）。
 */

import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {parseProviderCatalogText} from "../src/lib/provider-catalog/normalize";
import type {CatalogDiagnostic} from "../src/lib/provider-catalog/diagnostics";
import type {ParsedProviderCatalog} from "../src/lib/provider-catalog/normalize";

/** 构建标识：esbuild banner 注入（源码直跑时为 "source"）。 */
export function catalogParserBuildId(): string {
  const value = (globalThis as {__CATALOG_PARSER_BUILD__?: unknown}).__CATALOG_PARSER_BUILD__;
  return typeof value === "string" && value ? value : "source";
}

export interface CatalogParseDiagnosticReport {
  code: string;
  severity: CatalogDiagnostic["severity"];
  dimension: CatalogDiagnostic["dimension"];
  target?: string;
  message: string;
}

export interface CatalogParseReport {
  ok: boolean;
  parserBuild: string;
  revision?: string;
  publishedAt?: string;
  providerCount?: number;
  modelCount?: number;
  /** 整份拒绝的根因（应用 normalize 抛错信息，逐条列出）。 */
  errors: string[];
  /** 条目级隔离/告警诊断（活动/Profile/预设被剔除等），由调用方决定放行策略。 */
  diagnostics: CatalogParseDiagnosticReport[];
}

/** 文本 → 解析报告（纯函数，供 CLI 与单测共用；绝不写任何文件）。 */
export function parseCatalogTextToReport(text: string): CatalogParseReport {
  const parserBuild = catalogParserBuildId();
  let parsed: ParsedProviderCatalog;
  try {
    parsed = parseProviderCatalogText(text);
  } catch (error) {
    return {
      ok: false,
      parserBuild,
      errors: [error instanceof Error ? error.message : String(error)],
      diagnostics: [],
    };
  }
  const catalog = parsed.catalog;
  return {
    ok: true,
    parserBuild,
    revision: catalog.catalogRevision,
    publishedAt: catalog.publishedAt,
    providerCount: Object.keys(catalog.providers).length,
    modelCount: Object.values(catalog.providers).reduce((sum, provider) => sum + provider.models.length, 0),
    errors: [],
    diagnostics: parsed.diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      dimension: diagnostic.dimension,
      ...(diagnostic.target !== undefined ? {target: diagnostic.target} : {}),
      message: diagnostic.message,
    })),
  };
}

async function main(): Promise<number> {
  const arg = process.argv[2];
  let text: string;
  if (arg === undefined || arg === "-") {
    text = await new Promise<string>((resolvePromise, rejectPromise) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { data += chunk; });
      process.stdin.on("end", () => resolvePromise(data));
      process.stdin.on("error", rejectPromise);
    });
  } else {
    text = await readFile(arg, "utf8");
  }
  const report = parseCatalogTextToReport(text);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.ok ? 0 : 1;
}

const isDirectRun = process.argv[1] !== undefined
  && (process.argv[1] === fileURLToPath(import.meta.url)
    // esbuild bundle 后 import.meta.url 指向产物自身，与 argv[1] 一致；这里放宽为文件名匹配，
    // 覆盖产物被复制/软链到其它路径的场景（官网 spawn 固定走 dist 原路径，正常命中上一分支）。
    || /catalog-parse(?:r)?\.[cm]?js$/.test(process.argv[1]));
if (isDirectRun) {
  void main().then(code => process.exit(code), error => {
    process.stderr.write(`目录解析 CLI 异常：${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
