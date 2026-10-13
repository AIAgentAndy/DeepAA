/**
 * 运行时平台判定（构建器不可折叠的唯一入口）。
 *
 * 背景（2026-10-13 事故）：Next Turbopack 生产构建会把 `process.platform` 的
 * 比较按「构建机」平台做编译期常数折叠并消除另一平台分支；实测连
 * `os.platform()` 的调用也会被同样折叠（产物留下 "TURBOPACK unreachable"
 * 死分支标记）。1.1.3 在 mac 构建，Windows 用户的 execPath 兜底与 cmd.exe
 * 启动分支被整体删除（spawn EFTYPE / 桌面启动静默失败）。
 *
 * 修复口径：平台真值只允许经本模块读取——Function 构造器是构建器无法
 * 静态求值的不透明边界；业务代码一律调用 isWindowsRuntime()/isMacRuntime()，
 * 任何位置不得直接比较平台常量（tests/package-smoke.test.ts 源码扫描 +
 * 产物函数级窗口断言双重锁定）。
 */

export type RuntimePlatform = NodeJS.Platform;

const readPlatform = new Function("return process.platform") as () => NodeJS.Platform;

/** 当前运行平台真值（构建期不可求值；仅本模块允许触碰 process.platform）。 */
export function runtimePlatform(): RuntimePlatform {
  return readPlatform();
}

export function isWindowsRuntime(): boolean {
  return runtimePlatform() === "win32";
}

export function isMacRuntime(): boolean {
  return runtimePlatform() === "darwin";
}
