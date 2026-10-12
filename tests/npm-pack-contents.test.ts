/**
 * npm 发布内容守护测试（2026-10-12 全新安装 ENOENT 事故后新增，A 层：静态扫描自动化登记）。
 *
 * 事故：package.json 的 files 白名单漏掉 config/agents/catalog-template.json，
 * npm 全新安装的用户在「新建供应商向导」第一步即 ENOENT——源码模式文件永远在，
 * 只有发布成 npm 包才缺，开发期测试全绿也拦不住。
 *
 * 双层防线：
 * 1. `npm pack --dry-run --ignore-scripts` 真实清单 × 人工 REQUIRED 清单
 *    （覆盖"已知关键资源"，防 files 白名单误删既有条目）；
 * 2. 静态扫描 src/ 与 bin/ 中所有「按包根相对路径读文件」的代码（本层）：
 *    重建 join(...) 的字面量参数得到相对路径，凡锚定 process.cwd()/root/
 *    projectRoot 等包根变量的，或以包根目录（config/ data/defaults/ dist/ bin/
 *    public/ scripts/）开头的整串字面量，都必须出现在 pack 清单里——
 *    新增运行时包内读取不再依赖人工登记 REQUIRED，漏配 files 直接红。
 *
 * 已知盲区（有意接受，靠约定缓解）：纯变量拼出的路径（join(root, dir, file)）
 * 静态不可见——新增此类读取时请同步登记 REQUIRED；数据目录侧（~/.deepaa）的
 * 同名前缀文件（如 config/model-pricing.json）在 EXEMPT_DATA_SIDE 显式豁免。
 *
 * 注意：dist/proxy 与 .next 属构建产物，未构建的裸检出会失败——这是刻意的
 * 发布闸门（没有构建产物就不该 publish）。
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 人工维护的关键资源清单（第 1 层防线）；目录断言以 / 结尾。 */
const REQUIRED: readonly string[] = [
  "config/agents/catalog-template.json",
  "data/defaults/llm_catalog.jsonl",
  "data/defaults/litellm-model-prices.snapshot.json",
  "dist/proxy/proxy-server.mjs",
  ".next/",
  "bin/deepaa.mjs",
  "public/deepaa-mark.png",
  "public/agent-logos/",
];

/**
 * 数据目录侧（~/.deepaa）而非包内的路径：与包内路径共享顶级前缀（config/），
 * 运行时按数据目录解析，不要求出现在 pack 清单。新增数据侧同名前缀文件时在此登记。
 */
const EXEMPT_DATA_SIDE: readonly string[] = [
  "config/model-pricing.json",
  "config/provider-catalog-cache.json",
];

/** 包根锚定变量的命名特征：cwd / root / __dirname 系（不含 dataDir/homeDir 系）。 */
const PACKAGE_ROOT_ANCHOR = /(^|[^A-Za-z])(cwd|CWD|root|Root|__dirname|packageDir|packageRoot|projectRoot|repoRoot|moduleRoot)([^A-Za-z]|$)/;

/** 数据目录锚定变量的命名特征：命中则该 join 属运行时数据侧，跳过。 */
const DATA_DIR_ANCHOR = /dataDir|DataDir|dataPath|homeDir|homedir|DeepaaDataDir|tmpDir|TMPDIR/;

/** 仓库结构性的包根顶级目录：路径字面量以其开头即视为包内候选。 */
const PACKAGE_ROOT_DIRS = new Set(["config", "data", "dist", "bin", "public", "scripts"]);

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** 把带嵌套调用的锚点替换为不透明 token，便于后续按括号切片 join 参数。 */
function neutralizeCalls(text: string): string {
  return text
    .replace(/process\.cwd\(\)/g, "PKGROOT_CWD")
    .replace(/resolveDeepaaDataDir\(\)/g, "DATADIR_CALL")
    .replace(/homedir\(\)/g, "DATADIR_CALL")
    .replace(/\b(dirname|basename|fileURLToPath|resolve|normalize)\s*\([^()]*\)/g, "PATH_CALL");
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !/\.test\./.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 扫描 join(...) 调用与整串路径字面量，产出「包内相对路径候选」。
 * - 锚定包根变量的 join：取末尾连续字面量参数拼成相对路径（≥2 段）；
 * - 全字面量 join / 整串字面量：首段 ∈ PACKAGE_ROOT_DIRS 即候选（数据侧经 EXEMPT 豁免）。
 */
function scanPackageRelativePaths(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (rel: string, where: string) => {
    if (!rel.includes("/")) return;
    const [head] = rel.split("/");
    if (!PACKAGE_ROOT_DIRS.has(head)) return;
    const list = found.get(rel) ?? [];
    list.push(where);
    found.set(rel, list);
  };

  for (const file of [...listSourceFiles(path.join(repoRoot, "src")), ...listSourceFiles(path.join(repoRoot, "bin"))]) {
    const where = path.relative(repoRoot, file);
    const text = neutralizeCalls(stripComments(readFileSync(file, "utf8")));

    for (const match of text.matchAll(/\bjoin\s*\(([^()]*)\)/g)) {
      const args = match[1].split(",").map(arg => arg.trim()).filter(Boolean);
      const literals: string[] = [];
      let i = args.length - 1;
      while (i >= 0 && /^"(?:[^"\\]|\\.)*"$/.test(args[i])) {
        literals.unshift(args[i].slice(1, -1));
        i -= 1;
      }
      if (literals.length === 0) continue;
      const rel = literals.join("/");
      const base = args.slice(0, i + 1).join(",").trim();
      if (base === "") {
        add(rel, `${where}: 全字面量 join`);
      } else if (PACKAGE_ROOT_ANCHOR.test(base) && !DATA_DIR_ANCHOR.test(base)) {
        add(rel, `${where}: 包根锚定 join(${base.slice(0, 40)}, …)`);
      }
    }

    for (const match of text.matchAll(/"(?:config|data|dist|bin|public|scripts)\/[A-Za-z0-9_./@-]+"/g)) {
      add(match[0].slice(1, -1), `${where}: 路径字面量`);
    }
  }
  return found;
}

