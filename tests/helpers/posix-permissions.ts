import {expect} from "vitest";

/**
 * Windows 的 fs.stat().mode 是合成值：可写文件恒 0o666、只读 0o444，表达不了
 * 0600/0700 这类 POSIX 权限位（Windows 的等价隔离依赖用户目录 ACL）。
 * 权限位断言只在 POSIX 平台执行，避免 CI 的 Windows 矩阵必然失败。
 */
export function expectPosixFileMode(mode: number | undefined, expected: number): void {
  if (process.platform === "win32") return;
  expect(mode).toBe(expected);
}
