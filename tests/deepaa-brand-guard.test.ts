import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * 防止开源发布时把旧产品标识带回源码、脚本、文档或测试。
 * GitHub 远程地址和当前工作目录是切换方案明确允许保留的两类例外。
 */
describe("Deepaa 品牌残留守卫", () => {
  test("跟踪文件只允许保留 GitHub 地址与当前工作目录中的旧仓库名", () => {
    const legacyKebab = ["llm", "inspector"].join("-");
    const legacySnake = ["llm", "inspector"].join("_");
    const legacySpaced = ["LLM", "Inspector"].join(" ");
    const legacyCompact = ["LLM", "Inspector"].join("");
    const legacyHeader = ["LLM", "Inspector"].join("-");
    const trackedFiles = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {encoding: "buffer"},
    )
      .toString("utf8")
      .split("\0")
      .filter(file => Boolean(file) && existsSync(file) && !file.startsWith("data/defaults/"));
    const allowed = [
      "https://github.com/AIAgentAndy/" + legacyKebab + ".git",
      "https://github.com/AIAgentAndy/" + legacyKebab + "#readme",
      "https://github.com/AIAgentAndy/" + legacyKebab + "/issues",
      "/Users/andy/Documents/UGit/AIAgentAndy/" + legacyKebab,
      // 双链路观测（2026-09-15）：zcode 本地数据中历史网关 provider 标记是真实
      // 存量值（排重常量 llm-inspector-gateway），必须逐字声明，属于数据事实非品牌残留。
      [legacyKebab, "-gateway"].join(""),
    ];
    const pattern = new RegExp(
      legacyKebab + "|" + legacySnake + "|" + legacySpaced + "|" + legacyCompact + "|" + legacyHeader,
      "iu",
    );
    const violations: string[] = [];
    for (const file of trackedFiles) {
      const content = readFileSync(file, "utf8");
      let remaining = content;
      for (const exception of allowed) remaining = remaining.split(exception).join("");
      if (pattern.test(remaining)) {
        violations.push(file + ": " + (remaining.match(pattern)?.[0] ?? "legacy-brand"));
      }
    }
    expect(violations).toEqual([]);
  });
});