let cachedListing: string[] | undefined;

function packListing(): string[] {
  if (cachedListing) return cachedListing;
  // --ignore-scripts：跳过生命周期钩子，纯列清单，防止测试触发真实构建/发布动作。
  // npm 把 notice 清单写到 stderr，必须同时捕获两路输出。
  // Windows 的 npm 只能经 npm.cmd 执行，而新版 Node 出于安全（CVE-2024-27980）
  // 禁止无 shell 直接 spawn .cmd/.bat（返回 exit null，2026-10-13 CI Windows 全红根因）；
  // args 为固定字面量，shell 注入无攻击面。与 tests/package-smoke.test.ts 同一模式。
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["pack", "--dry-run", "--ignore-scripts"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run 失败（exit ${result.status}）：${(result.stderr || "").slice(0, 2000)}`);
  }
  // 输出行形如 `npm notice 12.3kB config/agents/catalog-template.json`；
  // 过滤掉 tgz 名、大小汇总等非文件行。行尾 \r 防御 Windows CRLF 使 `(.+)$` 失配。
  cachedListing = `${result.stdout}\n${result.stderr}`
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.match(/^npm notice\s+[\d.]+\s*[kKmMgG]?\s*[bB]?\s+(.+)$/)?.[1]?.trim() ?? "")
    .filter(entry => entry.length > 0 && !entry.endsWith(".tgz"));
  return cachedListing;
}

function coveredByListing(rel: string, listing: string[]): boolean {
  if (listing.includes(rel)) return true;
  // 候选是目录：清单里有它内部的文件（files 含该目录）即覆盖。
  if (listing.some(entry => entry.startsWith(rel + "/"))) return true;
  // 候选是文件：清单里有它的某个祖先目录被整体包含（pack 清单总是展开为文件，
  // 此分支防御未来 npm 输出目录形态）。
  return listing.some(entry => rel.startsWith(entry + "/"));
}

describe("npm 发布内容守护（npm pack --dry-run 真实清单）", () => {
  it("第 1 层：人工 REQUIRED 清单全部在包内（防白名单误删既有条目）", () => {
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

  it("第 2 层：源码扫描到的包内相对路径读取全部在包内（新增运行时文件不再依赖人工登记）", () => {
    const candidates = scanPackageRelativePaths();
    expect(candidates.size, "扫描结果为空：扫描器失效，请检查 join/字面量模式是否仍匹配代码风格").toBeGreaterThan(0);

    // 金丝雀：事故文件必须始终被扫描器捕获——防扫描器随代码风格漂移而静默失效。
    expect(candidates.has("config/agents/catalog-template.json"),
      "扫描器未捕获事故文件 config/agents/catalog-template.json——join 模式失配，请修复扫描器").toBe(true);

    const exempt = new Set(EXEMPT_DATA_SIDE);
    const listing = packListing();
    const report: string[] = [];
    for (const [rel, wheres] of [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (exempt.has(rel)) continue;
      if (!coveredByListing(rel, listing)) {
        report.push(`${rel}\n    引用处: ${[...new Set(wheres)].join(" | ")}`);
      }
    }
    expect(
      report,
      `源码在运行时按包内路径读取、但 npm 包里没有的资源（把对应条目加入 package.json files；` +
      `若其实是 ~/.deepaa 数据侧文件，登记进 EXEMPT_DATA_SIDE）：\n${report.join("\n")}`
    ).toEqual([]);
  });
});
