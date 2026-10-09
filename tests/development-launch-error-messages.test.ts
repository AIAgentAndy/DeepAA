import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {describe, expect, test} from "vitest";

/**
 * 启动链错误文案完整性守护（2026-10-06）：development-launch 目录内抛出的全部
 * 稳定错误码（`new Error("CODE")`）都必须在 security.ts 的 userMessage 映射表里
 * 有面向用户的中文文案；新增错误码必须同步补文案，杜绝「操作失败：RAW_CODE」
 * 直出给用户。
 */
describe("development launch 错误文案完整性", () => {
  test("启动链全部稳定错误码都有中文文案", () => {
    const securitySource = readFileSync("src/lib/development-launch/security.ts", "utf8");
    const blockStart = securitySource.indexOf("const messages");
    const blockEnd = securitySource.indexOf("return messages[code]");
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const mapped = new Set<string>();
    for (const match of securitySource.slice(blockStart, blockEnd).matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gmu)) {
      mapped.add(match[1]!);
    }

    const files = execFileSync("git", ["ls-files", "src/lib/development-launch"], {encoding: "utf8"})
      .split("\n")
      .filter(file => /\.ts$/u.test(file));
    expect(files.length).toBeGreaterThan(5);
    const thrown = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(/new Error\("([A-Z][A-Z0-9_]{2,60})"\)/gu)) {
        thrown.add(match[1]!);
      }
    }
    expect(thrown.size).toBeGreaterThan(20);
    const unmapped = [...thrown].filter(code => !mapped.has(code));
    expect(unmapped).toEqual([]);
  });
});
